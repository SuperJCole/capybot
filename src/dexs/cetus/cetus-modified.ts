import SDK, {
  Percentage,
  SdkOptions,
  adjustForSlippage,
  d,
} from "@cetusprotocol/cetus-sui-clmm-sdk/dist";
import {
  JsonRpcProvider,
  SUI_CLOCK_OBJECT_ID,
  TransactionBlock,
  mainnetConnection,
} from "@mysten/sui.js";
import BN from "bn.js";
import util from "util";
import { getCoinInfo } from "../../coins/coins";
import { keypair } from "../../index";
import { getTotalBalanceByCoinType } from "../../utils/utils";
import { CetusParams } from "../dexsParams";
import { Pool } from "../pool";
import { mainnet } from "./mainnet_config";
import { logger } from "../../logger";

/**
 * Helpers: BCS decode / normalization utilities
 */
function decodeBcsBase64(b64: string) {
  const bytes = Buffer.from(b64, "base64");
  const hex = bytes.toString("hex");

  // Try UTF-8
  let utf8: string | undefined;
  try {
    const s = bytes.toString("utf8");
    // crude printable check (if mostly printable consider it text)
    if (/^[\x09\x0A\x0D\x20-\x7E]*$/.test(s) && s.length > 0) utf8 = s;
  } catch (e) {
    utf8 = undefined;
  }

  // Big-endian integer
  let beBigInt = BigInt(0);
  for (let i = 0; i < bytes.length; i++) {
    beBigInt = (beBigInt << BigInt(8)) + BigInt(bytes[i]);
  }

  // Little-endian integer
  let leBigInt = BigInt(0);
  for (let i = bytes.length - 1; i >= 0; i--) {
    leBigInt = (leBigInt << BigInt(8)) + BigInt(bytes[i]);
  }

  const toNumberIfSafe = (v: bigint) =>
    v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;

  return {
    hex,
    utf8,
    beBigInt,
    leBigInt,
    beNumber: toNumberIfSafe(beBigInt),
    leNumber: toNumberIfSafe(leBigInt),
    rawBytes: bytes,
  };
}

/**
 * Walk object and normalize bcsEncoding fields (best-effort).
 * Adds _bcsDecoded and _bcsAsNumber hints next to the original key.
 */
function normalizeBcsInObject(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) {
    return obj.map((x) => normalizeBcsInObject(x));
  }
  if (typeof obj === "object") {
    const out: any = Array.isArray(obj) ? [] : {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === "bcsEncoding" && typeof v === "string") {
        const decoded = decodeBcsBase64(v);
        out[k] = v;
        out["_bcsDecoded"] = decoded;
        // Prefer little-endian numeric (common) then big-endian
        out["_bcsAsNumber"] =
          typeof decoded.leNumber === "number" && !Number.isNaN(decoded.leNumber)
            ? decoded.leNumber
            : typeof decoded.beNumber === "number" && !Number.isNaN(decoded.beNumber)
            ? decoded.beNumber
            : undefined;
      } else {
        out[k] = normalizeBcsInObject(v);
      }
    }
    return out;
  }
  return obj;
}

/**
 * Utility to stringify safely (preserve existing helper behaviour).
 */
function getCircularReplacer() {
  const seen = new WeakSet();
  return function (_key: any, value: any) {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
    }
    if (typeof value === "bigint") return value.toString();
    return value;
  };
}

function safeStringify(obj: any): string {
  try {
    return JSON.stringify(obj, getCircularReplacer(), 2);
  } catch {
    try {
      return util.inspect(obj, { depth: 3 });
    } catch {
      return String(obj);
    }
  }
}

/**
 * End helpers
 */

function buildSdkOptions(): SdkOptions {
  return mainnet;
}

export class CetusPool extends Pool<CetusParams> {
  private sdk: SDK;
  private provider: JsonRpcProvider;
  private senderAddress: string;

  constructor(address: string, coinTypeA: string, coinTypeB: string) {
    super(address, coinTypeA, coinTypeB);
    this.sdk = new SDK(buildSdkOptions());
    this.sdk.senderAddress = keypair.getPublicKey().toSuiAddress();

    this.provider = new JsonRpcProvider(mainnetConnection);
    this.senderAddress = keypair.getPublicKey().toSuiAddress();
  }

  async createSwapTransaction(
    transactionBlock: TransactionBlock,
    params: CetusParams
  ): Promise<TransactionBlock> {
    const totalBalance = await getTotalBalanceByCoinType(
      this.provider,
      this.senderAddress,
      params.a2b ? this.coinTypeA : this.coinTypeB
    );

    logger.info(
      `TotalBalance for CoinType (${params.a2b ? this.coinTypeA : this.coinTypeB}), is: ${totalBalance} and amountIn is: ${params.amountIn}`
    );

    if (params.amountIn > 0 && Number(totalBalance) >= params.amountIn) {
      const txb = await this.createCetusTransactionBlockWithSDK(params);

      if (!txb) {
        logger.warn(
          { pool: this.uri, params },
          "Cetus: preswap returned no usable quote — skipping this order (safe)"
        );
        return transactionBlock;
      }

      let target = "";
      let args: string[] = [];
      let typeArguments: string[] = [];
      let coins: (string | null)[] = [];

      let packageName: string = "";
      let moduleName: string = "";
      let functionName: string = "";

      const transactions = (txb.blockData.transactions as any[]) || [];

      const moveCall = transactions.find((obj: any) => {
        return obj && obj.kind === "MoveCall" && obj.target;
      }) as any | undefined;

      if (moveCall?.kind === "MoveCall" && moveCall?.target) {
        target = moveCall.target;
        [packageName, moduleName, functionName] = target.split("::");
      }

      const inputs: any[] = (txb.blockData.inputs as any[]) || [];

      args = [];

      inputs.forEach((input: any) => {
        if (
          input &&
          input.kind === "Input" &&
          (input.type === "object" || input.type === "pure")
        ) {
          args.push(input.value);
        }
      });

      if (moveCall?.kind === "MoveCall" && moveCall?.typeArguments)
        typeArguments = moveCall.typeArguments;

      let makeMoveVec = transactions.find((obj: any) => {
        return obj && obj.kind === "MakeMoveVec";
      }) as any | undefined;

      if (makeMoveVec?.kind === "MakeMoveVec" && Array.isArray(makeMoveVec?.objects)) {
        coins = makeMoveVec.objects
          .filter((obj: any) => obj.kind === "Input" && obj.value)
          .map((obj: any) => (obj.kind === "Input" && obj?.value ? obj.value : null));
      }

      args = args.filter((item) => !coins.includes(item));

      // Safety: if args length is less than expected, guard to avoid runtime errors
      const arg0 = args[0] ?? null;
      const arg1 = args[1] ?? null;
      const arg2 = args[2] ?? null;
      const arg3 = args[3] ?? null;
      const arg4 = args[4] ?? null;
      const arg5 = args[5] ?? null;

      transactionBlock.moveCall({
        target: `${packageName}::${moduleName}::${functionName}`,
        arguments: [
          arg0 ? transactionBlock.object(arg0) : transactionBlock.object("0x0"),
          arg1 ? transactionBlock.object(arg1) : transactionBlock.object("0x0"),
          transactionBlock.makeMoveVec({
            objects: coins.map((id) => transactionBlock.object(id ?? "0x0")),
          }),
          transactionBlock.pure(arg2),
          transactionBlock.pure(arg3),
          transactionBlock.pure(arg4),
          transactionBlock.pure(arg5),
          transactionBlock.object(SUI_CLOCK_OBJECT_ID),
        ],
        typeArguments,
      });

      return transactionBlock;
    }
    return transactionBlock;
  }

  async estimatePriceAndFee(): Promise<{
    price: number;
    fee: number;
  }> {
    const pool = await this.sdk.Pool.getPool(this.uri);

    const price = pool.current_sqrt_price ** 2 / 2 ** 128;
    const fee = pool.fee_rate * 10 ** -6;

    return {
      price,
      fee,
    };
  }

  /**
   * Build a Cetus transaction payload using the SDK.
   * Returns TransactionBlock on success, or null on preswap/normalization failure.
   */
  async createCetusTransactionBlockWithSDK(
    params: CetusParams
  ): Promise<TransactionBlock | null> {
    logger.info(
      `a2b: ${params.a2b}, amountIn: ${params.amountIn}, amountOut: ${params.amountOut}, byAmountIn: ${params.byAmountIn}, slippage: ${params.slippage}`
    );

    const coinAmount = new BN(params.amountIn);
    const byAmountIn = true;
    const slippage = Percentage.fromDecimal(d(5));

    try {
      const pool = await this.sdk.Pool.getPool(this.uri);
      const coinA = getCoinInfo(this.coinTypeA);
      const coinB = getCoinInfo(this.coinTypeB);

      // Try normal preswap call first
      let res: any = null;
      try {
        res = await this.sdk.Swap.preswap({
          a2b: params.a2b,
          amount: coinAmount.toString(),
          by_amount_in: byAmountIn,
          coinTypeA: this.coinTypeA,
          coinTypeB: this.coinTypeB,
          current_sqrt_price: pool.current_sqrt_price,
          decimalsA: coinA.decimals,
          decimalsB: coinB.decimals,
          pool: pool,
        });
      } catch (preswapErr: any) {
        // Normalization attempt: extract raw RPC result (devInspect) and synthesize a preswap-like object
        try {
          const raw = preswapErr?.result || preswapErr?.response || null;
          if (raw?.effects?.events && raw.effects.events.length > 0) {
            const ev = raw.effects.events[0] as any;
            const parsed = (ev.parsedJson ?? ev.parsed_json ?? ev.parsed) || null;

            if (parsed) {
              // Build normalized response from parsedJson
              const top = parsed;
              const data = parsed.data ?? parsed;
              const step0 = (data?.step_results && data.step_results[0]) ?? {};

              res = {
                poolAddress:
                  top.poolAddress ?? top.pool_address ?? pool.poolAddress,
                currentSqrtPrice:
                  top.currentSqrtPrice ??
                  top.current_sqrt_price ??
                  pool.current_sqrt_price,
                estimatedAmountIn:
                  top.estimatedAmountIn ??
                  top.estimated_amount_in ??
                  data.amount_in ??
                  top.amount ??
                  undefined,
                estimatedAmountOut:
                  top.estimatedAmountOut ??
                  top.estimated_amount_out ??
                  data.amount_out ??
                  step0.amount_out ??
                  undefined,
                estimatedFeeAmount:
                  top.estimatedFeeAmount ??
                  top.estimated_fee_amount ??
                  data.fee_amount ??
                  step0.fee_amount ??
                  undefined,
                amount: top.amount ?? data.amount ?? step0.amount_in ?? undefined,
                aToB:
                  top.aToB ??
                  top.a_to_b ??
                  data.aToB ??
                  data.a_to_b ??
                  params.a2b,
                byAmountIn:
                  top.byAmountIn ??
                  top.by_amount_in ??
                  data.byAmountIn ??
                  data.by_amount_in ??
                  byAmountIn,
                __raw_parsedJson: parsed,
              };
              logger.info(
                { preswapNormalizedFromEvent: res },
                "cetus:preswap-normalized"
              );
            } else if (ev.bcs || ev.bcsBase64 || ev.bcsEncoding) {
              // Best-effort: try decode base64 BCS payload as UTF-8 JSON if possible,
              // otherwise decode as integer(s) and provide normalized amount hints.
              try {
                // Prefer the actual bcs/base64 field; do NOT use bcsEncoding which is just the string "base64".
                const rawB64 =
                  typeof ev.bcs === "string"
                    ? ev.bcs
                    : typeof ev.bcsBase64 === "string"
                    ? ev.bcsBase64
                    : typeof ev._bcsBase64 === "string"
                    ? ev._bcsBase64
                    : null;

                if (rawB64) {
                  // First try utf8 JSON (existing behavior)
                  const decodedUtf8 = Buffer.from(rawB64, "base64").toString("utf8").trim();
                  try {
                    const maybe = JSON.parse(decodedUtf8);
                    const top = maybe;
                    const data = maybe.data ?? maybe;
                    const step0 = (data?.step_results && data.step_results[0]) ?? {};
                    res = {
                      poolAddress:
                        top.poolAddress ?? top.pool_address ?? pool.poolAddress,
                      currentSqrtPrice:
                        top.currentSqrtPrice ??
                        top.current_sqrt_price ??
                        pool.current_sqrt_price,
                      estimatedAmountIn:
                        top.estimatedAmountIn ??
                        top.estimated_amount_in ??
                        data.amount_in ??
                        top.amount ??
                        undefined,
                      estimatedAmountOut:
                        top.estimatedAmountOut ??
                        top.estimated_amount_out ??
                        data.amount_out ??
                        step0.amount_out ??
                        undefined,
                      estimatedFeeAmount:
                        top.estimatedFeeAmount ??
                        top.estimated_fee_amount ??
                        data.fee_amount ??
                        step0.fee_amount ??
                        undefined,
                      amount:
                        top.amount ?? data.amount ?? step0.amount_in ?? undefined,
                      aToB:
                        top.aToB ??
                        top.a_to_b ??
                        data.aToB ??
                        data.a_to_b ??
                        params.a2b,
                      byAmountIn:
                        top.byAmountIn ??
                        top.by_amount_in ??
                        data.byAmountIn ??
                        data.by_amount_in ??
                        byAmountIn,
                      __raw_bcs_json: maybe,
                    };
                    logger.info(
                      { preswapNormalizedFromBCSJson: res },
                      "cetus:preswap-normalized"
                    );
                  } catch (jsonErr) {
                    // Not JSON: fallback to binary BCS decoding
                    const decoded = decodeBcsBase64(rawB64);

                    // Heuristic: many BCS encoded numeric fields are little-endian unsigned integers.
                    // Rather than interpreting the entire blob as one integer, try extracting the
                    // first two u64 LE values (common layout for preswap responses).
                    let estIn: string | undefined = undefined;
                    let estOut: string | undefined = undefined;
                    try {
                      const buf = decoded.rawBytes;
                      if (buf && buf.length >= 16 && typeof (buf as any).readBigUInt64LE === "function") {
                        estIn = (buf as any).readBigUInt64LE(0).toString();
                        estOut = (buf as any).readBigUInt64LE(8).toString();
                      }
                    } catch (e) {
                      // ignore read errors
                    }

                    // Fall back to previous single-number heuristic if u64 extraction failed.
                    const leNumber = decoded.leNumber;
                    const beNumber = decoded.beNumber;

                    // Build a best-effort normalized response
                    res = {
                      poolAddress: pool.poolAddress,
                      currentSqrtPrice: pool.current_sqrt_price,
                      // If we successfully extracted two u64 values use them directly (strings to preserve big ints).
                      estimatedAmountIn: estIn ?? undefined,
                      estimatedAmountOut:
                        estOut ??
                        (typeof leNumber === "number" ? leNumber : typeof beNumber === "number" ? beNumber : undefined),
                      estimatedFeeAmount: undefined,
                      amount: estIn ?? (typeof leNumber === "number" ? leNumber : typeof beNumber === "number" ? beNumber : undefined),
                      aToB: params.a2b,
                      byAmountIn,
                      __raw_bcs_decoded: decoded,
                      __raw_bcs_base64: rawB64,
                    };
                    logger.info(
                      { preswapNormalizedFromBCSBinary: res },
                      "cetus:preswap-normalized"
                    );
                  }
                }
              } catch (b64Err) {
                logger.debug({ b64Err, ev }, "cetus:preswap-bcs-decode-exception");
              }
            }
          }
        } catch (normErr) {
          logger.error({ normErr, preswapErr }, "cetus:failed-to-normalize-preswap-error-result");
        }

        if (!res) {
          logger.error({ err: String(preswapErr), pool: this.uri, params }, "Cetus preswap threw and could not be normalized — skipping");
          if (process.env.CETUS_PROBE === "true") {
            logger.debug({ preswapErr: String(preswapErr), rawResult: preswapErr?.result }, "cetus:preswap-probe-error");
          }
          return null;
        }
      }

      // By here, res is either SDK response or normalized object from event/raw
      const toAmountRaw = byAmountIn ? res?.estimatedAmountOut : res?.estimatedAmountIn;
      if (toAmountRaw == null) {
        logger.warn(
          { pool: this.uri, preswapResponsePreview: safeStringify(res) },
          "Cetus: preswap returned an invalid quote (estimatedAmountOut/estimatedAmountIn missing) — skipping"
        );
        if (process.env.CETUS_PROBE === "true") {
          logger.info({ preswapResponsePreview: safeStringify(res), preswapResponseDeep: util.inspect(res, { depth: null }) }, "cetus:preswap-probe");
        }
        return null;
      }

      let toAmountBn: BN;
      try {
        toAmountBn = new BN(toAmountRaw.toString());
      } catch (bnErr) {
        logger.warn({ pool: this.uri, toAmountRaw }, "Cetus: preswap produced non-numeric estimated amount — skipping");
        return null;
      }

      const amountLimit = adjustForSlippage(new BN(toAmountBn), slippage, !byAmountIn);

      const transactionBlock: TransactionBlock =
        await this.sdk.Swap.createSwapTransactionPayload({
          pool_id: pool.poolAddress,
          coinTypeA: pool.coinTypeA,
          coinTypeB: pool.coinTypeB,
          a2b: params.a2b,
          by_amount_in: byAmountIn,
          amount: (res.amount ?? params.amountIn).toString(),
          amount_limit: amountLimit.toString(),
        });

      return transactionBlock;
    } catch (err) {
      logger.error({ err, pool: this.uri, params }, "Cetus: failed to build transaction block — skipping");
      return null;
    }
  }
}

export default CetusPool;

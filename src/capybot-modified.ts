import {
  JsonRpcProvider,
  Keypair,
  RawSigner,
  TransactionBlock,
  mainnetConnection,
} from "@mysten/sui.js";
import { setTimeout } from "timers/promises";
import { DataSource } from "./data_sources/data_source";
import { CetusPool } from "./dexs/cetus/cetus";
import { CetusParams, SuiswapParams, TurbosParams } from "./dexs/dexsParams";
import { Pool } from "./dexs/pool";
import { SuiswapPool } from "./dexs/suiswap/suiswap";
import { TurbosPool } from "./dexs/turbos/turbos";
import { logger } from "./logger";
import { Strategy } from "./strategies/strategy";

/**
 * Minimal safeDevInspect helper:
 * - Attempts provider.devInspectTransactionBlock(...) first (preserves normal SDK behavior).
 * - If that throws a schema/StructError (causing SDK validation to fail), falls back to a raw
 *   JSON-RPC call to sui_devInspectTransactionBlock, tries to serialize the TransactionBlock
 *   to base64 if needed, and normalizes fields that cause schema validation to fail
 *   (moves abortError -> _abortError_for_debug and events[].bcsEncoding -> _bcsEncoding_for_debug).
 *
 * Typed conservatively to avoid TypeScript complaints when accessing error properties.
 */
async function safeDevInspect(provider: JsonRpcProvider, args: any): Promise<any> {
  function isSchemaError(err: any) {
    return !!(
      err &&
      (err.name === "RPCValidationError" ||
        err?.cause?.name === "StructError" ||
        (err?.cause && typeof err.cause.failures === "function") ||
        /RPC Validation Error/i.test(String(err?.message ?? "")))
    );
  }

  try {
    // Try SDK call first (normal path)
    return await provider.devInspectTransactionBlock(args);
  } catch (err: any) {
    if (!isSchemaError(err)) throw err;

    // Determine endpoint URL from provider
    const url = (provider as any)?.connection?.fullnode ?? (provider as any)?.fullnode;
    if (!url) throw new Error("safeDevInspect: provider has no fullnode URL");

    let sender: string | undefined;
    let txBase64: string | undefined;

    // If args is an object with transactionBlock, attempt to serialize it
    if (args && typeof args === "object" && args.transactionBlock) {
      sender = args.sender ?? args.from ?? undefined;
      const tb = args.transactionBlock;
      if (typeof tb === "string") {
        txBase64 = tb;
      } else {
        try {
          if (typeof tb.build === "function") {
            const built = tb.build?.();
            if (built instanceof Uint8Array || Array.isArray(built)) {
              txBase64 = Buffer.from(built).toString("base64");
            }
          }
          if (!txBase64 && typeof tb.serialize === "function") {
            const s = tb.serialize();
            if (s instanceof Uint8Array || Array.isArray(s)) {
              txBase64 = Buffer.from(s).toString("base64");
            }
          }
          if (!txBase64 && typeof tb.toBytes === "function") {
            const t = tb.toBytes();
            if (t instanceof Uint8Array || Array.isArray(t)) {
              txBase64 = Buffer.from(t).toString("base64");
            }
          }
        } catch (e) {
          // ignore serialization errors and try other fallbacks below
        }
      }
    }

    // Handle positional args like [sender, txBase64] or [txBase64]
    if (!txBase64 && Array.isArray(args)) {
      if (args.length === 2 && typeof args[1] === "string") {
        sender = args[0];
        txBase64 = args[1];
      } else if (args.length >= 1 && typeof args[0] === "string") {
        txBase64 = args[0];
      }
    }

    if (!txBase64 && typeof args === "string") {
      txBase64 = args;
    }

    // If we still can't serialize, try to extract any raw RPC body from the error object
    if (!txBase64) {
      const possibleRaw = err?.response ?? err?.cause?.response ?? err?.raw ?? err?.data;
      if (possibleRaw) {
        let rawObj: any = possibleRaw;
        try {
          if (typeof possibleRaw === "string") rawObj = JSON.parse(possibleRaw);
        } catch (e) {
          // ignore parse error
        }
        const out = rawObj?.result ? rawObj.result : rawObj;
        try {
          if (out?.effects) {
            if (out.effects.abortError !== undefined) {
              out.effects._abortError_for_debug = out.effects.abortError;
              delete out.effects.abortError;
            }
            if (Array.isArray(out.effects.events)) {
              for (const ev of out.effects.events) {
                if (ev && ev.bcsEncoding !== undefined) {
                  ev._bcsEncoding_for_debug = ev.bcsEncoding;
                  delete ev.bcsEncoding;
                }
              }
            }
          }
        } catch (e) {
          // best-effort
        }
        return out;
      }
      // cannot fallback
      throw err;
    }

    const params = sender ? [sender, txBase64] : [txBase64];

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sui_devInspectTransactionBlock",
        params,
      }),
    });

    const raw = await res.json();
    const out = raw?.result ? raw.result : raw;

    try {
      if (out?.effects) {
        if (out.effects.abortError !== undefined) {
          out.effects._abortError_for_debug = out.effects.abortError;
          delete out.effects.abortError;
        }
        if (Array.isArray(out.effects.events)) {
          for (const ev of out.effects.events) {
            if (ev && ev.bcsEncoding !== undefined) {
              ev._bcsEncoding_for_debug = ev.bcsEncoding;
              delete ev.bcsEncoding;
            }
          }
        }
      }
    } catch (e) {
      // best-effort normalization
    }

    return out;
  }
}

/**
 * A simple trading bot which subscribes to a number of trading pools across different DEXs. The bot may use multiple
 * strategies to trade on these pools.
 */
export class Capybot {
  public dataSources: Record<string, DataSource> = {};
  public pools: Record<
    string,
    Pool<CetusParams | SuiswapParams | TurbosParams>
  > = {};
  public strategies: Record<string, Array<Strategy>> = {};
  private keypair: Keypair;
  private provider: JsonRpcProvider;
  private signer: RawSigner;

  constructor(keypair: Keypair) {
    this.keypair = keypair;
    this.provider = new JsonRpcProvider(mainnetConnection);
    this.signer = new RawSigner(this.keypair, this.provider);
  }

  async loop(duration: number, delay: number) {
    let startTime = new Date().getTime();

    let uniqueStrategies: Record<string, any> = {};
    for (const pool in this.strategies) {
      for (const strategy of this.strategies[pool]) {
        if (!uniqueStrategies.hasOwnProperty(strategy.uri)) {
          uniqueStrategies[strategy.uri] = strategy["parameters"];
        }
      }
    }
    logger.info({ strategies: uniqueStrategies }, "strategies");

    let transactionBlock: TransactionBlock = new TransactionBlock();
    while (new Date().getTime() - startTime < duration) {
      for (const uri in this.dataSources) {
        let dataSource = this.dataSources[uri];
        let data = await dataSource.getData();
        logger.info(
          {
            price: data,
          },
          "price"
        );

        // Push new data to all strategies subscribed to this data source
        for (const strategy of this.strategies[uri]) {
          // Get orders for this strategy.
          let tradeOrders = strategy.evaluate(data);

          // Create transactions for the suggested trades
          transactionBlock = new TransactionBlock();
          for (const order of tradeOrders) {
            logger.info({ strategy: strategy.uri, decision: order }, "order");
            let amountIn = Math.round(order.amountIn);
            let amountOut = Math.round(order.estimatedPrice * amountIn);
            const a2b: boolean = order.a2b;
            const byAmountIn: boolean = true;
            const slippage: number = 1; // TODO: Define this in a meaningful way. Perhaps by the strategies.

            try {
              if (this.pools[order.pool] instanceof CetusPool) {
                const tb = await this.pools[
                  order.pool
                ].createSwapTransaction(transactionBlock, {
                  a2b,
                  amountIn,
                  amountOut,
                  byAmountIn,
                  slippage,
                });
                if (tb) {
                  transactionBlock = tb;
                } else {
                  logger.warn(
                    { strategy: strategy.uri, pool: order.pool },
                    "Cetus returned no transaction block — skipping order"
                  );
                  continue;
                }
              } else if (this.pools[order.pool] instanceof SuiswapPool) {
                const tb = await this.pools[
                  order.pool
                ].createSwapTransaction(transactionBlock, {
                  a2b,
                  amountIn,
                });
                if (tb) {
                  transactionBlock = tb;
                } else {
                  logger.warn(
                    { strategy: strategy.uri, pool: order.pool },
                    "Suiswap returned no transaction block — skipping order"
                  );
                  continue;
                }
              } else if (this.pools[order.pool] instanceof TurbosPool) {
                const tb = await this.pools[
                  order.pool
                ].createSwapTransaction(transactionBlock, {
                  a2b,
                  amountIn,
                  amountSpecifiedIsInput: true,
                  slippage: 0,
                });
                if (tb) {
                  transactionBlock = tb;
                } else {
                  logger.warn(
                    { strategy: strategy.uri, pool: order.pool },
                    "Turbos returned no transaction block — skipping order"
                  );
                  continue;
                }
              }
            } catch (err) {
              // Log and skip this order only — do not crash the bot
              logger.error(
                { err, strategy: strategy.uri, pool: order.pool },
                "Swap preparation failed — skipping order"
              );
              continue;
            }
          }
          // Execute the transactions
          await this.executeTransactionBlock(transactionBlock, strategy);
        }
      }
      await setTimeout(delay);
    }
  }

  private async executeTransactionBlock(
    transactionBlock: TransactionBlock,
    strategy: Strategy
  ) {
    if (transactionBlock.blockData.transactions.length !== 0) {
      try {
        transactionBlock.setGasBudget(1500000000);
       // 1. Simulate first
let simulation: any;
try {
  simulation = await safeDevInspect(this.provider, {
    transactionBlock,
    sender: this.keypair.getPublicKey().toSuiAddress(),
  });
} catch (simErr) {
  logger.error(
    { simErr, strategy: strategy.uri },
    "Simulation failed — skipping execution."
  );
  return; // DO NOT broadcast
}

// Check if execution would fail
if (!simulation.effects || simulation.effects.status.error) {
  logger.error(
    { simulation, strategy: strategy.uri },
    "Simulation indicates failure — skipping transaction."
  );
  return; // DO NOT broadcast
}

// 2. Execute for real
let result = await this.signer.signAndExecuteTransactionBlock({
  transactionBlock,
  requestType: "WaitForLocalExecution",
  options: {
    showObjectChanges: true,
    showEffects: true,
  },
});
        logger.info({ strategy: strategy, transaction: result }, "transaction");
      } catch (e) {
        logger.error(e);
      }
    }
  }

  /** Add a strategy to this bot. The pools it subscribes to must have been added first. */
  addStrategy(strategy: Strategy) {
    for (const dataSource of strategy.subscribes_to()) {
      if (!this.dataSources.hasOwnProperty(dataSource)) {
        throw new Error(
          "Bot does not know the dataSource with address " + dataSource
        );
      }
      this.strategies[dataSource].push(strategy);
    }
  }

  /** Add a new price data source for this bot to use */
  addDataSource(dataSource: DataSource) {
    if (this.dataSources.hasOwnProperty(dataSource.uri)) {
      throw new Error(
        "Data source " + dataSource.uri + " has already been added."
      );
    }
    this.dataSources[dataSource.uri] = dataSource;
    this.strategies[dataSource.uri] = [];
  }

  /** Add a new pool for this bot to use for trading. */
  addPool(pool: Pool<CetusParams | SuiswapParams | TurbosParams>) {
    if (this.pools.hasOwnProperty(pool.uri)) {
      throw new Error("Pool " + pool.uri + " has already been added.");
    }
    this.pools[pool.uri] = pool;
    this.addDataSource(pool);
  }
}

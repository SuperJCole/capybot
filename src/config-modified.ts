// src/config.ts
import fs from "fs";
import path from "path";
import { Ed25519Keypair } from "@mysten/sui.js";

/**
 * Secure config loader:
 * Priority:
 *  1) process.env.ADMIN_PHRASE
 *  2) secure.json at path given by process.env.SECURE_CONFIG_PATH
 *  3) secure.json at DEFAULT_SECURE_PATH (only as last resort)
 *
 * Exports:
 *  - adminPhrase (string)
 *  - keypair (Ed25519Keypair)
 *
 * IMPORTANT: Do not commit secure.json. Add it to .gitignore.
 */

const DEFAULT_SECURE_PATH = path.resolve("C:/Math Fun/secure.json"); // change if you want a different default

interface SecureConfig {
  ADMIN_PHRASE: string;
  ADMIN_ADDRESS?: string;
  Live_Run?: string;
}

function readSecureJson(filePath: string): SecureConfig | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      ADMIN_PHRASE:
        typeof parsed.ADMIN_PHRASE === "string" ? parsed.ADMIN_PHRASE : "",
      ADMIN_ADDRESS:
        typeof parsed.ADMIN_ADDRESS === "string"
          ? parsed.ADMIN_ADDRESS
          : undefined,
      Live_Run:
        typeof parsed.Live_Run === "string" ? parsed.Live_Run : undefined,
    };
  } catch (e) {
    return null;
  }
}

function loadAdminPhrase(): string {
  // 1) env var override
  if (process.env.ADMIN_PHRASE && process.env.ADMIN_PHRASE.trim().length > 0) {
    return process.env.ADMIN_PHRASE;
  }

  // 2) secure file path from env var
  const securePath = process.env.SECURE_CONFIG_PATH
    ? path.resolve(process.env.SECURE_CONFIG_PATH)
    : DEFAULT_SECURE_PATH;

  const config = readSecureJson(securePath);
  if (config && config.ADMIN_PHRASE && config.ADMIN_PHRASE.trim().length > 0) {
    return config.ADMIN_PHRASE;
  }

  // 3) fail fast if nothing found
  throw new Error(
    `ADMIN_PHRASE not set. Provide process.env.ADMIN_PHRASE or set process.env.SECURE_CONFIG_PATH to a valid secure.json. Tried: ${securePath}`
  );
}

export const adminPhrase = loadAdminPhrase();
export const keypair = Ed25519Keypair.deriveKeypair(adminPhrase);

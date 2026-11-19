/**
 * Server configuration from environment variables, validated once at start.
 *
 * Rules:
 *  - Values are never printed. describeConfig() reports only which names are set.
 *  - A malformed value is a hard error at start (a typo must not quietly turn live
 *    trading on or raise the ticket cap).
 *  - LIVE_TRADING defaults to false: without an explicit "true" nothing is ever sent.
 *  - The live caps default to the active rules ("live" in src/rules/defaultRules.ts), so
 *    load the rules file before the config; MAX_LIVE_TICKET_USD, when set, wins.
 */
import type { Hex } from "viem";
import { ASTER_MAINNET_URL, validateBuilder, type BuilderConfig } from "../src/exchange/aster";
import { activeRules } from "../src/rules/rules";

/** The validated configuration. */
export interface ServerConfig {
  port: number;
  baseUrl: string;
  liveTrading: boolean;
  /** Largest ticket the server sends in live mode. Units: USD. */
  maxLiveTicketUsd: number;
  /** Symbols allowed in live mode. */
  liveSymbols: readonly string[];
  /** Present only when all three Aster credentials are set. */
  credentials: { user: Hex; signer: Hex; privateKey: Hex } | null;
  builder: BuilderConfig | null;
  /** One-way mode: send both exits with reduceOnly "true" (ASTER_EXIT_REDUCE_ONLY, default false: untested live). */
  reduceOnlyExits: boolean;
}

/** Thrown for any invalid environment value. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

/**
 * Read and validate the environment.
 * Why a function with the env passed in: tests give it a plain object, never the real environment.
 */
export function loadConfig(env: Record<string, string | undefined>): ServerConfig {
  const get = (k: string) => {
    const v = env[k];
    return v === undefined || v.trim() === "" ? undefined : v.trim();
  };

  const liveRaw = (get("LIVE_TRADING") ?? "false").toLowerCase();
  if (liveRaw !== "true" && liveRaw !== "false") throw new ConfigError('LIVE_TRADING must be "true" or "false"');
  const liveTrading = liveRaw === "true";

  const capRaw = get("MAX_LIVE_TICKET_USD") ?? String(activeRules().live.maxTicketUsd);
  const maxLiveTicketUsd = Number(capRaw);
  if (!Number.isFinite(maxLiveTicketUsd) || maxLiveTicketUsd <= 0) throw new ConfigError("MAX_LIVE_TICKET_USD must be a positive number");

  const baseUrl = get("ASTER_BASE_URL") ?? ASTER_MAINNET_URL;
  if (!/^https:\/\/[^\s/]+/.test(baseUrl)) throw new ConfigError("ASTER_BASE_URL must start with https://");

  const user = get("ASTER_USER");
  const signer = get("ASTER_SIGNER");
  const key = get("ASTER_SIGNER_PRIVATE_KEY");
  const credCount = [user, signer, key].filter(Boolean).length;
  let credentials: ServerConfig["credentials"] = null;
  if (credCount === 3) {
    if (!ADDRESS.test(user!)) throw new ConfigError("ASTER_USER must be 0x followed by 40 hex characters");
    if (!ADDRESS.test(signer!)) throw new ConfigError("ASTER_SIGNER must be 0x followed by 40 hex characters");
    if (!PRIVATE_KEY.test(key!)) throw new ConfigError("ASTER_SIGNER_PRIVATE_KEY must be 0x followed by 64 hex characters");
    credentials = { user: user as Hex, signer: signer as Hex, privateKey: key as Hex };
  } else if (credCount > 0) {
    throw new ConfigError("set all three of ASTER_USER, ASTER_SIGNER, ASTER_SIGNER_PRIVATE_KEY, or none");
  }
  if (liveTrading && !credentials) throw new ConfigError("LIVE_TRADING=true needs ASTER_USER, ASTER_SIGNER and ASTER_SIGNER_PRIVATE_KEY");

  const bAddr = get("ASTER_BUILDER_ADDRESS");
  const bRate = get("ASTER_BUILDER_FEE_RATE");
  let builder: BuilderConfig | null = null;
  if (bAddr || bRate) {
    if (!bAddr || !bRate) throw new ConfigError("set both ASTER_BUILDER_ADDRESS and ASTER_BUILDER_FEE_RATE, or neither");
    try {
      builder = validateBuilder({ address: bAddr, feeRate: bRate });
    } catch (e) {
      throw new ConfigError(`builder: ${(e as Error).message}`);
    }
  }

  const roRaw = (get("ASTER_EXIT_REDUCE_ONLY") ?? "false").toLowerCase();
  if (roRaw !== "true" && roRaw !== "false") throw new ConfigError('ASTER_EXIT_REDUCE_ONLY must be "true" or "false"');

  const portRaw = get("PORT") ?? "8787";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError("PORT must be an integer 1-65535");

  return { port, baseUrl, liveTrading, maxLiveTicketUsd, liveSymbols: [...activeRules().live.symbols], credentials, builder, reduceOnlyExits: roRaw === "true" };
}

/** One safe line about the config: names and modes only, never a value of a secret. */
export function describeConfig(c: ServerConfig): string {
  return [
    `mode=${c.liveTrading ? "LIVE" : "trial"}`,
    `maxLiveTicketUsd=${c.maxLiveTicketUsd}`,
    `baseUrl=${c.baseUrl}`,
    `credentials=${c.credentials ? "set" : "not set"}`,
    `builder=${c.builder ? "set" : "not set"}`,
    `reduceOnlyExits=${c.reduceOnlyExits}`,
  ].join(" ");
}

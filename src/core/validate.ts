/**
 * Validation of a Set request coming from a client (the card, an API caller).
 *
 * Why here and not in the server: the card and the server must agree on what a valid
 * Set is, and this has no dependencies, so both can import it.
 * Every field is checked against the allowed lists; anything else is rejected with a
 * message a person can read. Nothing is silently defaulted except tpMode (Deserved).
 */
import { ENTRY_MODES, LEVERAGES, TICKETS_USD, TP_MODES, type SetInput } from "./types";

/** Thrown for a malformed Set request. The server maps it to HTTP 400. */
export class InvalidSetInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSetInputError";
  }
}

/** A finite positive number from a number or numeric string, else NaN. */
function n(v: unknown): number {
  const x = typeof v === "string" && v.trim() !== "" ? Number(v) : typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(x) ? x : Number.NaN;
}

/**
 * Parse and check a raw request body into a SetInput.
 * Units: ticketUsd USD; leverage multiplier; band prices quote per base.
 */
export function parseSetInput(raw: unknown): SetInput {
  if (raw === null || typeof raw !== "object") throw new InvalidSetInputError("body must be a JSON object");
  const b = raw as Record<string, unknown>;
  const symbol = typeof b.symbol === "string" ? b.symbol.toUpperCase() : "";
  if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol)) throw new InvalidSetInputError("symbol must look like BTCUSDT");
  const side = b.side;
  if (side !== "buy" && side !== "sell") throw new InvalidSetInputError('side must be "buy" or "sell"');
  const ticketUsd = n(b.ticketUsd);
  if (!(TICKETS_USD as readonly number[]).includes(ticketUsd)) throw new InvalidSetInputError(`ticketUsd must be one of ${TICKETS_USD.join(", ")}`);
  const leverage = n(b.leverage);
  if (!(LEVERAGES as readonly number[]).includes(leverage)) throw new InvalidSetInputError(`leverage must be one of ${LEVERAGES.join(", ")}`);
  const tpMode = b.tpMode ?? "deserved"; // Deserved is the product default
  if (!(TP_MODES as readonly unknown[]).includes(tpMode)) throw new InvalidSetInputError(`tpMode must be one of ${TP_MODES.join(", ")}`);
  const entryMode = b.entryMode;
  if (!(ENTRY_MODES as readonly unknown[]).includes(entryMode)) throw new InvalidSetInputError(`entryMode must be one of ${ENTRY_MODES.join(", ")}`);

  const input: SetInput = {
    symbol,
    side,
    ticketUsd: ticketUsd as SetInput["ticketUsd"],
    leverage: leverage as SetInput["leverage"],
    tpMode: tpMode as SetInput["tpMode"],
    entryMode: entryMode as SetInput["entryMode"],
  };
  if (entryMode === "draw") {
    const d = (b.draw ?? {}) as Record<string, Record<string, unknown> | undefined>;
    const band = (x: Record<string, unknown> | undefined, name: string) => {
      const low = n(x?.low);
      const high = n(x?.high);
      if (!(low > 0) || !(high > 0)) throw new InvalidSetInputError(`draw.${name} needs positive low and high prices`);
      return { low: Math.min(low, high), high: Math.max(low, high) }; // accept a band painted upside down
    };
    input.draw = { inBand: band(d.inBand, "inBand"), outBand: band(d.outBand, "outBand") };
  }
  return input;
}

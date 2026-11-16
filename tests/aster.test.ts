/**
 * Aster client tests.
 *  - Signing: REAL. Signs with the V3 doc's published demo key and recovers the doc's demo signer.
 *  - Encoding: REAL against Python urllib.parse.urlencode output (captured once from python3).
 *  - Request shape: HYBRID. A fake fetch records the exact URL and body the client would send;
 *    the signature inside is then verified for real. No network.
 *  - exchangeInfo parsing: REAL against a trimmed capture of the live response.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AsterApiError,
  AsterClient,
  asterTypedData,
  createNonceSource,
  parseSymbolRules,
  privateKeySigner,
  pyUrlencode,
  recoverAsterSigner,
  validateBuilder,
} from "../src/exchange/aster";

// Public demo values printed in the Aster V3 doc ("for demonstration purposes only").
const DEMO_KEY = "0x4fd0a42218f3eae43a6ce26d22544e986139a01e5b34a62db53757ffca81bae1" as const;
const DEMO_SIGNER = "0x21cF8Ae13Bb72632562c6Fff438652Ba1a151bb0" as const;
const DEMO_USER = "0x63DD5aCC6b1aa0f563956C0e534DD30B6dcF7C4e" as const;

describe("EIP-712 signing", () => {
  it("the doc's demo key signs a message that recovers to the doc's demo signer", async () => {
    const msg = "symbol=ASTERUSDT&type=LIMIT&side=BUY&timeInForce=GTC&quantity=20&price=0.5&nonce=1748310859508867&user=0x63DD5aCC6b1aa0f563956C0e534DD30B6dcF7C4e&signer=0x21cF8Ae13Bb72632562c6Fff438652Ba1a151bb0";
    const s = privateKeySigner(DEMO_KEY);
    expect(s.address).toBe(DEMO_SIGNER);
    const sig = await s.sign(msg);
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/); // 65 bytes: r, s, v
    expect(await recoverAsterSigner(msg, sig)).toBe(DEMO_SIGNER);
  });
  it("a changed message does not recover to the signer (negative)", async () => {
    const s = privateKeySigner(DEMO_KEY);
    const sig = await s.sign("symbol=BTCUSDT&nonce=1");
    expect(await recoverAsterSigner("symbol=BTCUSDT&nonce=2", sig)).not.toBe(DEMO_SIGNER);
  });
  it("uses the doc's domain exactly", () => {
    const td = asterTypedData("x");
    expect(td.domain).toEqual({ name: "AsterSignTransaction", version: "1", chainId: 1666, verifyingContract: "0x0000000000000000000000000000000000000000" });
    expect(td.types.Message).toEqual([{ name: "msg", type: "string" }]);
    expect(td.primaryType).toBe("Message");
  });
});

describe("encoding and nonce", () => {
  it("matches Python urllib.parse.urlencode byte for byte", () => {
    const py = "symbol=BTCUSDT&subOrderList=%5B%7B%22a%22%3A%22b+c%22%2C%22p%22%3A%221.5%22%7D%5D&x=%21%27%28%29%2A~-_.&nonce=1748310859508867";
    expect(
      pyUrlencode([
        ["symbol", "BTCUSDT"],
        ["subOrderList", '[{"a":"b c","p":"1.5"}]'],
        ["x", "!'()*~-_."],
        ["nonce", "1748310859508867"],
      ]),
    ).toBe(py);
  });
  it("nonce is microseconds and strictly increasing even within one millisecond", () => {
    const next = createNonceSource(() => 1_748_310_859_508);
    const a = next();
    const b = next();
    expect(a).toBe("1748310859508000");
    expect(BigInt(b)).toBe(BigInt(a) + 1n);
  });
});

describe("signed request shape", () => {
  function fakeFetch(answer: unknown, status = 200) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const f = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(answer), { status });
    };
    return { f, calls };
  }

  it("POST order: business params, then nonce, user, signer, builder fields signed, signature appended", async () => {
    const { f, calls } = fakeFetch({ orderId: 1, status: "NEW" });
    const s = privateKeySigner(DEMO_KEY);
    const c = new AsterClient({
      fetch: f,
      auth: { user: DEMO_USER, signer: DEMO_SIGNER, sign: s.sign },
      builder: validateBuilder({ address: "0xecD0674915473B0F2D9061dc6a004f18E29a882E", feeRate: "0.0001" }),
      nonce: () => "1748310859508867",
    });
    await c.newOrder({ symbol: "BTCUSDT", side: "BUY", type: "LIMIT", timeInForce: "GTC", quantity: "0.023", price: "64000.1" });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://fapi.asterdex.com/fapi/v3/order");
    expect(call.init?.method).toBe("POST");
    const body = String(call.init?.body);
    const [msg, sig] = body.split("&signature=");
    expect(msg).toBe(
      "symbol=BTCUSDT&side=BUY&type=LIMIT&timeInForce=GTC&quantity=0.023&price=64000.1&builder=0xecD0674915473B0F2D9061dc6a004f18E29a882E&feeRate=0.0001&nonce=1748310859508867&user=0x63DD5aCC6b1aa0f563956C0e534DD30B6dcF7C4e&signer=0x21cF8Ae13Bb72632562c6Fff438652Ba1a151bb0",
    );
    expect(await recoverAsterSigner(msg!, sig as `0x${string}`)).toBe(DEMO_SIGNER);
  });

  it("GET signed call puts everything in the query string", async () => {
    const { f, calls } = fakeFetch([]);
    const s = privateKeySigner(DEMO_KEY);
    const c = new AsterClient({ fetch: f, auth: { user: DEMO_USER, signer: DEMO_SIGNER, sign: s.sign }, nonce: () => "5" });
    await c.openOrders("BTCUSDT");
    expect(calls[0]!.url).toMatch(/^https:\/\/fapi\.asterdex\.com\/fapi\/v3\/openOrders\?symbol=BTCUSDT&nonce=5&user=0x63DD.*&signer=0x21cF.*&signature=0x[0-9a-f]{130}$/);
    expect(calls[0]!.init?.body).toBeUndefined();
  });

  it("an HTTP 200 with a negative code is an error; -4046 on margin type is success", async () => {
    const s = privateKeySigner(DEMO_KEY);
    const auth = { user: DEMO_USER, signer: DEMO_SIGNER, sign: s.sign };
    const bad = new AsterClient({ fetch: fakeFetch({ code: -1022, msg: "Signature for this request is not valid." }).f, auth });
    await expect(bad.positionRisk("BTCUSDT")).rejects.toBeInstanceOf(AsterApiError);
    const noNeed = new AsterClient({ fetch: fakeFetch({ code: -4046, msg: "No need to change margin type." }, 400).f, auth });
    await expect(noNeed.ensureIsolated("BTCUSDT")).resolves.toBeUndefined();
    const strat = new AsterClient({ fetch: fakeFetch({ strategyId: 1, failureCode: -4142, failureReason: "would trigger" }).f, auth });
    const leg = { strategySubId: "1", securityType: "USDT_FUTURES" as const, symbol: "BTCUSDT", side: "BUY" as const, type: "MARKET" as const, quantity: "0.001" };
    await expect(strat.placeOto(leg, { ...leg, strategySubId: "2" })).rejects.toThrow(/would trigger/);
  });

  it("refuses a signed call without credentials", async () => {
    const c = new AsterClient({ fetch: fakeFetch({}).f });
    await expect(c.positionRisk()).rejects.toThrow(/needs user, signer/);
  });
});

describe("builder validation", () => {
  it("accepts Blackboard's address under the 0.001 ceiling", () => {
    expect(validateBuilder({ address: "0xecD0674915473B0F2D9061dc6a004f18E29a882E", feeRate: "0.001" }).feeRate).toBe("0.001");
  });
  it("rejects a fee above the ceiling, a zero fee, scientific notation and a bad address", () => {
    expect(() => validateBuilder({ address: "0xecD0674915473B0F2D9061dc6a004f18E29a882E", feeRate: "0.0011" })).toThrow();
    expect(() => validateBuilder({ address: "0xecD0674915473B0F2D9061dc6a004f18E29a882E", feeRate: "0" })).toThrow();
    expect(() => validateBuilder({ address: "0xecD0674915473B0F2D9061dc6a004f18E29a882E", feeRate: "1e-4" })).toThrow();
    expect(() => validateBuilder({ address: "0x123", feeRate: "0.0001" })).toThrow();
  });
});

describe("exchangeInfo parsing", () => {
  const info = JSON.parse(readFileSync(new URL("./fixtures/aster-exchangeInfo.json", import.meta.url), "utf8"));
  it("reads BTCUSDT and ETHUSDT rules from the real response", () => {
    expect(parseSymbolRules(info, "BTCUSDT")).toEqual({
      symbol: "BTCUSDT",
      tickSize: 0.1,
      stepSize: 0.001,
      minQty: 0.001,
      marketStepSize: 0.001,
      marketMinQty: 0.001,
      minNotionalUsd: 5,
    });
    expect(parseSymbolRules(info, "ETHUSDT").tickSize).toBe(0.01);
  });
  it("fails loudly on a missing symbol or filter (negative)", () => {
    expect(() => parseSymbolRules(info, "NOPEUSDT")).toThrow(/not found/);
    const broken = { symbols: [{ symbol: "BTCUSDT", status: "TRADING", filters: [] }] };
    expect(() => parseSymbolRules(broken, "BTCUSDT")).toThrow(/tickSize missing/);
    expect(() => parseSymbolRules({}, "BTCUSDT")).toThrow(/no symbols/);
  });
});

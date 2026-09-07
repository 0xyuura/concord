import { describe, expect, it } from "vitest";
import { CHAIN_ID, CHAIN_ID_HEX, formatGen, short } from "./wallet";

describe("short", () => {
  it("keeps the leading 0x and the last four, which is what people match on", () => {
    expect(short("0xfb332ad96268a9974d32f87daa335f553478a67d")).toBe("0xfb33...a67d");
  });
});

describe("formatGen", () => {
  // The balance drives a decision, not just a display: below the gas floor the
  // app stops offering the send button and offers the faucet instead. So an
  // amount that is small but real must never render as a flat zero.
  it("renders an exact zero as zero", () => {
    expect(formatGen(0)).toBe("0");
  });

  it("never rounds dust down to zero", () => {
    expect(formatGen(0.00001)).toBe("<0.0001");
    expect(formatGen(0.00009)).not.toBe("0");
  });

  it("keeps four places under one GEN and three under a thousand", () => {
    expect(formatGen(0.5)).toBe("0.5000");
    expect(formatGen(19.9512345)).toBe("19.951");
  });

  it("drops the decimals once the number is large enough not to need them", () => {
    expect(formatGen(1234.56)).toBe("1,235");
  });
});

describe("chain identity", () => {
  // The hex form is what wallet_switchEthereumChain takes and the decimal is
  // what eth_chainId comparisons use. A mismatch between them would silently
  // mean the app switches you to one network and then calls it wrong.
  it("agrees with itself in both bases", () => {
    expect(Number(CHAIN_ID_HEX)).toBe(CHAIN_ID);
    expect(CHAIN_ID).toBe(4221);
  });
});

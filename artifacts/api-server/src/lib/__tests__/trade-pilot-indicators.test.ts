import { describe, it, expect } from "vitest";
import { computeTpIndicators } from "../trade-pilot-indicators";

function candles(n: number, step: number) {
  return Array.from({ length: n }, (_, i) => {
    const close = 1000 + i * step + Math.sin(i / 3) * 2;
    return {
      date: new Date(Date.UTC(2026, 0, 1, i)).toISOString(),
      open: close - 0.5,
      high: close + 1,
      low: close - 1,
      close,
    };
  });
}

describe("computeTpIndicators", () => {
  it("returns the contract's 11 indicators in both groups", () => {
    const out = computeTpIndicators("XAU/USD", candles(300, 0.5));
    expect(out).toHaveLength(11);
    expect(out.filter((i) => i.group === "oscillator").map((i) => i.label)).toEqual([
      "RSI (14)",
      "MACD (12,26)",
      "Stochastic %K",
      "Bollinger (20,2)",
    ]);
    expect(out.filter((i) => i.group === "movingAverage").map((i) => i.label)).toEqual([
      "SMA 10",
      "SMA 20",
      "SMA 50",
      "SMA 100",
      "EMA 9",
      "EMA 21",
      "EMA 50",
    ]);
  });

  it("keeps every marker on the 0-100 gauge and every status in the enum", () => {
    for (const step of [-2, 0, 2]) {
      for (const i of computeTpIndicators("HSI", candles(300, step))) {
        expect(i.marker).toBeGreaterThanOrEqual(0);
        expect(i.marker).toBeLessThanOrEqual(100);
        expect(["buy", "sell", "neutral"]).toContain(i.status);
        expect(Number.isFinite(Number(i.value))).toBe(true);
      }
    }
  });

  it("reads an uptrend as buy on the moving averages", () => {
    const mas = computeTpIndicators("BRENT", candles(300, 1)).filter((i) => i.group === "movingAverage");
    expect(mas.every((i) => i.status === "buy" && i.marker > 50)).toBe(true);
  });

  it("returns [] without enough candles", () => {
    expect(computeTpIndicators("NIKKEI", candles(10, 1))).toEqual([]);
    expect(computeTpIndicators("NIKKEI", null)).toEqual([]);
  });
});

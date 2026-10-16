import { describe, it, expect } from "vitest";
import { mapAnalysis, historyStatus, toInternalTimeframe, parseInstrumentId } from "../trade-pilot";

const base = {
  id: 7,
  createdAt: new Date("2026-10-15T03:01:00Z"),
  validUntil: new Date("2099-01-01T00:00:00Z"),
  instrument: "XAU/USD",
  timeframe: "1h",
  marketCondition: "volatile",
  marketContext: null,
  opportunity: "opp",
  uncertaintyNotes: null,
  risk: "risk",
  tradingBias: "neutral",
  techBuyCount: 1,
  techSellCount: 2,
  marketSnapshot: null,
  outcomeStatus: "pending",
  outcomeResolvedAt: null,
} as unknown as Parameters<typeof mapAnalysis>[0];

const side = (entryZone: string) => ({ entryZone, stopLoss: "4152", takeProfit1: "4,192.50", takeProfit2: "4212", riskRewardRatio: "1:2", rationale: "" });

describe("trade-pilot mapping", () => {
  it("takes the midpoint of a price range", () => {
    const a = mapAnalysis({ ...base, tradePlan: { preferredSide: "buy", buy: side("4155 – 4160"), sell: side("4140") } }, "real");
    expect(a.buyLevels.entry).toBe("4157.50");
    expect(a.buyLevels.takeProfitOne).toBe("4192.50");
    expect(a.direction).toBe("bullish");
  });

  it("ignores stray digits in free-text levels (the 1 in 'H1')", () => {
    const a = mapAnalysis(
      { ...base, tradePlan: { preferredSide: "wait", buy: side("4160"), sell: side("di bawah 4150 setelah breakdown H1") } },
      "demo",
    );
    expect(a.sellLevels.entry).toBe("4150");
    expect(a.direction).toBe("neutral");
  });

  it("returns empty strings when there is no trade plan", () => {
    const a = mapAnalysis({ ...base, tradePlan: null }, "demo");
    expect(a.buyLevels.entry).toBe("");
    expect(a.marketSentiment).toBe("bearish");
  });

  it("maps outcome status and never reports a lapsed pending row as valid", () => {
    expect(historyStatus({ outcomeStatus: "tp2_hit", validUntil: new Date() })).toBe("take_profit_2");
    expect(historyStatus({ outcomeStatus: "sl_hit", validUntil: new Date() })).toBe("stop_loss");
    expect(historyStatus({ outcomeStatus: "invalidated", validUntil: new Date() })).toBe("invalid");
    expect(historyStatus({ outcomeStatus: "pending", validUntil: new Date(Date.now() - 1000) })).toBe("expired");
    expect(historyStatus({ outcomeStatus: "pending", validUntil: new Date(Date.now() + 60000) })).toBe("still_valid");
  });

  it("validates contract inputs", () => {
    expect(toInternalTimeframe("60")).toBe("1h");
    expect(toInternalTimeframe("M")).toBeNull();
    expect(parseInstrumentId("hang-seng")).toBe("hang-seng");
    expect(parseInstrumentId("toString")).toBeNull();
  });
});

// P1/P2 parts of the TradePilot client-area API: instruments (#12),
// fundamental news (#9) and price alerts (#10).
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "./db";
import { priceAlerts } from "@workspace/db/schema";
import { getRelevantNews } from "./news";
import { isHighImpactNews } from "./watchlist-alerts";
import { armAlertsForAnalysis, cancelAlertsForAnalysis } from "./price-alerts";
import { TP_INSTRUMENTS, type TpInstrumentId } from "./trade-pilot";

// ---- instruments (#12) -------------------------------------------------

const ALL_TIMEFRAMES = ["1", "5", "15", "60", "240", "D", "W"];

// Margin per lot is NOT known to this backend (an open question in the
// requirement doc), so it is reported as null instead of guessed. Lot sizes
// are the contract's: micro 0.01 / mini 0.10 / regular 1.00.
const contractSpecs = () => ({
  micro: { lot: "0.01", margin: null },
  mini: { lot: "0.10", margin: null },
  regular: { lot: "1.00", margin: null },
});

export function listInstruments() {
  const defs: Array<{ id: TpInstrumentId; quoteSymbols: string[]; tradingViewSymbol: string }> = [
    { id: "gold", quoteSymbols: ["XUL10_BBJ"], tradingViewSymbol: "OANDA:XAUUSD" },
    { id: "brent", quoteSymbols: ["BCO10_BBJ"], tradingViewSymbol: "BLACKBULL:BRENT" },
    { id: "hang-seng", quoteSymbols: ["HKK50_BBJ"], tradingViewSymbol: "VANTAGE:HK50" },
    { id: "nikkei", quoteSymbols: ["JPK50_BBJ"], tradingViewSymbol: "SPREADEX:NIKKEI" },
  ];
  return defs.map((d) => ({
    id: d.id,
    label: TP_INSTRUMENTS[d.id],
    quoteSymbols: d.quoteSymbols,
    tradingViewSymbol: d.tradingViewSymbol,
    timeframes: ALL_TIMEFRAMES,
    contractSpecs: contractSpecs(),
  }));
}

// ---- fundamental news (#9) --------------------------------------------

type NewsList = Awaited<ReturnType<typeof getRelevantNews>>;
const newsCache = new Map<string, { at: number; items: NewsList }>();
const NEWS_TTL_MS = 5 * 60 * 1000;

export async function fundamentalNews(instrumentId: TpInstrumentId, preferredLang?: "id" | "en") {
  const instrument = TP_INSTRUMENTS[instrumentId];
  let hit = newsCache.get(instrument);
  if (!hit || Date.now() - hit.at > NEWS_TTL_MS) {
    hit = { at: Date.now(), items: await getRelevantNews(instrument, 8) };
    newsCache.set(instrument, hit);
  }
  const items = hit.items.map((n) => ({
    id: n.id,
    title: n.title,
    source: n.source,
    url: n.url,
    publishedAt: n.publishedAt,
    // Keyword heuristic only: the upstream feeds carry no impact rating.
    ...(isHighImpactNews(n) ? { impact: "high" as const } : {}),
    language: n.source === "Newsmaker.id" ? ("id" as const) : ("en" as const),
  }));
  if (preferredLang) items.sort((a, b) => Number(b.language === preferredLang) - Number(a.language === preferredLang));
  return items;
}

// ---- price alerts (#10) ------------------------------------------------

const LEVEL_TO_CONTRACT = {
  entry: "entry",
  sl: "stopLoss",
  tp1: "takeProfitOne",
  tp2: "takeProfitTwo",
} as const;
export type TpAlertLevel = (typeof LEVEL_TO_CONTRACT)[keyof typeof LEVEL_TO_CONTRACT];
export const TP_ALERT_LEVELS: readonly TpAlertLevel[] = Object.values(LEVEL_TO_CONTRACT);

export async function alertStatus(analysisId: number) {
  const rows = await db.select().from(priceAlerts).where(eq(priceAlerts.analysisId, analysisId));
  const levels = rows.map((r) => ({
    level: LEVEL_TO_CONTRACT[r.level],
    price: r.levelPrice,
    status: r.triggeredAt ? ("triggered" as const) : r.cancelledAt ? ("cancelled" as const) : ("pending" as const),
  }));
  return { enabled: levels.some((l) => l.status === "pending"), levels };
}

/**
 * Arms the alerts of the analysis' preferred side, then cancels any level the
 * caller did not ask for. Delivery is NOT handled here: the existing watcher
 * only pushes to Web Push/FCM subscribers, which client-area users do not
 * have, so for them the outcome is read back as `triggered` status. Which
 * channel notifies them is an open product question in the requirement doc.
 * `armed` is 0 when the plan is "wait" or there is no live price.
 */
export async function setAlerts(analysisId: number, enabled: boolean, levels: readonly TpAlertLevel[]) {
  if (!enabled) {
    await cancelAlertsForAnalysis(analysisId);
    return { ...(await alertStatus(analysisId)), armed: 0 };
  }
  const armed = await armAlertsForAnalysis(analysisId);
  if (armed > 0 && levels.length < TP_ALERT_LEVELS.length) {
    const unwanted = (Object.entries(LEVEL_TO_CONTRACT) as Array<["entry" | "sl" | "tp1" | "tp2", TpAlertLevel]>)
      .filter(([, contract]) => !levels.includes(contract))
      .map(([internal]) => internal);
    await db
      .update(priceAlerts)
      .set({ cancelledAt: new Date() })
      .where(
        and(
          eq(priceAlerts.analysisId, analysisId),
          inArray(priceAlerts.level, unwanted),
          isNull(priceAlerts.triggeredAt),
          isNull(priceAlerts.cancelledAt),
        ),
      );
  }
  return { ...(await alertStatus(analysisId)), armed };
}

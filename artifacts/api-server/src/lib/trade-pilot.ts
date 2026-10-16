// Domain helpers for the TradePilot client-area API (/v1/trade-pilot).
// The route file stays thin; provisioning, credit periods and the mapping
// between our analyses rows and the contract in "Requirement API — TradePilot"
// live here.
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "./db";
import { analyses, creditBalances, creditLedger, users, type TradeSideShape } from "@workspace/db/schema";
import { applyCreditLedgerEntry, CREDIT_BALANCE_LOCK_NAMESPACE } from "./credits";
import { computeTpIndicators } from "./trade-pilot-indicators";

export type TpMode = "demo" | "real";
export const TP_MODES: readonly TpMode[] = ["demo", "real"];

export function parseTpMode(v: unknown): TpMode | null {
  return v === "demo" || v === "real" ? v : null;
}

// ---- instruments / timeframes ------------------------------------------

export const TP_INSTRUMENTS = {
  gold: "XAU/USD",
  brent: "BRENT",
  "hang-seng": "HSI",
  nikkei: "NIKKEI",
} as const;
export type TpInstrumentId = keyof typeof TP_INSTRUMENTS;

export function parseInstrumentId(v: unknown): TpInstrumentId | null {
  return typeof v === "string" && Object.hasOwn(TP_INSTRUMENTS, v) ? (v as TpInstrumentId) : null;
}

function instrumentIdFor(code: string): TpInstrumentId | null {
  const hit = Object.entries(TP_INSTRUMENTS).find(([, label]) => label === code);
  return hit ? (hit[0] as TpInstrumentId) : null;
}

// Contract timeframe -> internal timeframe. "M" (monthly) is in the contract
// but the analysis pipeline has no monthly candles, so it is intentionally
// absent and rejected as invalid_request.
const TF_TO_INTERNAL: Record<string, string> = {
  "1": "1m",
  "5": "5m",
  "15": "15m",
  "60": "1h",
  "240": "4h",
  D: "1D",
  W: "1W",
};
const TF_FROM_INTERNAL: Record<string, string> = Object.fromEntries(
  Object.entries(TF_TO_INTERNAL).map(([k, v]) => [v, k]),
);

export function toInternalTimeframe(v: unknown): string | null {
  return typeof v === "string" && Object.hasOwn(TF_TO_INTERNAL, v) ? TF_TO_INTERNAL[v] : null;
}
export const TP_INTERNAL_TIMEFRAMES = Object.values(TF_TO_INTERNAL);

// ---- provisioning ------------------------------------------------------

export interface TpUser {
  localUserId: number;
  externalId: string;
  mode: TpMode;
  isNew: boolean;
}

/**
 * Atomic, idempotent upsert of the local user row for (externalId, mode).
 * Two parallel first requests insert one row (unique index) and the loser
 * simply reads it back. No PII: the email column is a non-routable
 * placeholder derived from the opaque id.
 */
export async function provisionUser(externalId: string, mode: TpMode): Promise<TpUser> {
  const inserted = await db
    .insert(users)
    .values({
      email: `${externalId.toLowerCase()}.${mode}@tp.invalid`,
      displayName: "TradePilot user",
      externalId,
      accountMode: mode,
      role: "user",
      selectedMode: "pro",
    })
    .onConflictDoNothing({ target: [users.externalId, users.accountMode] })
    .returning({ id: users.id });

  let id = inserted[0]?.id;
  const isNew = id !== undefined;
  if (id === undefined) {
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.externalId, externalId), eq(users.accountMode, mode)))
      .limit(1);
    if (!row) throw new Error("tp user provisioning failed");
    id = row.id;
  }
  await ensureCreditPeriod(id, mode);
  return { localUserId: id, externalId, mode, isNew };
}

// ---- credits -----------------------------------------------------------

function allowanceFor(mode: TpMode): number {
  const raw = process.env[mode === "demo" ? "TRADE_PILOT_ALLOWANCE_DEMO" : "TRADE_PILOT_ALLOWANCE_REAL"];
  const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
  if (Number.isFinite(n) && n >= 0) return n;
  return mode === "demo" ? 5 : 50;
}

function periodKey(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function nextResetAt(d = new Date()): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
}

/**
 * Monthly allowance: once per UTC month, top the balance UP to the allowance
 * (never down, never accumulating). The ledger row (unique per source+event)
 * is the once-per-period guard, so concurrent calls cannot double-grant.
 */
export async function ensureCreditPeriod(userId: number, mode: TpMode): Promise<void> {
  const allowance = allowanceFor(mode);
  const eventId = `period:${periodKey()}`;
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${CREDIT_BALANCE_LOCK_NAMESPACE}::int, ${userId}::int)`);
    const [done] = await tx
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(and(eq(creditLedger.userId, userId), eq(creditLedger.source, "tp_period"), eq(creditLedger.sourceEventId, eventId)))
      .limit(1);
    if (done) return;
    const [bal] = await tx
      .select({ balance: creditBalances.balance })
      .from(creditBalances)
      .where(eq(creditBalances.userId, userId))
      .limit(1);
    const delta = Math.max(0, allowance - (bal?.balance ?? 0));
    await applyCreditLedgerEntry(tx, { userId, amount: delta, source: "tp_period", sourceEventId: eventId });
  });
}

export interface TpCredit {
  mode: TpMode;
  allowance: number;
  consumed: number;
  remaining: number;
  resetsAt: string;
  source: "api";
}

export async function getCredit(userId: number, mode: TpMode): Promise<TpCredit> {
  await ensureCreditPeriod(userId, mode);
  const [bal] = await db
    .select({ balance: creditBalances.balance })
    .from(creditBalances)
    .where(eq(creditBalances.userId, userId))
    .limit(1);
  const allowance = allowanceFor(mode);
  const remaining = Math.max(0, bal?.balance ?? 0);
  return {
    mode,
    allowance,
    consumed: Math.max(0, allowance - remaining),
    remaining,
    resetsAt: nextResetAt(),
    source: "api",
  };
}

// ---- analysis mapping --------------------------------------------------

type AnalysisRow = typeof analyses.$inferSelect;

const DISCLAIMER = {
  id: "Hasil analisis ini bukan ajakan untuk bertransaksi dan bukan nasihat investasi. Keputusan dan risiko sepenuhnya ada pada Anda.",
  en: "This analysis is not an invitation to trade and is not investment advice. Decisions and risk are entirely yours.",
} as const;

function numbersIn(text: string): string[] {
  const nums = (text.match(/\d[\d.,]*/g) ?? [])
    .map((n) => n.replace(/,/g, "").replace(/[.]+$/, ""))
    .filter((n) => Number.isFinite(Number(n)));
  // The AI writes free text ("di bawah 4150 setelah breakdown H1"), so stray
  // digits like the 1 in "H1" must not count as price levels: keep only
  // numbers within an order of magnitude of the largest one.
  const max = Math.max(0, ...nums.map(Number));
  return nums.filter((n) => Number(n) >= max * 0.1);
}

function level(raw: string | undefined): string {
  if (!raw) return "";
  const nums = numbersIn(raw);
  if (nums.length === 0) return "";
  if (nums.length === 1) return nums[0];
  const lo = Number(nums[0]);
  const hi = Number(nums[1]);
  const decimals = Math.max(...nums.slice(0, 2).map((n) => (n.split(".")[1] ?? "").length), 2);
  return ((lo + hi) / 2).toFixed(decimals);
}

function levels(side: TradeSideShape | null | undefined) {
  return {
    entry: level(side?.entryZone),
    stopLoss: level(side?.stopLoss),
    takeProfitOne: level(side?.takeProfit1),
    takeProfitTwo: level(side?.takeProfit2),
  };
}

export type TpHistoryStatus = "still_valid" | "expired" | "stop_loss" | "take_profit_1" | "take_profit_2" | "invalid";

export function historyStatus(row: Pick<AnalysisRow, "outcomeStatus" | "validUntil">): TpHistoryStatus {
  switch (row.outcomeStatus) {
    case "tp1_hit": return "take_profit_1";
    case "tp2_hit": return "take_profit_2";
    case "sl_hit": return "stop_loss";
    case "invalidated": return "invalid";
    case "expired": return "expired";
    default:
      // The background resolver may lag a tick behind; never show a lapsed
      // recommendation as still valid.
      return row.validUntil.getTime() < Date.now() ? "expired" : "still_valid";
  }
}

export function mapHistoryItem(row: AnalysisRow, mode: TpMode) {
  return {
    id: String(row.id),
    createdAt: row.createdAt.toISOString(),
    mode,
    instrumentLabel: row.instrument,
    timeframeLabel: row.timeframe,
    status: historyStatus(row),
    ...(row.outcomeResolvedAt ? { resolvedAt: row.outcomeResolvedAt.toISOString() } : {}),
    source: "api" as const,
  };
}

export function mapAnalysis(row: AnalysisRow, mode: TpMode) {
  const plan = row.tradePlan;
  const direction = plan?.preferredSide === "buy" ? "bullish" : plan?.preferredSide === "sell" ? "bearish" : "neutral";
  const bias = (row.tradingBias ?? "").toLowerCase();
  const marketSentiment: "bullish" | "bearish" =
    direction !== "neutral"
      ? direction
      : bias.includes("bull") || bias === "buy"
        ? "bullish"
        : bias.includes("bear") || bias === "sell"
          ? "bearish"
          : (row.techBuyCount ?? 0) > (row.techSellCount ?? 0)
            ? "bullish"
            : "bearish";

  const snap = row.marketSnapshot;
  const lastCandle = snap?.candles?.at(-1);
  const dataSnapshot =
    snap && snap.priceAtAnalysis != null
      ? {
          price: String(snap.priceAtAnalysis),
          candleCount: snap.candles?.length ?? 0,
          asOf: new Date(lastCandle?.date ?? snap.capturedAt).toISOString(),
        }
      : undefined;

  return {
    id: String(row.id),
    analyzedAt: row.createdAt.toISOString(),
    mode,
    instrumentId: instrumentIdFor(row.instrument) ?? row.instrument,
    instrumentLabel: row.instrument,
    timeframe: TF_FROM_INTERNAL[row.timeframe] ?? row.timeframe,
    timeframeLabel: row.timeframe,
    direction,
    marketSentiment,
    buyLevels: levels(plan?.buy),
    sellLevels: levels(plan?.sell),
    validUntil: row.validUntil.toISOString(),
    ...(dataSnapshot ? { dataSnapshot } : {}),
    indicators: computeTpIndicators(row.instrument, snap?.candles),
    marketContext: {
      title: row.marketCondition,
      description: row.marketContext ?? row.opportunity ?? "",
      note: row.uncertaintyNotes ?? row.risk ?? "",
    },
    disclaimer: DISCLAIMER,
    source: "api" as const,
  };
}

// ---- queries -----------------------------------------------------------

export async function latestAnalysis(userId: number) {
  const [row] = await db.select().from(analyses).where(eq(analyses.userId, userId)).orderBy(desc(analyses.id)).limit(1);
  return row ?? null;
}

export async function analysisForUser(userId: number, id: number) {
  const [row] = await db
    .select()
    .from(analyses)
    .where(and(eq(analyses.id, id), eq(analyses.userId, userId)))
    .limit(1);
  return row ?? null;
}

const STATUS_TO_OUTCOME: Record<TpHistoryStatus, string[]> = {
  still_valid: ["pending"],
  expired: ["expired", "pending"],
  stop_loss: ["sl_hit"],
  take_profit_1: ["tp1_hit"],
  take_profit_2: ["tp2_hit"],
  invalid: ["invalidated"],
};

export async function listHistory(
  userId: number,
  opts: { limit: number; cursor?: number; instrument?: string; timeframe?: string; status?: TpHistoryStatus },
) {
  const conds = [eq(analyses.userId, userId)];
  if (opts.cursor !== undefined) conds.push(lt(analyses.id, opts.cursor));
  if (opts.instrument) conds.push(eq(analyses.instrument, opts.instrument));
  if (opts.timeframe) conds.push(eq(analyses.timeframe, opts.timeframe));
  if (opts.status) {
    conds.push(inArray(analyses.outcomeStatus, STATUS_TO_OUTCOME[opts.status] as AnalysisRow["outcomeStatus"][]));
  }
  const rows = await db
    .select()
    .from(analyses)
    .where(and(...conds))
    .orderBy(desc(analyses.id))
    .limit(opts.limit + 1);
  let items = rows.slice(0, opts.limit);
  // "pending" rows split into still_valid / expired by validUntil; apply the
  // computed status filter exactly (the SQL above is the coarse pre-filter).
  if (opts.status === "still_valid" || opts.status === "expired") {
    items = items.filter((r) => historyStatus(r) === opts.status);
  }
  const nextCursor = rows.length > opts.limit ? String(rows[opts.limit - 1].id) : null;
  return { items, nextCursor };
}

// ---- performance -------------------------------------------------------

/** Minimum decided (TP1+TP2+SL) analyses before a rate is published. */
export const TP_MIN_DECIDED = 10;

export async function timeframePerformance() {
  const rows = await db
    .select({
      timeframe: analyses.timeframe,
      status: analyses.outcomeStatus,
      validPending: sql<number>`count(*) filter (where ${analyses.validUntil} >= now())::int`,
      n: sql<number>`count(*)::int`,
    })
    .from(analyses)
    .where(inArray(analyses.instrument, Object.values(TP_INSTRUMENTS)))
    .groupBy(analyses.timeframe, analyses.outcomeStatus);

  return TP_INTERNAL_TIMEFRAMES.map((tf) => {
    const mine = rows.filter((r) => r.timeframe === tf);
    const get = (s: string) => mine.filter((r) => r.status === s).reduce((a, r) => a + r.n, 0);
    const pending = mine.filter((r) => r.status === "pending");
    const stillValid = pending.reduce((a, r) => a + r.validPending, 0);
    const pendingLapsed = pending.reduce((a, r) => a + r.n - r.validPending, 0);
    const tp1 = get("tp1_hit");
    const tp2 = get("tp2_hit");
    const sl = get("sl_hit");
    const expired = get("expired") + pendingLapsed;
    const sample = mine.reduce((a, r) => a + r.n, 0);
    const decided = tp1 + tp2 + sl;
    const enough = decided >= TP_MIN_DECIDED;
    const resolved = sample - stillValid - get("invalidated");
    return {
      timeframe: tf,
      sample,
      stillValid,
      expired,
      stopLoss: sl,
      takeProfitOne: tp1,
      takeProfitTwo: tp2,
      winRate: enough ? Math.round(((tp1 + tp2) / decided) * 100) : null,
      completion: enough && resolved > 0 ? Math.round(((tp1 + tp2) / resolved) * 100) : null,
      minimumSamples: enough ? null : TP_MIN_DECIDED - decided,
    };
  });
}

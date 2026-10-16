// TradePilot client-area API — "Requirement API — TradePilot" (v1).
// Called server-to-server by the Next.js client-area, never by browsers.
// Mounted at /v1/trade-pilot (see app.ts), outside the legacy /api tree and
// its identity resolver: this router authenticates the *service* with
// TRADE_PILOT_API_KEY and takes the user from X-TradePilot-User.
import { Router, type NextFunction, type Request, type Response } from "express";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { db } from "../lib/db";
import { tpIdempotencyKeys, tpTradingPlans } from "@workspace/db/schema";
import type { AuthRequest } from "../middleware/auth";
import { createAnalysisHandler } from "./analyses";
import { logger } from "../lib/logger";
import {
  TP_INSTRUMENTS,
  type TpMode,
  type TpUser,
  analysisForUser,
  getCredit,
  historyStatus,
  latestAnalysis,
  listHistory,
  mapAnalysis,
  mapHistoryItem,
  parseInstrumentId,
  parseTpMode,
  provisionUser,
  timeframePerformance,
  toInternalTimeframe,
  type TpHistoryStatus,
} from "../lib/trade-pilot";
import { computeTpIndicators } from "../lib/trade-pilot-indicators";
import {
  TP_ALERT_LEVELS,
  fundamentalNews,
  listInstruments,
  setAlerts,
  alertStatus,
  type TpAlertLevel,
} from "../lib/trade-pilot-extras";

const router = Router();

interface TpRequest extends AuthRequest {
  requestId: string;
  tp?: TpUser;
}

class TpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAfter?: number,
  ) {
    super(message);
  }
}

function sendError(res: Response, requestId: string, e: TpError) {
  if (e.retryAfter) res.setHeader("Retry-After", String(e.retryAfter));
  res.status(e.status).json({ error: { code: e.code, message: e.message, requestId } });
}

// ---- service authentication -------------------------------------------

function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

const USER_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;

router.use((req: Request, res: Response, next: NextFunction) => {
  const r = req as TpRequest;
  r.requestId = `req_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  res.setHeader("X-Request-Id", r.requestId);
  res.setHeader("Cache-Control", "no-store");

  const key = process.env["TRADE_PILOT_API_KEY"];
  if (!key) {
    logger.error("[trade-pilot] TRADE_PILOT_API_KEY is not configured; refusing all requests");
    return sendError(res, r.requestId, new TpError(503, "upstream_unavailable", "Trade Pilot API is not configured."));
  }
  const given = (req.headers["authorization"] ?? "").toString().replace(/^Bearer\s+/i, "");
  if (!given || !safeEqual(given, key)) {
    return sendError(res, r.requestId, new TpError(401, "unauthorized", "Invalid service credentials."));
  }
  const userId = req.headers["x-tradepilot-user"];
  if (typeof userId !== "string" || !USER_ID_RE.test(userId)) {
    return sendError(res, r.requestId, new TpError(401, "unauthorized", "Missing or invalid X-TradePilot-User."));
  }
  next();
});

/** Resolve (and auto-provision) the local user for the request's mode. */
async function userFor(req: Request, mode: TpMode | null): Promise<TpUser> {
  if (!mode) throw new TpError(400, "invalid_request", "mode must be 'demo' or 'real'.");
  const r = req as TpRequest;
  const tp = await provisionUser(String(req.headers["x-tradepilot-user"]), mode);
  r.tp = tp;
  r.userId = tp.localUserId;
  r.userRole = "user";
  r.creditOnly = true;
  return tp;
}

// Express 5 forwards rejected promises to the error handler below.
const wrap =
  (fn: (req: TpRequest, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req as TpRequest, res).catch(next);

// ---- routes ------------------------------------------------------------

router.get(
  "/bootstrap",
  wrap(async (req, res) => {
    const raw = String(req.query["modes"] ?? "demo,real");
    const modes = [...new Set(raw.split(",").map((m) => m.trim()).filter(Boolean))];
    const parsed = modes.map(parseTpMode);
    if (modes.length === 0 || parsed.some((m) => m === null)) {
      throw new TpError(400, "invalid_request", "modes must be a comma-separated list of 'demo' and/or 'real'.");
    }

    const credits: Record<string, unknown> = {};
    const histories: Record<string, unknown> = {};
    const latestAnalyses: Record<string, unknown> = {};
    let isNewUser = false;
    for (const mode of parsed as TpMode[]) {
      const tp = await userFor(req, mode);
      isNewUser ||= tp.isNew;
      credits[mode] = await getCredit(tp.localUserId, mode);
      const { items } = await listHistory(tp.localUserId, { limit: 20 });
      histories[mode] = items.map((r) => mapHistoryItem(r, mode));
      const latest = await latestAnalysis(tp.localUserId);
      if (latest) latestAnalyses[mode] = mapAnalysis(latest, mode);
    }
    res.json({ isNewUser, credits, histories, latestAnalyses, timeframePerformance: await timeframePerformance() });
  }),
);

router.get(
  "/credits",
  wrap(async (req, res) => {
    const tp = await userFor(req, parseTpMode(req.query["mode"]));
    res.json(await getCredit(tp.localUserId, tp.mode));
  }),
);

router.get(
  "/analyses/latest",
  wrap(async (req, res) => {
    const tp = await userFor(req, parseTpMode(req.query["mode"]));
    const row = await latestAnalysis(tp.localUserId);
    if (!row) {
      res.status(204).end();
      return;
    }
    res.json(mapAnalysis(row, tp.mode));
  }),
);

/**
 * The mode is not part of these endpoints' contracts, so the analysis is looked
 * up under each of the caller's mode-rows. Anything not owned by this
 * X-TradePilot-User is a 404, never a 403, so ids cannot be probed.
 */
async function findOwned(req: TpRequest) {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) throw new TpError(404, "not_found", "Analysis not found.");
  for (const mode of ["demo", "real"] as const) {
    const tp = await userFor(req, mode);
    const row = await analysisForUser(tp.localUserId, id);
    if (row) return { tp, row, mode };
  }
  throw new TpError(404, "not_found", "Analysis not found.");
}

router.get(
  "/analyses/:id",
  wrap(async (req, res) => {
    const { row, mode } = await findOwned(req);
    res.json(mapAnalysis(row, mode));
  }),
);

router.get(
  "/analyses/:id/indicators",
  wrap(async (req, res) => {
    const { row } = await findOwned(req);
    res.json(computeTpIndicators(row.instrument, row.marketSnapshot?.candles));
  }),
);

router.get(
  "/histories",
  wrap(async (req, res) => {
    const tp = await userFor(req, parseTpMode(req.query["mode"]));
    const limitRaw = req.query["limit"] === undefined ? 20 : Number(req.query["limit"]);
    if (!Number.isInteger(limitRaw) || limitRaw < 1) throw new TpError(400, "invalid_request", "limit must be a positive integer.");
    const limit = Math.min(limitRaw, 100);

    let cursor: number | undefined;
    if (req.query["cursor"] !== undefined) {
      cursor = Number(req.query["cursor"]);
      if (!Number.isInteger(cursor) || cursor <= 0) throw new TpError(400, "invalid_request", "cursor is invalid.");
    }
    let instrument: string | undefined;
    if (req.query["instrumentId"] !== undefined) {
      const id = parseInstrumentId(req.query["instrumentId"]);
      if (!id) throw new TpError(400, "invalid_request", "instrumentId is invalid.");
      instrument = TP_INSTRUMENTS[id];
    }
    let timeframe: string | undefined;
    if (req.query["timeframe"] !== undefined) {
      const tf = toInternalTimeframe(req.query["timeframe"]);
      if (!tf) throw new TpError(400, "invalid_request", "timeframe is invalid.");
      timeframe = tf;
    }
    const statuses: TpHistoryStatus[] = ["still_valid", "expired", "stop_loss", "take_profit_1", "take_profit_2", "invalid"];
    let status: TpHistoryStatus | undefined;
    if (req.query["status"] !== undefined) {
      status = statuses.find((s) => s === req.query["status"]);
      if (!status) throw new TpError(400, "invalid_request", "status is invalid.");
    }

    const { items, nextCursor } = await listHistory(tp.localUserId, { limit, cursor, instrument, timeframe, status });
    res.json({ items: items.map((r) => mapHistoryItem(r, tp.mode)), nextCursor });
  }),
);

router.get(
  "/performance/timeframes",
  wrap(async (req, res) => {
    // mode is required by the contract; the statistic itself is the AI's
    // global track record (see the "Statistik performa" open question).
    await userFor(req, parseTpMode(req.query["mode"]));
    res.json(await timeframePerformance());
  }),
);

// ---- POST /analyses ----------------------------------------------------

const IDEMPOTENCY_KEY_RE = /^[a-zA-Z0-9-]{8,80}$/;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const ANALYSES_PER_MINUTE = 10;
const recentRuns = new Map<number, number[]>();

function underRateLimit(userId: number): { ok: true } | { ok: false; retryAfter: number } {
  const now = Date.now();
  const hits = (recentRuns.get(userId) ?? []).filter((t) => now - t < 60_000);
  if (hits.length >= ANALYSES_PER_MINUTE) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((60_000 - (now - hits[0])) / 1000)) };
  }
  hits.push(now);
  recentRuns.set(userId, hits);
  return { ok: true };
}

/** Runs the shared analysis pipeline and captures its response. */
async function runAnalysis(
  req: TpRequest,
  body: { instrument: string; timeframe: string },
): Promise<{ status: number; body: unknown }> {
  const captured = { status: 200, body: undefined as unknown };
  const fake = {
    status(code: number) {
      captured.status = code;
      return fake;
    },
    set() {
      return fake;
    },
    setHeader() {
      return fake;
    },
    json(b: unknown) {
      captured.body = b;
      return fake;
    },
  };
  const inner = Object.create(req) as AuthRequest;
  inner.body = { ...body, mode: "pro" };
  await createAnalysisHandler(inner, fake as unknown as Response);
  return captured;
}

router.post(
  "/analyses",
  wrap(async (req, res) => {
    const idemKey = req.headers["idempotency-key"];
    if (typeof idemKey !== "string" || !IDEMPOTENCY_KEY_RE.test(idemKey)) {
      throw new TpError(400, "invalid_request", "Idempotency-Key header is required (8-80 chars: letters, digits, '-').");
    }
    const instrumentId = parseInstrumentId(req.body?.instrumentId);
    const timeframe = toInternalTimeframe(req.body?.timeframe);
    const mode = parseTpMode(req.body?.mode);
    if (!instrumentId) throw new TpError(400, "invalid_request", "instrumentId is invalid.");
    if (!timeframe) throw new TpError(400, "invalid_request", "timeframe is invalid or unsupported.");
    const tp = await userFor(req, mode);

    const requestHash = createHash("sha256")
      .update(JSON.stringify([instrumentId, mode, req.body.timeframe]))
      .digest("hex");

    // Claim the key. A stale (>24h) record is dropped first so it can be reused.
    await db
      .delete(tpIdempotencyKeys)
      .where(
        and(
          eq(tpIdempotencyKeys.userId, tp.localUserId),
          eq(tpIdempotencyKeys.key, idemKey),
          lt(tpIdempotencyKeys.createdAt, new Date(Date.now() - IDEMPOTENCY_TTL_MS)),
        ),
      );
    const claimed = await db
      .insert(tpIdempotencyKeys)
      .values({ userId: tp.localUserId, key: idemKey, requestHash })
      .onConflictDoNothing()
      .returning({ id: tpIdempotencyKeys.id });

    if (claimed.length === 0) {
      const [prev] = await db
        .select()
        .from(tpIdempotencyKeys)
        .where(and(eq(tpIdempotencyKeys.userId, tp.localUserId), eq(tpIdempotencyKeys.key, idemKey)))
        .limit(1);
      if (!prev) throw new TpError(409, "idempotency_conflict", "Please retry.");
      if (prev.requestHash !== requestHash) {
        throw new TpError(409, "idempotency_conflict", "Idempotency-Key was already used with a different request.");
      }
      if (prev.response == null) {
        throw new TpError(429, "rate_limited", "This analysis is still being processed.", 5);
      }
      res.status(prev.statusCode ?? 201).json(prev.response);
      return;
    }
    const release = () =>
      db.delete(tpIdempotencyKeys).where(eq(tpIdempotencyKeys.id, claimed[0].id)).catch(() => undefined);

    try {
      const credit = await getCredit(tp.localUserId, tp.mode);
      if (credit.remaining <= 0) throw new TpError(402, "insufficient_credit", "Kredit tidak cukup.");

      const limit = underRateLimit(tp.localUserId);
      if (!limit.ok) throw new TpError(429, "rate_limited", "Too many analyses. Try again shortly.", limit.retryAfter);

      const out = await runAnalysis(req, { instrument: TP_INSTRUMENTS[instrumentId], timeframe });

      if (out.status !== 201) {
        const quotaScope = (out.body as { quota?: { scope?: string } } | undefined)?.quota?.scope;
        if (out.status === 429 && quotaScope === "day") throw new TpError(402, "insufficient_credit", "Kredit tidak cukup.");
        if (out.status === 429) throw new TpError(429, "rate_limited", "An analysis is already running for this user.", 5);
        if (out.status === 400) throw new TpError(400, "invalid_request", "Analysis request was rejected.");
        throw new TpError(502, "upstream_unavailable", "Trade Pilot analysis is temporarily unavailable.");
      }

      const row = out.body as Parameters<typeof mapAnalysis>[0];
      const response = {
        analysis: mapAnalysis(row, tp.mode),
        credit: await getCredit(tp.localUserId, tp.mode),
        history: mapHistoryItem(row, tp.mode),
      };
      await db
        .update(tpIdempotencyKeys)
        .set({ statusCode: 201, response })
        .where(eq(tpIdempotencyKeys.id, claimed[0].id));
      res.status(201).json(response);
    } catch (e) {
      // Nothing was charged on any failure path; free the key so the caller
      // can retry with the same one.
      await release();
      throw e;
    }
  }),
);

// ---- instruments, news, price alerts, trading plans ---------------------

router.get(
  "/instruments",
  wrap(async (_req, res) => {
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.json(listInstruments());
  }),
);

router.get(
  "/fundamental-news",
  wrap(async (req, res) => {
    const id = parseInstrumentId(req.query["instrumentId"]);
    if (!id) throw new TpError(400, "invalid_request", "instrumentId is invalid.");
    const lang = String(req.headers["accept-language"] ?? "").toLowerCase();
    const preferred = lang.startsWith("id") ? "id" : lang.startsWith("en") ? "en" : undefined;
    res.setHeader("Cache-Control", "private, max-age=300");
    res.json(await fundamentalNews(id, preferred));
  }),
);

router.put(
  "/analyses/:id/price-alert",
  wrap(async (req, res) => {
    const { enabled, levels, channels } = req.body ?? {};
    if (typeof enabled !== "boolean") throw new TpError(400, "invalid_request", "enabled must be a boolean.");
    let wanted: TpAlertLevel[] = [...TP_ALERT_LEVELS];
    if (levels !== undefined) {
      if (!Array.isArray(levels) || levels.length === 0 || levels.some((l) => !TP_ALERT_LEVELS.includes(l))) {
        throw new TpError(400, "invalid_request", "levels must be a non-empty list of entry, stopLoss, takeProfitOne, takeProfitTwo.");
      }
      wanted = [...new Set(levels as TpAlertLevel[])];
    }
    if (channels !== undefined && (!Array.isArray(channels) || channels.some((c) => c !== "push"))) {
      throw new TpError(400, "invalid_request", "Only the 'push' channel is supported.");
    }
    const { row } = await findOwned(req);
    res.json(await setAlerts(row.id, enabled, wanted));
  }),
);

router.get(
  "/analyses/:id/price-alert",
  wrap(async (req, res) => {
    const { row } = await findOwned(req);
    res.json(await alertStatus(row.id));
  }),
);

const MONEY_RE = /^\d{1,12}(\.\d{1,4})?$/;
const ACCOUNT_TYPES = ["micro", "mini", "regular"] as const;

router.post(
  "/trading-plans",
  wrap(async (req, res) => {
    const b = req.body ?? {};
    const tp = await userFor(req, parseTpMode(b.mode));
    const analysisId = Number(b.analysisId);
    if (!Number.isInteger(analysisId) || analysisId <= 0) throw new TpError(400, "invalid_request", "analysisId is invalid.");
    if (b.variant !== "buy" && b.variant !== "sell") throw new TpError(400, "invalid_request", "variant must be 'buy' or 'sell'.");
    if (!ACCOUNT_TYPES.includes(b.accountType)) throw new TpError(400, "invalid_request", "accountType must be micro, mini or regular.");
    for (const f of ["tradingCapital", "lossLimit"] as const) {
      if (typeof b[f] !== "string" || !MONEY_RE.test(b[f]) || Number(b[f]) <= 0) {
        throw new TpError(400, "invalid_request", `${f} must be a positive decimal string.`);
      }
    }
    if (typeof b.riskStyle !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(b.riskStyle)) {
      throw new TpError(400, "invalid_request", "riskStyle is invalid.");
    }
    if (!(await analysisForUser(tp.localUserId, analysisId))) throw new TpError(404, "not_found", "Analysis not found.");

    const values = {
      userId: tp.localUserId,
      analysisId,
      variant: b.variant as string,
      accountType: b.accountType as string,
      tradingCapital: b.tradingCapital as string,
      lossLimit: b.lossLimit as string,
      riskStyle: b.riskStyle as string,
    };
    const [saved] = await db
      .insert(tpTradingPlans)
      .values(values)
      .onConflictDoUpdate({
        target: [tpTradingPlans.userId, tpTradingPlans.analysisId, tpTradingPlans.variant],
        set: { ...values, updatedAt: new Date() },
      })
      .returning();
    res.status(201).json({
      id: String(saved.id),
      analysisId: String(saved.analysisId),
      variant: saved.variant,
      accountType: saved.accountType,
      tradingCapital: saved.tradingCapital,
      lossLimit: saved.lossLimit,
      riskStyle: saved.riskStyle,
      savedAt: saved.updatedAt.toISOString(),
    });
  }),
);

// ---- errors ------------------------------------------------------------

router.use((_req: Request, res: Response) => {
  sendError(res, String(res.getHeader("X-Request-Id") ?? ""), new TpError(404, "not_found", "Not found."));
});

router.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const requestId = (req as TpRequest).requestId ?? "";
  if (err instanceof TpError) return sendError(res, requestId, err);
  logger.error({ err, requestId, path: req.path }, "[trade-pilot] unhandled error");
  sendError(res, requestId, new TpError(500, "internal_error", "Trade Pilot analysis is temporarily unavailable."));
});

export default router;

import type { Request, Response, NextFunction } from "express";

type Bucket = { count: number; resetAt: number };

interface RateLimitOptions {
  windowMs: number;
  max: number;
  keyFn: (req: Request) => string;
  message?: string;
}

function clientIp(req: Request): string {
  // Relies on Express `trust proxy` being configured at the app level so
  // `req.ip` reflects the real client IP from the trusted proxy chain
  // instead of an arbitrary, attacker-controlled `x-forwarded-for` value.
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

// Rate limiters are a production safety net (DoS, credential stuffing,
// sign-up flooding). In local dev and the e2e harness they only get in
// the way — the e2e suite registers many users from a single IP in a
// short window and would otherwise hit a limiter and fail with
// 429. Bypass when NODE_ENV is explicitly
// "development" (set by the e2e test-server). The unit-test suite runs
// with NODE_ENV=test (vitest default) and continues to exercise the
// real limiter so the 429 / Retry-After contract stays covered.
function rateLimitDisabled(): boolean {
  return process.env["NODE_ENV"] === "development";
}

function buildLimiter(opts: RateLimitOptions) {
  const store = new Map<string, Bucket>();
  const middleware = (req: Request, res: Response, next: NextFunction) => {
    if (rateLimitDisabled()) return next();
    const key = opts.keyFn(req);
    const now = Date.now();
    const bucket = store.get(key);

    if (!bucket || bucket.resetAt <= now) {
      store.set(key, { count: 1, resetAt: now + opts.windowMs });
      return next();
    }

    if (bucket.count >= opts.max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({
        error:
          opts.message ??
          `Terlalu banyak percobaan. Coba lagi dalam ${retryAfter} detik. / Too many attempts. Try again in ${retryAfter}s.`,
      });
      return;
    }

    bucket.count += 1;
    next();
  };
  return Object.assign(middleware, { store });
}

// Per-user limiter for POST /api/push/test. Keyed off `req.userId`, so it
// must be mounted after `requireAuth`.
export const pushTestLimiter = buildLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyFn: (req) => {
    const id = (req as Request & { userId?: number }).userId;
    return typeof id === "number" ? `user-${id}` : clientIp(req);
  },
  message:
    "Terlalu banyak tes notifikasi. Coba lagi sebentar lagi. / Too many test notifications. Try again in a bit.",
});

// Per-user limiter for POST /api/native-push/test. Same budget as the Web
// Push test — enough for a QA pass, capped so the FCM send path can't be
// hammered. Mount after `requireAuth`.
export const nativePushTestLimiter = buildLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyFn: (req) => {
    const id = (req as Request & { userId?: number }).userId;
    return typeof id === "number" ? `user-${id}` : clientIp(req);
  },
  message:
    "Terlalu banyak tes notifikasi. Coba lagi sebentar lagi. / Too many test notifications. Try again in a bit.",
});

// Store-readiness (P2-B3): per-user limiter for native-push device
// register/unregister. A device re-registers on every app foreground in
// some client implementations, so the cap is generous — this only exists
// to blunt abuse (e.g. a compromised client hammering the endpoint), not
// to interfere with normal app usage.
export const nativePushRegisterLimiter = buildLimiter({
  windowMs: 60 * 60 * 1000,
  max: 30,
  keyFn: (req) => {
    const id = (req as Request & { userId?: number }).userId;
    return typeof id === "number" ? `user-${id}` : clientIp(req);
  },
  message:
    "Terlalu banyak pendaftaran perangkat. Coba lagi sebentar lagi. / Too many device registrations. Try again in a bit.",
});

// Per-user limiter for the manual trade-journal endpoints (task #161).
// Write path is gated tighter than read because journal entries land
// directly in the user's permanent record — accidental double-submit
// from a phone tap-storm shouldn't create dozens of duplicate rows.
export const journalWriteLimiter = buildLimiter({
  windowMs: 60 * 1000,
  max: 30,
  keyFn: (req) => {
    const id = (req as Request & { userId?: number }).userId;
    return typeof id === "number" ? `user-${id}` : clientIp(req);
  },
  message:
    "Terlalu banyak update jurnal. Coba lagi sebentar lagi. / Too many journal updates. Try again in a moment.",
});

// Looser limiter for journal list + stats reads — the journal page
// re-queries on filter changes and we don't want to throttle normal
// browsing, only outright scraping.
export const journalReadLimiter = buildLimiter({
  windowMs: 60 * 1000,
  max: 120,
  keyFn: (req) => {
    const id = (req as Request & { userId?: number }).userId;
    return typeof id === "number" ? `user-${id}` : clientIp(req);
  },
  message:
    "Terlalu banyak permintaan jurnal. Coba lagi sebentar lagi. / Too many journal requests. Try again in a moment.",
});

// Per-IP limiter for the public AI transparency dashboard (task #164).
// Endpoint is intentionally unauthenticated so anyone can audit the
// AI's track record, so the key is just the caller IP. Generous cap
// because the page polls between window tabs and refetches on locale
// changes; the goal is only to deflect obvious scraping.
export const performanceLimiter = buildLimiter({
  windowMs: 60 * 1000,
  max: 60,
  keyFn: (req) => clientIp(req),
  message:
    "Terlalu banyak permintaan. Coba lagi sebentar lagi. / Too many requests. Try again in a moment.",
});

// Public landing traffic can be bursty. This limiter protects the snapshot
// endpoint while its process-wide cache and in-flight dedupe protect the AI
// generation itself.
export const landingPreviewLimiter = buildLimiter({
  windowMs: 60 * 1000,
  max: 60,
  keyFn: (req) => clientIp(req),
  message:
    "Terlalu banyak permintaan preview. Coba lagi sebentar lagi. / Too many preview requests. Try again shortly.",
});

// Per-IP limiter for POST /events/track (page-view + key-action analytics
// pings, task: admin analytics dashboard). Endpoint is unauthenticated-
// tolerant like outbound-click telemetry, so it's reachable by anyone —
// this only exists to deflect obvious flooding, not to shape normal
// traffic (a real user's page views + a handful of actions stay well
// under this in any given minute).
export const trackEventLimiter = buildLimiter({
  windowMs: 60 * 1000,
  max: 60,
  keyFn: (req) => clientIp(req),
});

// POST /topups/doku/checkout — per-user (mounted after requireAuth). A
// legit top-up is an occasional action; this budget just guards against a
// buggy client retry-looping DOKU checkout-session creation.
export const dokuCheckoutLimiter = buildLimiter({
  windowMs: 15 * 60 * 1000,
  max: 15,
  keyFn: (req) => {
    const id = (req as Request & { userId?: number }).userId;
    return typeof id === "number" ? `user-${id}` : clientIp(req);
  },
  message: "Terlalu banyak percobaan top-up. Coba lagi dalam beberapa menit.",
});

// POST /topups/doku/notify — DOKU's own servers call this, not end users,
// so this is a generous ceiling meant only to absorb a burst/retry storm
// (DOKU retries up to 6x per its docs), not to rate-limit legitimate
// traffic. Per-IP since there's no authenticated user on this route.
export const dokuNotifyLimiter = buildLimiter({
  windowMs: 60 * 1000,
  max: 120,
  keyFn: (req) => clientIp(req),
});

setInterval(() => {
  const now = Date.now();
  for (const limiter of [
    pushTestLimiter,
    nativePushRegisterLimiter,
    journalWriteLimiter,
    journalReadLimiter,
    performanceLimiter,
    landingPreviewLimiter,
    trackEventLimiter,
    dokuCheckoutLimiter,
    dokuNotifyLimiter,
  ]) {
    for (const [k, b] of limiter.store) {
      if (b.resetAt <= now) limiter.store.delete(k);
    }
  }
}, 60_000).unref();

import { Request, Response, NextFunction } from "express";
import { db } from "../lib/db";
import { users } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

export interface AuthRequest extends Request {
  userId?: number;
  userRole?: string;
  /** Set by the TradePilot adapter: no free allowance, credits only. */
  creditOnly?: boolean;
}

export interface Identity {
  userId: number;
  role: string;
}

/**
 * THE single seam for "who is making this request".
 *
 * The built-in login system (password, OAuth, sessions) was removed; the
 * replacement will resolve the caller from the external user API (called
 * over WebSocket). When that lands, replace the body of this function and
 * nothing else — every route, `requireAuth`, `requireAdmin`,
 * `requireSuperAdmin` and `getAuthContext` below go through it, and routes
 * keep reading `req.userId` / `req.userRole` exactly as before.
 *
 * Interim behaviour (defaultResolveIdentity): every request is the one local user named by
 * DEFAULT_USER_ID (seeded by `scripts/seed-super-admin.ts`, role
 * super_admin unless DEFAULT_USER_ROLE overrides it). That means anyone who
 * can reach the API is that user, so index.ts refuses to boot with this stub
 * in production — see assertIdentityConfigured().
 */
async function defaultResolveIdentity(_req: Request): Promise<Identity | null> {
  const userId = Number(process.env["DEFAULT_USER_ID"] ?? 1);
  if (!Number.isInteger(userId) || userId <= 0) return null;

  const [user] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return null;

  return { userId, role: process.env["DEFAULT_USER_ROLE"] || user.role };
}

type IdentityResolver = (req: Request) => Promise<Identity | null>;
let activeResolver: IdentityResolver = defaultResolveIdentity;

/**
 * Swap the identity strategy. This is where the external user API (over
 * WebSocket) plugs in; the test setup uses it too. Not called anywhere in
 * the normal server path.
 */
export function setIdentityResolver(fn: IdentityResolver | null): void {
  activeResolver = fn ?? defaultResolveIdentity;
}

export function resolveIdentity(req: Request): Promise<Identity | null> {
  return activeResolver(req);
}

/**
 * The legacy /api tree (web + mobile app + admin panel) authenticates through
 * resolveIdentity, which is still the single-user stub. In production it is
 * therefore OFF unless explicitly enabled with LEGACY_API_ENABLED=true, so
 * only the service-keyed /v1/trade-pilot API is reachable. Dev/test always on.
 */
export function isLegacyApiEnabled(): boolean {
  return (
    process.env["NODE_ENV"] !== "production" ||
    process.env["LEGACY_API_ENABLED"] === "true"
  );
}

/**
 * Called once at boot. The interim identity grants super_admin to every
 * caller, so it must never run in production by accident.
 */
export function assertIdentityConfigured(): void {
  if (
    isLegacyApiEnabled() &&
    activeResolver === defaultResolveIdentity &&
    process.env["NODE_ENV"] === "production" &&
    process.env["ALLOW_DEFAULT_IDENTITY_IN_PRODUCTION"] !== "true"
  ) {
    throw new Error(
      "Identity is still the built-in default user (middleware/auth.ts resolveIdentity). " +
        "Wire the external user API before running in production, or set " +
        "ALLOW_DEFAULT_IDENTITY_IN_PRODUCTION=true to override knowingly.",
    );
  }
}

export async function requireAuth(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  const identity = await resolveIdentity(req);
  if (!identity) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  req.userId = identity.userId;
  req.userRole = identity.role;
  next();
}

/**
 * Non-throwing variant for routes that serve a mix of public and sensitive
 * content (e.g. GET /storage/objects/*, or fire-and-forget telemetry).
 * Returns null instead of writing a 401.
 */
export async function getAuthContext(
  req: Request,
): Promise<{ userId: number; role: string } | null> {
  try {
    return await resolveIdentity(req);
  } catch {
    return null;
  }
}

export async function requireAdmin(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  await requireAuth(req, res, async () => {
    if (req.userRole !== "admin" && req.userRole !== "super_admin") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  });
}

export async function requireSuperAdmin(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  await requireAuth(req, res, async () => {
    if (req.userRole !== "super_admin") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  });
}

import { eq } from "drizzle-orm";
import { db } from "./lib/db";
import { users } from "@workspace/db/schema";
import { setIdentityResolver } from "./middleware/auth";

// Tests authenticate with `Authorization: Bearer test-user-<id>`. The role is
// read from the users row, so tests seed users with the role they need.
setIdentityResolver(async (req) => {
  const m = /^Bearer test-user-(\d+)$/.exec(req.headers["authorization"] ?? "");
  if (!m) return null;
  const userId = Number(m[1]);
  const [user] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return user ? { userId, role: user.role } : null;
});

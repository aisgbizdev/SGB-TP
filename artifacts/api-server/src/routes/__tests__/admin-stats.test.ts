/**
 * GET /admin/stats — user segmentation counters. The login/logout counters
 * are kept in the response shape but are always 0 (auth_events was removed).
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { randomBytes } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";

import app from "../../app";
import { db } from "../../lib/db";
import { users } from "@workspace/db/schema";
import { applyCreditLedgerEntry } from "../../lib/credits";

const RUN_ID = randomBytes(4).toString("hex");
const EMAIL_PREFIX = `admin-stats-test-${RUN_ID}`;
const seededUserIds: number[] = [];

interface SeedUser {
  id: number;
  email: string;
  token: string;
}

async function createUser(role: "user" | "super_admin" = "user"): Promise<SeedUser> {
  const suffix = randomBytes(6).toString("hex");
  const email = `${EMAIL_PREFIX}-${suffix}@example.test`;
  const [row] = await db
    .insert(users)
    .values({
      email,
      displayName: `Admin Stats Test ${RUN_ID}`,
      role,
    })
    .returning({ id: users.id });

  const token = `test-user-${row.id}`;
  seededUserIds.push(row.id);
  return { id: row.id, email, token };
}

afterAll(async () => {
  if (seededUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, seededUserIds));
  }
  await db.delete(users).where(like(users.email, `${EMAIL_PREFIX}%`));
});

describe("GET /admin/stats — totalLoginsToday / totalLogoutsToday", () => {
  it("keeps the fields in the contract but reports 0 now that built-in auth events are gone", async () => {
    const superAdmin = await createUser("super_admin");
    const res = await request(app)
      .get("/api/admin/stats")
      .set("Authorization", `Bearer ${superAdmin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.totalLoginsToday).toBe(0);
    expect(res.body.totalLogoutsToday).toBe(0);
  });
});

describe("GET /admin/stats — totalFreeUsers / totalPaidUsers / totalDevUsers", () => {
  it("a plain user with no top-up and no quota override counts as free only", async () => {
    const superAdmin = await createUser("super_admin");
    const before = await request(app)
      .get("/api/admin/stats")
      .set("Authorization", `Bearer ${superAdmin.token}`);
    const freeBefore = before.body.totalFreeUsers as number;
    const paidBefore = before.body.totalPaidUsers as number;
    const devBefore = before.body.totalDevUsers as number;

    await createUser();

    const after = await request(app)
      .get("/api/admin/stats")
      .set("Authorization", `Bearer ${superAdmin.token}`);
    expect(after.body.totalFreeUsers).toBe(freeBefore + 1);
    expect(after.body.totalPaidUsers).toBe(paidBefore);
    expect(after.body.totalDevUsers).toBe(devBefore);
  });

  it("a user with a lifetime topup_approval ledger entry counts as paid, not free", async () => {
    const superAdmin = await createUser("super_admin");
    const before = await request(app)
      .get("/api/admin/stats")
      .set("Authorization", `Bearer ${superAdmin.token}`);
    const freeBefore = before.body.totalFreeUsers as number;
    const paidBefore = before.body.totalPaidUsers as number;

    const paidUser = await createUser();
    await db.transaction(async (tx) => {
      await applyCreditLedgerEntry(tx, {
        userId: paidUser.id,
        amount: 15,
        source: "topup_approval",
        sourceEventId: `topup:${RUN_ID}-${randomBytes(4).toString("hex")}`,
      });
    });

    const after = await request(app)
      .get("/api/admin/stats")
      .set("Authorization", `Bearer ${superAdmin.token}`);
    expect(after.body.totalPaidUsers).toBe(paidBefore + 1);
    expect(after.body.totalFreeUsers).toBe(freeBefore);
  });

  it("a user with an admin quota override counts as Development, even if they also topped up", async () => {
    const superAdmin = await createUser("super_admin");
    const before = await request(app)
      .get("/api/admin/stats")
      .set("Authorization", `Bearer ${superAdmin.token}`);
    const paidBefore = before.body.totalPaidUsers as number;
    const devBefore = before.body.totalDevUsers as number;

    const devUser = await createUser();
    await db.transaction(async (tx) => {
      await applyCreditLedgerEntry(tx, {
        userId: devUser.id,
        amount: 15,
        source: "topup_approval",
        sourceEventId: `topup:${RUN_ID}-${randomBytes(4).toString("hex")}`,
      });
    });
    await db.update(users).set({ customQuotaPerDay: 100 }).where(eq(users.id, devUser.id));

    const after = await request(app)
      .get("/api/admin/stats")
      .set("Authorization", `Bearer ${superAdmin.token}`);
    // Development wins over Top Up despite the real top-up on record.
    expect(after.body.totalDevUsers).toBe(devBefore + 1);
    expect(after.body.totalPaidUsers).toBe(paidBefore);
  });

  it("free + paid + dev always sums to totalUsers", async () => {
    const superAdmin = await createUser("super_admin");
    const res = await request(app)
      .get("/api/admin/stats")
      .set("Authorization", `Bearer ${superAdmin.token}`);
    const { totalFreeUsers, totalPaidUsers, totalDevUsers, totalUsers } = res.body;
    expect(totalFreeUsers + totalPaidUsers + totalDevUsers).toBe(totalUsers);
  });
});

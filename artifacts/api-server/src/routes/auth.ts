import { Router } from "express";
import { db } from "../lib/db";
import { users } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireAuth, AuthRequest } from "../middleware/auth";

// The built-in login system (register, password, OAuth, sessions, reauth,
// account deletion) was removed. Identity now comes from
// middleware/auth.ts `resolveIdentity`. Only the profile endpoints that
// other features still depend on remain here.
const router = Router();

function serializeUser(u: typeof users.$inferSelect) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    selectedMode: u.selectedMode,
    themePreference: u.themePreference,
    onboardingCompleted: u.onboardingCompleted,
    avatarUrl: u.avatarUrl,
    createdAt:
      u.createdAt instanceof Date ? u.createdAt.toISOString() : u.createdAt,
  };
}

router.get("/auth/me", requireAuth, async (req: AuthRequest, res) => {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, req.userId!))
    .limit(1);

  if (!user) {
    res.status(404).json({ error: "User tidak ditemukan" });
    return;
  }

  res.json(serializeUser(user));
});

const profileUpdateSchema = z
  .object({
    displayName: z
      .string()
      .min(1, "Nama wajib diisi")
      .max(80, "Nama terlalu panjang")
      .optional(),
    selectedMode: z
      .enum(["beginner", "pro"], {
        errorMap: () => ({ message: "Mode harus 'beginner' atau 'pro'" }),
      })
      .optional(),
    themePreference: z
      .enum(["light", "dark"], {
        errorMap: () => ({ message: "Tema harus 'light' atau 'dark'" }),
      })
      .optional(),
    onboardingCompleted: z
      .boolean({ invalid_type_error: "onboardingCompleted harus boolean" })
      .optional(),
    lang: z
      .enum(["en", "id"], {
        errorMap: () => ({ message: "Bahasa harus 'en' atau 'id'" }),
      })
      .optional(),
    // Only accept canonical object paths issued by our upload flow
    // (`/objects/uploads/<uuid>`) or `null` to clear, so a caller can't
    // point `avatarUrl` at an arbitrary object key.
    avatarUrl: z
      .string({ invalid_type_error: "Avatar tidak valid" })
      .regex(
        /^\/objects\/uploads\/[A-Za-z0-9_-]{8,64}$/,
        "URL avatar tidak valid"
      )
      .nullable()
      .optional(),
  })
  .strict();

router.patch("/auth/profile", requireAuth, async (req: AuthRequest, res) => {
  const parsed = profileUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    const first = parsed.error.errors[0];
    res.status(400).json({ error: first?.message ?? "Data profil tidak valid" });
    return;
  }
  const { displayName, selectedMode, themePreference, onboardingCompleted, lang, avatarUrl } =
    parsed.data;

  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  if (displayName !== undefined) updateData["displayName"] = displayName;
  if (selectedMode !== undefined) updateData["selectedMode"] = selectedMode;
  if (themePreference !== undefined) updateData["themePreference"] = themePreference;
  if (onboardingCompleted !== undefined) updateData["onboardingCompleted"] = onboardingCompleted;
  if (lang !== undefined) updateData["lang"] = lang;
  if (avatarUrl !== undefined) updateData["avatarUrl"] = avatarUrl;

  const [updated] = await db
    .update(users)
    .set(updateData)
    .where(eq(users.id, req.userId!))
    .returning();

  res.json(serializeUser(updated));
});

export default router;

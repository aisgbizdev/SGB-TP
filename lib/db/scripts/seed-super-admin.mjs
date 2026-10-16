// Idempotent: creates (or promotes) the super_admin user the interim identity
// resolves to. Run: pnpm --filter @workspace/db run seed:super-admin
// Env: DATABASE_URL (required), SUPER_ADMIN_EMAIL, SUPER_ADMIN_NAME.
// No password is stored — the built-in password system no longer exists.
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const email = (process.env.SUPER_ADMIN_EMAIL ?? "superadmin@tradepilot.local").toLowerCase();
const name = process.env.SUPER_ADMIN_NAME ?? "superadmin";

const pool = new pg.Pool({ connectionString: url });
try {
  const { rows } = await pool.query(
    `INSERT INTO users (email, display_name, role)
     VALUES ($1, $2, 'super_admin')
     ON CONFLICT (email) DO UPDATE SET role = 'super_admin', updated_at = now()
     RETURNING id, email, display_name, role`,
    [email, name],
  );
  const u = rows[0];
  console.log(`super_admin ready: id=${u.id} email=${u.email} name=${u.display_name}`);
  console.log(`Set DEFAULT_USER_ID=${u.id} for the API server.`);
} finally {
  await pool.end();
}

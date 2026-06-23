import bcrypt from "bcryptjs";
import { pool } from "./pool.js";

async function main() {
  const teams = ["РНК", "РПК", "Лідогенератори"];
  for (const name of teams) {
    await pool.query(
      `INSERT INTO teams (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
      [name]
    );
  }

  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? "admin@example.com";
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;
  if (!adminPassword) {
    throw new Error("Set SEED_ADMIN_PASSWORD env var before seeding.");
  }
  const passwordHash = await bcrypt.hash(adminPassword, 10);

  await pool.query(
    `INSERT INTO users (email, password_hash, role)
     VALUES ($1, $2, 'admin')
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [adminEmail, passwordHash]
  );

  console.log(`Seeded teams and admin user (${adminEmail}).`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

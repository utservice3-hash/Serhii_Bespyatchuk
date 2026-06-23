import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import { pool } from "./pool.js";

/**
 * Usage:
 *   npm run create-user -- --email=lead@example.com --role=team_lead --team="Тендери"
 *   npm run create-user -- --email=head@example.com --role=admin
 *
 * If --password is omitted, a random one is generated and printed once
 * (it is not stored anywhere other than the hashed form in the database).
 */

function parseArgs(): Record<string, string> {
  const args: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

async function main() {
  const args = parseArgs();
  const email = args.email;
  const role = args.role as "admin" | "team_lead" | "manager" | undefined;
  const teamName = args.team;

  if (!email || !role) {
    throw new Error("Usage: --email=... --role=admin|team_lead|manager [--team=\"Team Name\"]");
  }
  if (role === "team_lead" && !teamName) {
    throw new Error("--team is required for role=team_lead");
  }

  let teamId: number | null = null;
  if (teamName) {
    const teamRes = await pool.query<{ id: number }>(
      `SELECT id FROM teams WHERE name = $1`,
      [teamName]
    );
    if (!teamRes.rows[0]) throw new Error(`Team not found: ${teamName}`);
    teamId = teamRes.rows[0].id;
  }

  const password = args.password ?? randomBytes(9).toString("base64url");
  const passwordHash = await bcrypt.hash(password, 10);

  await pool.query(
    `INSERT INTO users (email, password_hash, role, team_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       role = EXCLUDED.role,
       team_id = EXCLUDED.team_id`,
    [email, passwordHash, role, teamId]
  );

  console.log(`User created: ${email} (role=${role}${teamName ? `, team=${teamName}` : ""})`);
  if (!args.password) {
    console.log(`Generated password (save it now, it won't be shown again): ${password}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});

import { pool } from "./pool.js";
import { createOrUpdateUser, type Role } from "./userService.js";

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
  if (!args.email || !args.role) {
    throw new Error('Usage: --email=... --role=admin|team_lead|manager [--team="Team Name"]');
  }

  const result = await createOrUpdateUser({
    email: args.email,
    role: args.role as Role,
    teamName: args.team,
    password: args.password,
  });

  console.log(`User created: ${result.email} (role=${args.role}${args.team ? `, team=${args.team}` : ""})`);
  if (!args.password) {
    console.log(`Generated password (save it now, it won't be shown again): ${result.password}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});

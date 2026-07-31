// Пише dist/version.json на етапі збірки: sha + гілка + час.
// Викликається з `npm run build`. Якщо git недоступний — пише "unknown", а НЕ вигадує:
// тест приймання після деплою звіряє саме це поле.
import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";

const git = (cmd) => {
  try { return execSync(`git ${cmd}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }
  catch { return null; }
};

const sha = git("rev-parse HEAD") ?? "unknown";
const branch = git("rev-parse --abbrev-ref HEAD");
const payload = { sha, branch, builtAt: new Date().toISOString() };

mkdirSync("dist", { recursive: true });
writeFileSync("dist/version.json", JSON.stringify(payload, null, 2));
console.log(`version.json: ${sha.slice(0, 7)} (${branch ?? "?"})`);

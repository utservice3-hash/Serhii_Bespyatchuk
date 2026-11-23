// Замір «ростер 1×1 з Найму» (19.11.2026, ч.2): READ ONLY. Бере САМЕ код гілки, а не копію правила:
// roster.ts і його залежності читаються з git (`REF`, за замовчуванням FETCH_HEAD) і транспілюються в /tmp.
// Запуск: cd <repo>/backend && git fetch origin claude/project-thread-jt3g7m && nice -n 20 node /tmp/m1x1roster.mjs
// Нічого не пише: BEGIN READ ONLY … ROLLBACK. Читає лише ПІБ, посаду, категорію, статус і зв'язок з Kommo.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(process.cwd() + "/package.json");
const ts = require("typescript");
const { Client } = require("pg");
const REF = process.env.REF || "FETCH_HEAD";
const OUT = "/tmp/o2o-roster";
const FILES = ["oneOnOne/roster.ts", "core/employeeCategory.ts", "core/managerState.ts", "core/activeManager.ts"];
for (const f of FILES) {
  const src = execFileSync("git", ["show", `${REF}:backend/src/${f}`], { encoding: "utf8" });
  if (!src.trim()) throw new Error(`порожнє джерело ${f} у ${REF}`);
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  fs.mkdirSync(path.join(OUT, path.dirname(f)), { recursive: true });
  fs.writeFileSync(path.join(OUT, f.replace(/\.ts$/, ".js")), js);
}
fs.writeFileSync(path.join(OUT, "package.json"), '{"type":"module"}');
const { ROSTER_SQL, rosterOf } = await import(path.join(OUT, "oneOnOne/roster.js"));

if (!process.env.DATABASE_URL) {
  for (const l of fs.readFileSync(".env", "utf8").split("\n")) {
    const m = l.match(/^DATABASE_URL=(.*)$/);
    if (m) process.env.DATABASE_URL = m[1].replace(/^["']|["']$/g, "");
  }
}
const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
try {
  await c.query("BEGIN READ ONLY");
  const rows = (await c.query(ROSTER_SQL)).rows;
  const names = new Map((await c.query("SELECT id, name FROM managers")).rows.map((r) => [r.id, r.name]));
  const out = { ref: execFileSync("git", ["rev-parse", "--short", REF], { encoding: "utf8" }).trim(), working_in_hiring: rows.length };
  for (const t of ["A", "B", "V"]) {
    const r = rosterOf(rows, t);
    out[t] = {
      subjects: r.subjects.length,
      unlinked: r.unlinked.map((u) => `${u.fullName} (${u.position ?? "—"}) · ${u.reason}`),
      names: r.subjects.map((s) => `${s.fullName}${names.get(s.managerId) !== s.fullName ? ` [Kommo: ${names.get(s.managerId)}]` : ""}`),
    };
  }
  console.log(JSON.stringify(out, null, 1));
} finally {
  await c.query("ROLLBACK").catch(() => {});
  await c.end();
}

#!/usr/bin/env node
/**
 * 🧷 PreCompact — ПЕРЕД СТИСНЕННЯМ ЗАПИСАТИ ПЕРЕДАЧУ НА ДИСК.
 *
 * 🔴 ПІДСТАВА. Рішення, які існували ЛИШЕ в розмові, ми вже втрачали: «сер.чек ділиться
 * на УГОДИ, а не на авто» власник ухвалив першим у серії, і воно загубилось серед
 * пізніших промтів — обидві сторони вважали пункт закритим. Компакт робить це системно:
 * після нього сесія памʼятає переказ, а не сказане.
 *
 * 🔴 ЩО САМЕ ПИШЕТЬСЯ, І ЧОМУ НЕ «РЕЗЮМЕ». Хук не вміє розуміти — він уміє НЕ ВТРАТИТИ.
 * Тому: стан гіта числами, що в польоті, живі саботажі — і **останні вказівки власника
 * ДОСЛІВНО**. Переказ своїми словами — це рівно той крок, на якому «ділиться на угоди»
 * і перетворилось на «готово». Дослівна цитата переживає стиснення, переказ — ні.
 *
 * 🔴 НІКОЛИ НЕ КИДАЄ. Хук, що падає перед компактом, ламає компакт; порожній файл
 * гірший за стислий. Кожна секція збирається окремо, і збій однієї не забирає решту.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { findMarkers, SABOTAGE_SUFFIX } from "./no-commit-with-sabotage.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const HANDOFF = `${ROOT}docs/SESSION_HANDOFF.md`;
const MAX_MSGS = 8, MAX_CHARS = 1400;
/**
 * 🔴 НАЙСВІЖІША ВКАЗІВКА НЕ ОБРІЗАЄТЬСЯ. Перша редакція різала всі однаково — і на
 * живому транскрипті зрізала саме поточне завдання: критерій приймання й механіку.
 * Файл читався охайно й був НЕПРИДАТНИЙ, а це рівно те, що він мав виключити.
 * Стара репліка — контекст, остання — те, що робиться ЗАРАЗ; ціни в них різні.
 */
const MAX_CHARS_LAST = 20_000;

const git = (...a) => { try { return execFileSync("git", a, { cwd: ROOT, encoding: "utf8" }).trim(); } catch { return ""; } };

/** Людські репліки власника з транскрипту, найновіші останніми. Службове відсіяно. */
export function userTurns(jsonl) {
  const out = [];
  for (const line of jsonl.split("\n")) {
    if (!line.startsWith("{")) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== "user" || !o.message) continue;
    const c = o.message.content;
    let text = typeof c === "string" ? c
      : Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "";
    if (!text.trim()) continue;                                  // tool_result без тексту
    if (/^\s*<(command-name|local-command|system-reminder)/.test(text)) continue;
    out.push(text.trim());
  }
  return out;
}

export function buildHandoff(now, trigger, turns, git_, markers) {
  const q = (t, last) => {
    const cap = last ? MAX_CHARS_LAST : MAX_CHARS;
    return t.length > cap ? t.slice(0, cap) + "\n   […обрізано…]" : t;
  };
  return `# ПЕРЕДАЧА СЕСІЇ — знято автоматично перед стисненням контексту

> ⚠️ Файл переписується хуком \`PreCompact\` щоразу. Він НЕ джерело правди про проєкт
> (це \`CLAUDE.md\` + \`.claude/rules/*\`), а знімок ЦІЄЇ сесії: після компакту піднімайся
> звідси, а не з памʼяті. Знято: ${now} · привід стиснення: ${trigger}

## Де ми зараз
- гілка **${git_.branch}** · HEAD \`${git_.head}\` — ${git_.subject}
- ${git_.ahead === "" ? "звірку з origin зробити не вдалось" : `не запушено комітів: **${git_.ahead}**`}
- робоче дерево: ${git_.dirty ? `**брудне**\n\`\`\`\n${git_.dirty}\n\`\`\`` : "**чисте**"}

## Що в польоті
${markers.length
  ? `- 🔴 **ЖИВИЙ САБОТАЖ (${markers.length})** — файли зараз НЕ у справжньому вигляді:\n${markers.map((m) => `  • ${m.replace(SABOTAGE_SUFFIX, "")}`).join("\n")}\n  Відновити: \`node dist/tools/sabotage.js <файл> --restore\` + \`rm -rf dist && npm run build\``
  : "- саботажів у дереві немає"}
- останні коміти:
\`\`\`
${git_.log || "(історію прочитати не вдалось)"}
\`\`\`

## Що вирішено — ДОСЛІВНО, вказівками власника
Найсвіжіше внизу. Це не переказ: саме тут живуть рішення, яких немає в коді.

${turns.length ? (() => { const k = turns.slice(-MAX_MSGS); return k.map((t, i) => `### ${i + 1}${i === k.length - 1 ? " — НАЙСВІЖІША, це й робиться зараз" : ""}\n${q(t, i === k.length - 1)}`).join("\n\n"); })() : "_(реплік у транскрипті не знайдено)_"}

## Перш ніж діяти далі
1. \`CLAUDE.md\` — універсальні правила; розділ «🗺 КАРТА ЗОН» скаже, яке правило \`.claude/rules/*\` відкрити під твою зону.
2. Правило зони заходить у контекст на **читанні** файла під його глобом — пишеш у зону з нуля, відкрий правило явно.
3. Перед будь-якою зміною коду — план на затвердження і СТОП (\`ПРАВИЛА РОБОТИ\` п.0).
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let raw = ""; for await (const c of process.stdin) raw += c;
  let input = {}; try { input = JSON.parse(raw || "{}"); } catch { /* шум ігноруємо */ }
  let turns = [];
  try { if (input.transcript_path && existsSync(input.transcript_path)) turns = userTurns(readFileSync(input.transcript_path, "utf8")); } catch { /* секція необовʼязкова */ }
  const git_ = {
    branch: git("rev-parse", "--abbrev-ref", "HEAD") || "?",
    head: git("rev-parse", "--short", "HEAD") || "?",
    subject: git("log", "-1", "--format=%s") || "?",
    ahead: git("rev-list", "--count", "@{u}..HEAD"),
    dirty: git("status", "--short"),
    log: git("log", "--oneline", "-5"),
  };
  let markers = []; try { markers = findMarkers(ROOT); } catch { /* не валимо компакт */ }
  try {
    mkdirSync(dirname(HANDOFF), { recursive: true });
    writeFileSync(HANDOFF, buildHandoff(new Date().toISOString(), input.trigger ?? "?", turns, git_, markers));
    console.log(`🧷 передачу записано: docs/SESSION_HANDOFF.md (реплік ${turns.length}, саботажів ${markers.length})`);
  } catch (e) { console.error(`⚠️ передачу записати не вдалось: ${e?.message ?? e}`); }
  process.exit(0);
}

#!/usr/bin/env node
/**
 * 🔒 PreToolUse — КОМІТ ІЗ ЖИВИМ САБОТАЖЕМ НЕ ПРОХОДИТЬ.
 *
 * 🔴 ПІДСТАВА ЗАМІРЯНА, НЕ ВИГАДАНА. У коміт `96a0700` поїхав НЕЗНЯТИЙ саботаж:
 * `classifyMatrixAnswer` після цього завжди казала «не виміряно». Спіймали читанням
 * власного дифу — тобто дисципліною. Дисципліна ловить не щоразу; ця перевірка ловить
 * щоразу, бо стоїть між наміром і дією.
 *
 * 🔴 ЧОМУ НЕ ЗАЛЕЖИТЬ ВІД ЗБІРКИ. Хук навмисно НЕ кличе `dist/tools/sabotage.js`:
 * у свіжому контейнері `dist` немає, і хук, що падає на власній залежності, або
 * блокує геть усе, або (гірше) мовчки пропускає. Тут — чистий node і файлова система.
 * Ціна: суфікс мітки продубльовано з інструментом. Розбіжність саме тому і стереже
 * гейт `#261c` — він звіряє цю константу з `BACKUP()` у `tools/sabotage.ts`.
 *
 * 🔴 ВІДМОВА НАЗИВАЄ ФАЙЛИ Й КОМАНДУ ВІДНОВЛЕННЯ. Заборона без «що робити далі»
 * коштує стільки ж часу, скільки сама аварія: людина бачить стіну й іде шукати причину.
 * Твердження і текст беруться з ОДНОГО набору `markers` — інакше відмова назве
 * сторонній файл, як це вже сталось із гейтом `#260` (саботаж S1, 31.08.2026).
 */
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** Суфікс копії, яку лишає `tools/sabotage.ts`. Звіряється гейтом `#261c`. */
export const SABOTAGE_SUFFIX = ".sabotage-backup";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SKIP = new Set(["node_modules", ".git", "dist", "backups", ".claude"]);

/** Усі живі мітки саботажу під `dir`. Порожній масив = чисто. */
export function findMarkers(dir, root = dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) findMarkers(p, root, out);
    else if (e.name.endsWith(SABOTAGE_SUFFIX)) out.push(relative(root, p));
  }
  return out;
}

/**
 * Чи є команда комітом. Між `git` і `commit` дозволені лише ПРАПОРЦІ (`-c`, `--git-dir=…`)
 * та їхні значення у формі `ключ=значення` — тобто `git -c core.pager=cat commit` ловиться,
 * а `git log --grep commit` ні: там після `git` стоїть підкоманда, і ланцюг обривається.
 * 🔴 Друга альтернатива додана НЕ для краси: без неї `git -c ключ=значення commit` проходив
 * повз хук, бо значення — окремий аргумент, який не починається з дефіса (спіймав #261b).
 */
export function isCommit(command) {
  return /(^|[;&|]\s*)git(\s+(-[^\s]+|[A-Za-z0-9._-]+=[^\s]*))*\s+commit\b/.test(String(command ?? ""));
}

/**
 * ЄДИНЕ РІШЕННЯ — і вирок, і текст із того самого `markers`.
 * @returns {{block:boolean, reason:string}}
 */
export function decideCommit(command, markers) {
  if (!isCommit(command) || markers.length === 0) return { block: false, reason: "" };
  const list = markers.map((m) => `   • ${m.replace(SABOTAGE_SUFFIX, "")}  (копія: ${m})`).join("\n");
  const restore = markers
    .map((m) => `   node dist/tools/sabotage.js ${m.replace(SABOTAGE_SUFFIX, "").replace(/^backend\//, "")} --restore`)
    .join("\n");
  return { block: true, reason:
`🔴 КОМІТ ЗАБЛОКОВАНО: у дереві ${markers.length} живий(их) саботаж(ів).

Саботовані файли зараз НЕ у своєму справжньому вигляді:
${list}

Так у прод уже поїхав незнятий саботаж (96a0700): функція після нього завжди
казала «не виміряно», а диф виглядав нормально.

ВІДНОВИТИ (з каталогу backend/):
${restore}
   rm -rf dist && npm run build      ← інкрементальний tsc лишає саботовану версію в dist

Саботаж потрібен у коміті свідомо? Прибери копію ${SABOTAGE_SUFFIX} вручну — тоді
відмова зникне, а слід про свідоме рішення лишиться в історії команд.` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let input = {};
  try { input = JSON.parse(raw || "{}"); } catch { /* не наша справа розбирати чужий шум */ }
  if (input.tool_name !== "Bash") process.exit(0);
  const v = decideCommit(input.tool_input?.command, findMarkers(ROOT));
  if (!v.block) process.exit(0);
  console.error(v.reason);
  process.exit(2);          // 2 = блокувати виклик і показати stderr Клоду
}

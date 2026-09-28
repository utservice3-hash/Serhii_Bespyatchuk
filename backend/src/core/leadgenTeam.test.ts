import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 🧭 #740–#740b — КОМАНДА «ЛІДОГЕНЕРАЦІЯ» НЕКОМЕРЦІЙНА СКРІЗЬ, ДЕ ЇЇ ВПІЗНАЮТЬ (24.09.2026).
 *
 * Стару групу «Таня Ковтонюк (лідогенератори)» 23.09 архівували, і лідгени лишились «без
 * команди» — тімлід лідогенерації бачив на своєму екрані нулі. Власник вирішив: нова команда
 * «Лідогенерація», лише в дашборді (сид у `db/schema.sql`, id фіксований).
 *
 * 🔴 Команду впізнають ДВА способи, і вони мусять казати одне:
 *   • за НОМЕРОМ — `metrics.NON_COMMERCIAL_TEAM_IDS` (Звіт, застряглі, плани не бачать її
 *     продажною), `KVP_LEADGEN_TEAM_IDS` у звіті КВП, фронтова `NON_COMMERCIAL_TEAM_IDS`
 *     (перемикач команд Звіту й формування планів);
 *   • за НАЗВОЮ «лідоген» — `reactivateLeads`, `kvpTeamKind`, дві продажні вибірки.
 * Забути номер в одному списку = лідгени вилазять як продажна команда на одному з екранів;
 * перейменувати без «лідоген» = назвові перевірки мовчки перестають її бачити. Звідси гейт.
 *
 * Джерела читаються ТЕКСТОМ: без імпорту `metrics.ts` (він тягне config), без БД — у кожному оточенні.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

const stripComments = (src: string): string =>
  src.replace(/\{\/\*[\s\S]*?\*\/\}/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist" || e === ".git") continue;
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(e)) acc.push(p);
  }
  return acc;
}

interface Sources {
  schema: string; metrics: string; dashboard: string; feConst: string;
  /** Інші файли фронта (шлях → текст) — у них не має лишитись власних копій списку. */
  feOthers: Record<string, string>;
}

const nums = (list: string): string[] => list.split(",").map((x) => x.trim()).filter(Boolean);

/** Розбіжності між способами впізнати команду; порожньо = усе узгоджено. */
export function leadgenTeamDrift(s: Sources): string[] {
  const out: string[] = [];
  const idM = /export const LEADGEN_DASH_TEAM_ID = (\d+);/.exec(s.metrics);
  if (!idM) return ["🔴 metrics.ts: немає LEADGEN_DASH_TEAM_ID"];
  const id = idM[1];

  // схема: команда з цим id сіється, і назва містить «лідоген»
  const seeds = [...s.schema.matchAll(/INSERT INTO teams \(id, name, kommo_group_id\)\s*SELECT (\d+), '([^']+)'/g)];
  const seed = seeds.find((m) => m[1] === id);
  if (!seed) out.push(`🔴 schema.sql не сіє команду ${id}`);
  else if (!/лідоген|лидоген/i.test(seed[2])) out.push(`🔴 команда ${id} зветься «${seed[2]}» — без «лідоген» її не бачать reactivateLeads і КВП`);

  // бекенд: некомерційні — містять нову, і 11 лишається першою (номінації)
  const nc = /export const NON_COMMERCIAL_TEAM_IDS = \[([^\]]+)\]/.exec(stripComments(s.metrics));
  const ncItems = nc ? nums(nc[1]) : [];
  if (!ncItems.includes("LEADGEN_DASH_TEAM_ID") && !ncItems.includes(id)) out.push("🔴 NON_COMMERCIAL_TEAM_IDS без нової команди — Звіт і плани покажуть лідгенів продажною командою");
  if (ncItems[0] !== "11") out.push("🔴 NON_COMMERCIAL_TEAM_IDS: першою мусить лишатись 11 — під нею номінації тримають рішення лідогенераторів");

  // КВП
  const kvp = /const KVP_LEADGEN_TEAM_IDS = new Set\(\[([^\]]+)\]\)/.exec(stripComments(s.dashboard));
  const kvpItems = kvp ? nums(kvp[1]) : [];
  if (!kvpItems.includes("metrics.LEADGEN_DASH_TEAM_ID") && !kvpItems.includes(id)) out.push("🔴 KVP_LEADGEN_TEAM_IDS без нової команди");

  // фронт: один список, той самий склад, що на бекенді (числами)
  const fe = /NON_COMMERCIAL_TEAM_IDS[^=]*= new Set\(\[([^\]]+)\]\)/.exec(stripComments(s.feConst));
  const feItems = fe ? nums(fe[1]).sort() : [];
  const beItems = ncItems.map((x) => (x === "LEADGEN_DASH_TEAM_ID" ? id : x)).sort();
  if (feItems.join(",") !== beItems.join(",")) out.push(`🔴 фронтовий список [${feItems.join(", ")}] ≠ бекендовому [${beItems.join(", ")}]`);

  // фронт: жодної власної копії старого списку
  for (const [p, src] of Object.entries(s.feOthers)) {
    if (/new Set\(\[\s*11\s*,\s*12\s*\]\)/.test(stripComments(src))) out.push(`🔴 ${p}: власна копія [11, 12] — нової команди там немає`);
  }
  return out;
}

function realSources(): Sources {
  const feConstRel = "frontend/src/pages/dashboard/teamSets.ts";
  const feOthers: Record<string, string> = {};
  for (const p of walk(path.join(ROOT, "frontend", "src"))) {
    const rel = path.relative(ROOT, p);
    if (rel !== feConstRel) feOthers[rel] = readFileSync(p, "utf8");
  }
  return {
    schema: read("backend/src/db/schema.sql"), metrics: read("backend/src/core/metrics.ts"),
    dashboard: read("backend/src/routes/dashboard.ts"), feConst: read(feConstRel), feOthers,
  };
}

test("#740 команда «Лідогенерація» некомерційна скрізь: схема, Звіт/плани, КВП і фронт кажуть одне", () => {
  const s = realSources();
  // порожнеча — провал, доки не доведено, що перевіряти БУЛО що: файлів фронта багато, сид знайдено
  assert.ok(Object.keys(s.feOthers).length > 50, "🔴 дерево фронта не прочитано");
  assert.match(s.schema, /SELECT 50011, 'Лідогенерація'/, "🔴 сид команди не знайдено");
  assert.deepEqual(leadgenTeamDrift(s), []);
});

test("#740b 🪞 ДЗЕРКАЛО: кожен спосіб розійтись ловиться — і цілі джерела мовчать", () => {
  const s = realSources();
  const cases: [string, Sources][] = [
    ["без нової в NON_COMMERCIAL", { ...s, metrics: s.metrics.replace("[11, 12, LEADGEN_DASH_TEAM_ID]", "[11, 12]") }],
    ["11 не першою", { ...s, metrics: s.metrics.replace("[11, 12, LEADGEN_DASH_TEAM_ID]", "[12, 11, LEADGEN_DASH_TEAM_ID]") }],
    ["КВП без нової", { ...s, dashboard: s.dashboard.replace("new Set([11, metrics.LEADGEN_DASH_TEAM_ID])", "new Set([11])") }],
    ["фронт без нової", { ...s, feConst: s.feConst.replace("new Set([11, 12, 50011])", "new Set([11, 12])") }],
    ["назва без «лідоген»", { ...s, schema: s.schema.replace("SELECT 50011, 'Лідогенерація'", "SELECT 50011, 'Відділ Ярослава'") }],
    ["сид зник", { ...s, schema: s.schema.replace("SELECT 50011, 'Лідогенерація'", "SELECT 50012, 'Лідогенерація'") }],
    ["копія на фронті", { ...s, feOthers: { ...s.feOthers, "frontend/src/x.tsx": "const HIDE = new Set([11, 12]);" } }],
  ];
  for (const [name, bad] of cases) {
    assert.notDeepEqual(bad, s, `🔴 підміна «${name}» не застосувалась — дзеркало нічого не перевірило`);
    assert.ok(leadgenTeamDrift(bad).length > 0, `🔴 не спіймано: ${name}`);
  }
  assert.deepEqual(leadgenTeamDrift(s), [], "🔴 цілі джерела дали хибну тривогу");
});

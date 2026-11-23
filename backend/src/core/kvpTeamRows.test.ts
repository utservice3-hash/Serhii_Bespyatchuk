import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { hideKvpTeamRow, isEmptyKvpTeamRow, kvpTeamRowName, type KvpTeamRowLike } from "./kvpTeamRows.js";

/**
 * 🏅 Таблиця «Команди — план / факт» у Звіті КВП (скріншот Романа 20.11.2026: безіменний «Повний цикл» і дві
 * «Лідогенерації»). Правило й заміри — у `core/kvpTeamRows.ts`.
 */
const SRC = path.join(import.meta.dirname, "..", "..", "src");
const wk = (over: Partial<KvpTeamRowLike["weeks"][number]> = {}) => ({ plan: 0, fact: 0, expected: 0, auto: 0, leadsAd: 0, leadsLeadgen: 0, ...over });
const row = (over: Partial<KvpTeamRowLike> = {}): KvpTeamRowLike => ({
  teamId: 11, plan: 0, revenue: 0, expected: 0, expectedThisMonth: 0, expectedNextMonth: 0, expectedPastMonths: 0, weeks: [wk(), wk()], ...over });
const KVP = 37283;

/**
 * #9516 — ПОРОЖНІЙ РЯДОК КОМАНДИ БЕЗ ЛЮДЕЙ І ПОРОЖНІЙ РЯДОК ВІДДІЛУ КВП НЕ ПОКАЗУЮТЬСЯ; ГРОШІ НЕ ХОВАЮТЬСЯ НІКОЛИ.
 * 🧨 Червоніє, якщо сховається команда з грошима, планом чи активністю тижня (Σ команд перестала б дорівнювати
 * відділу), сховається порожня команда з живими менеджерами (її нуль — інформація), або порожні рядки
 * мертвої команди й відділу КВП знову зʼявляться.
 */
test("#9516 РЯДКИ КОМАНД ЗВІТУ КВП: порожній без активних менеджерів і порожній відділ КВП — ні; з грошима, планом чи людьми — так", () => {
  // Ховаються: мертва команда з нулями (стара 11) і відділ КВП з нулями (37283, у ньому є активна людина).
  assert.equal(hideKvpTeamRow(row(), false, KVP), true, "🔴 порожній рядок команди без активних менеджерів показується");
  assert.equal(hideKvpTeamRow(row({ teamId: KVP }), true, KVP), true, "🔴 порожній рядок відділу КВП показується");
  // 🪞 Дзеркало: порожня команда з живими менеджерами лишається — це не сміття.
  assert.equal(hideKvpTeamRow(row({ teamId: 50011 }), true, KVP), false, "🔴 сховано порожню команду з активними менеджерами (напр. Лідогенерацію)");
  // Гроші, план, очікування й активність тижня не ховаються ні в мертвої команди, ні у відділу КВП.
  const alive: [string, Partial<KvpTeamRowLike>][] = [
    ["план", { plan: 1 }], ["факт", { revenue: 100 }], ["відʼємний факт (сторно)", { revenue: -50 }], ["очікування", { expected: 10 }],
    ["очікування цього місяця", { expectedThisMonth: 5 }], ["очікування наступного", { expectedNextMonth: 5 }], ["прострочене", { expectedPastMonths: 5 }],
    ["авто тижня", { weeks: [wk(), wk({ auto: 1 })] }], ["ліди тижня", { weeks: [wk({ leadsLeadgen: 2 })] }], ["факт тижня", { weeks: [wk({ fact: 7 })] }],
  ];
  for (const [what, over] of alive) {
    assert.equal(isEmptyKvpTeamRow(row(over)), false, `🔴 рядок із «${what}» вважається порожнім`);
    assert.equal(hideKvpTeamRow(row(over), false, KVP), false, `🔴 сховано команду без активних менеджерів, у якої є «${what}»`);
    assert.equal(hideKvpTeamRow(row({ ...over, teamId: KVP }), true, KVP), false, `🔴 сховано відділ КВП, у якого є «${what}»`);
  }
  // Назва: відома — як є; невідома чи порожня — словами з номером, не порожнім місцем.
  assert.deepEqual([kvpTeamRowName("Хомік Team Lead", 36284), kvpTeamRowName("", 11), kvpTeamRowName(undefined, 7), kvpTeamRowName("   ", 9)],
    ["Хомік Team Lead", "Команда #11", "Команда #7", "Команда #9"], "🔴 рядок команди може лишитись без назви");
});

/**
 * #9517 — ПРОВОДКА: `/kvp-report` бере назви команд із `teams`, заводить команду з плану менеджера вже З НАЗВОЮ і
 * проганяє рядки через `hideKvpTeamRow` з відділом КВП із `prozorroAssign` (одна константа на весь бекенд).
 * 🧨 Червоніє, якщо команда знову заводитиметься з порожнім імʼям, фільтр зникне або відділ КВП задасться своїм числом.
 */
test("#9517 ПРОВОДКА РЯДКІВ КОМАНД: назва з teams, жодного порожнього імені, фільтр hideKvpTeamRow з KVP_DEPT_TEAM_ID", () => {
  const r = readFileSync(path.join(SRC, "routes", "dashboard.ts"), "utf8");
  assert.doesNotMatch(r, /teamGet\(mp\.teamId, ""\)/, "🔴 команда з плану менеджера знову заводиться з порожнім імʼям");
  assert.match(r, /const e = teamGet\(mp\.teamId, kvpTeamRowName\(teamNameById\.get\(mp\.teamId\), mp\.teamId\)\);/, "🔴 назва команди не з teams");
  assert.match(r, /pool\.query<\{ id: number; name: string \}>\(`SELECT id, name FROM teams`\)/, "🔴 назви команд не читаються з teams");
  assert.match(r, /\.filter\(\(t\) => !hideKvpTeamRow\(t, teamsWithActive\.has\(t\.teamId\), KVP_DEPT_TEAM_ID\)\)/, "🔴 рядки команд не проходять правило показу");
  assert.match(r, /import \{ KVP_DEPT_TEAM_ID \} from "\.\.\/core\/prozorroAssign\.js";/, "🔴 відділ КВП заданий не спільною константою");
  assert.match(r, /const teamsWithActive = new Set\(mgrTeamRows\.rows\.map\(\(r\) => r\.team_id\)/, "🔴 «є активні менеджери» рахується не з активних менеджерів");
});

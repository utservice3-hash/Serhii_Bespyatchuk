import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { KEEP_DASHBOARD_TEAM_NAME, teamRenameFromKommo } from "./teamName.js";

const ROOT = path.join(import.meta.dirname, "..", "..", "..");

/**
 * 🏷 НАЗВА КОМАНДИ — З KOMMO (02.11.2026, задача 7371). Живий випадок дня: група 335511 у Kommo — «Яцик Team lead»,
 * команда 5 у дашборді — «РПК - Яцика Дмитра», і синк цього не бачив, бо назву не чіпав узагалі.
 */

const base = { groupId: 335511, local: "РПК - Яцика Дмитра", takenByOther: false };

test("#3303 назва з Kommo лягає на наявну команду; та сама назва — без змін (жодного запису щотіку)", () => {
  assert.deepEqual(teamRenameFromKommo({ ...base, kommo: "Яцик Team lead" }), { kind: "rename", name: "Яцик Team lead" });
  // по той бік межі: назва вже та сама — нічого не пишемо, інакше синк оновлював би рядок кожні 30 хв
  assert.deepEqual(teamRenameFromKommo({ ...base, local: "Яцик Team lead", kommo: "Яцик Team lead" }), { kind: "keep", reason: "same" });
  // Kommo віддає назви з хвостовими пробілами («Логисты ») — це не нова назва
  assert.deepEqual(teamRenameFromKommo({ ...base, local: "Логисты", kommo: "Логисты " }), { kind: "keep", reason: "same" });
  // порожня назва з Kommo не стирає нашу
  assert.deepEqual(teamRenameFromKommo({ ...base, kommo: "  " }), { kind: "keep", reason: "empty" });
});

test("#3304 свідомо змінена назва дашборду переживає синк: «Тендери» не повертає «Самостійний»", () => {
  assert.ok(KEEP_DASHBOARD_TEAM_NAME.has(417860), "група 417860 (команда 4) — у винятках");
  assert.deepEqual(teamRenameFromKommo({ groupId: 417860, local: "Самостійний", kommo: "Тендери", takenByOther: false }),
    { kind: "keep", reason: "kept" });
  // дзеркало: виняток не ковдра — сусідня група з тим самим входом перейменовується
  assert.equal(teamRenameFromKommo({ groupId: 332088, local: "Самостійний", kommo: "Тендери", takenByOther: false }).kind, "rename");
});

test("#3305 назву вже носить інша команда — пропуск, а не помилка (збій тут зупинив би синк угод)", () => {
  assert.deepEqual(teamRenameFromKommo({ ...base, kommo: "Хомік Team Lead", takenByOther: true }), { kind: "collision", name: "Хомік Team Lead" });
  assert.equal(teamRenameFromKommo({ ...base, kommo: "Хомік Team Lead", takenByOther: false }).kind, "rename");
});

test("#3306 синк кличе перейменування для НАЯВНОЇ команди і ловить зіткнення унікальної назви (23505)", () => {
  const sync = readFileSync(path.join(ROOT, "backend/src/jobs/syncKommo.ts"), "utf8");
  const existing = sync.slice(sync.indexOf("if (existing.rows.length) {"), sync.indexOf("} else {", sync.indexOf("if (existing.rows.length) {")));
  assert.match(existing, /renameTeamFromKommo\(teamId, group\.id, existing\.rows\[0\]\.name, group\.name\)/,
    "гілка наявної команди не оновлює назву — перейменування в Kommo знову не дійде до дашборду");
  const fn = sync.slice(sync.indexOf("async function renameTeamFromKommo"), sync.indexOf("export async function syncManagers"));
  assert.match(fn, /teamRenameFromKommo\(/, "рішення про назву має йти через чисту функцію, яку стережуть #3303–#3305");
  assert.match(fn, /"23505"/, "зіткнення унікальної назви має бути пропуском, а не падінням синку");
});

test("#3307 дзвінки депстату: команда → тімлід ЗА НОМЕРОМ — нова назва з Kommo не викидає команду", async () => {
  const { leadOfTeam } = await import("../statistics/catalog.js");
  // та сама відповідність, що давали старі назви «РПК - Шаврової Лілії», «РНК - Безпамʼятного Андрія»…
  assert.deepEqual([5, 6, 13, 14, 15, 4, 36283].map(leadOfTeam),
    ["Яцик", "Дмитрук", "Безпамятний", "Шаврова", "Михальчевська", "Шевчук Назар", "Шевчук Назар"]);
  // по той бік межі: команди поза депстатом (Хомік, лідоген, фінвідділ) — без тімліда, як і було
  assert.deepEqual([36284, 11, 12, null].map(leadOfTeam), [null, null, null, null]);
});

test("#3308 buildLeadMap не читає назву команди — лише її номер", () => {
  const src = readFileSync(path.join(ROOT, "backend/src/jobs/syncRingostatCalls.ts"), "utf8");
  const fn = src.slice(src.indexOf("export async function buildLeadMap"), src.indexOf("export function resolveLead"));
  assert.match(fn, /leadOfTeam\(row\.team_id\)/, "тімлід має братись за номером команди");
  assert.doesNotMatch(fn, /\bt\.name\b|JOIN teams/, "назва команди знову в привʼязці дзвінків — перейменування в Kommo її зламає");
  assert.doesNotMatch(src, /\/(Яцик|Дмитрук|Безпам|Шавров|Михальчевсь|Самост)[^/]*\/i?\.test\(/, "тімлід знову шукається словом у назві");
});

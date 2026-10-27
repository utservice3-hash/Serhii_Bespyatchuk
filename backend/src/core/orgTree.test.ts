import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildOrg, tgNick, labelKey, type UnitRow, type PersonRow } from "./orgTree.js";

/**
 * 🏢 ОРГ СТРУКТУРА (задача 7062, ТЗ Даші 23.10.2026; рішення Романа 27.10.2026). Окремий файл: живі гейти підключають
 * власну одноразову базу (правило про scratch-кластер і спільний пул, testing.md).
 */
const SRC = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "backend", "src", p), "utf8");
const FE = path.join(import.meta.dirname, "..", "..", "..", "frontend", "src");
const FSRC = (p: string) => readFileSync(path.join(FE, p), "utf8");

const unit = (o: Partial<UnitRow> & { id: number; name: string }): UnitRow => ({
  parentId: null, dept: "sales", teamId: null, teamName: null, label: null, headEmployeeId: null, teamLeadEmployeeId: null,
  side: false, sort: 0, ...o,
});
const person = (o: Partial<PersonRow> & { id: number; name: string }): PersonRow => ({
  position: null, teamLabel: null, telegram: null, photoV: null, userId: null, ...o,
});

/**
 * #2700 — ЯДРО: кожен працюючий рівно в ОДНОМУ місці; «Команда» збігається з блоком без регістру, пробілів і виду
 * апострофа; незнайома чи порожня «Команда» — у «Без блоку» з переліком значень, а не зникнення; керівник ручний >
 * тімлід команди, і керівник стоїть у своєму блоці, хоч яка в нього «Команда».
 * 🧨 Червоніє, якщо загубити людину з незнайомою «Командою», порівнювати «Команду» буквально або поставити тімліда
 * поверх ручного керівника.
 */
test("#2700 ЯДРО ОРГ-СТРУКТУРИ: кожен рівно раз, «Без блоку» з переліком, керівник ручний > тімлід", () => {
  const units = [
    unit({ id: 1, name: "Керівництво", dept: "top", label: "Керівництво", headEmployeeId: 10 }),
    unit({ id: 2, name: "Команда Безпамʼятного", parentId: 1, teamId: 13, teamName: "РНК - Безпамʼятного Андрія", teamLeadEmployeeId: 20, sort: 1 }),
    unit({ id: 3, name: "Команда Хомік", parentId: 1, teamId: 14, teamName: "Хомік Team Lead", teamLeadEmployeeId: 30, headEmployeeId: 31, sort: 2 }),
    unit({ id: 4, name: "Контейнер", parentId: 1, sort: 3 }),
  ];
  const people = [
    person({ id: 10, name: "Ступаківський", teamLabel: "0" }),
    person({ id: 20, name: "Безпамʼятний", teamLabel: "1", telegram: "@andrii_uts" }),
    person({ id: 21, name: "Бердишев", teamLabel: "  рнк -  безпам'ятного андрія " }),
    person({ id: 30, name: "Тімлід Хомік", teamLabel: "хомік team lead" }),
    person({ id: 31, name: "Хомік", teamLabel: "2" }),
    person({ id: 40, name: "Код", teamLabel: "9" }),
    person({ id: 41, name: "Ще код", teamLabel: "9" }),
    person({ id: 42, name: "Порожній", teamLabel: null, photoV: 5, userId: 7 }),
  ];
  const t = buildOrg(units, people, 7);
  const where = new Map(t.people.map((p) => [p.id, p]));
  // Кожен — рівно раз: суму місць рахуємо з блоків, а не з `people`, інакше рівність була б тавтологією.
  const spots = [...t.units.flatMap((u) => [...(u.headId != null ? [u.headId] : []), ...u.memberIds]), ...t.unassigned];
  const headsElsewhere = t.units.filter((u) => u.headId != null && where.get(u.headId)!.unitId !== u.id).length;
  assert.equal(spots.length - headsElsewhere, people.length, "🔴 сума місць на схемі ≠ кількості працюючих");
  assert.deepEqual([...new Set(spots)].sort(), people.map((p) => p.id).sort(), "🔴 хтось загубився або зʼявився двічі");
  // Керівники.
  assert.equal(t.units[0].headId, 10); assert.equal(t.units[0].headSource, "manual");
  assert.equal(t.units[1].headId, 20, "🔴 блок команди не взяв тімліда"); assert.equal(t.units[1].headSource, "team");
  assert.equal(t.units[2].headId, 31, "🔴 тімлід переписав ручного керівника"); assert.equal(t.units[2].headSource, "manual");
  assert.equal(where.get(31)!.unitId, 3, "🔴 керівник не в своєму блоці (його «Команда» — «2»)");
  assert.equal(where.get(10)!.isHead, true);
  // «Команда» ↔ блок: регістр, пробіли, апостроф.
  assert.deepEqual(t.units[1].memberIds, [21], "🔴 «Команда» з іншим регістром/апострофом не потрапила в блок команди");
  assert.deepEqual(t.units[2].memberIds, [30], "🔴 тімлід (не керівник) не став учасником свого блоку");
  assert.equal(t.units[1].label, "РНК - Безпамʼятного Андрія", "«Команда» блоку команди = назва команди дашборду");
  assert.equal(t.units[3].label, null, "блок без «Команди» й команди — контейнер");
  // Невідоме — видно.
  assert.deepEqual(t.unassigned.sort(), [40, 41, 42], "🔴 незнайома/порожня «Команда» не в «Без блоку»");
  assert.deepEqual(t.unknownLabels, [{ label: "9", count: 2 }, { label: "«Команда» не заповнена", count: 1 }]);
  assert.deepEqual(t.stats, { total: 8, noTelegram: 7, noPhoto: 7, unassigned: 3 });
  assert.equal(where.get(42)!.isMe, true); assert.equal(where.get(21)!.isMe, false);
  assert.deepEqual(where.get(42)!.photo, { id: 42, v: 5 });
  assert.equal(labelKey(" А  Б’в "), labelKey("а бʼв"));
});

/**
 * #2701 — НІК У TELEGRAM: `@nick`, `nick`, `t.me/nick`, `https://t.me/nick` → `@nick`; сентинел «-», два ніки в
 * одному полі (заміряно на проді 27.10), кирилиця, коротше 5 — «не вказано», а не посилання в нікуди.
 * 🧨 Червоніє, якщо пропускати «-» чи «@a    @b» далі як нік — кнопка «Telegram» вела б на t.me/-.
 */
test("#2701 НІК: @/без @/t.me → @nick; «-», два ніки, кирилиця, коротке → не вказано", () => {
  for (const ok of ["@ivan_uts", "ivan_uts", " t.me/ivan_uts ", "https://t.me/ivan_uts", "http://telegram.me/ivan_uts"])
    assert.equal(tgNick(ok), "@ivan_uts", `🔴 «${ok}» не розпізнано`);
  for (const bad of [null, "", " ", "-", "@", "@a    @b_second", "@іван_ютс", "@abcd", "1ivan_uts", "ivan uts"])
    assert.equal(tgNick(bad), null, `🔴 «${bad}» прийнято за нік`);
  const t = buildOrg([], [person({ id: 1, name: "А", telegram: "-" }), person({ id: 2, name: "Б", telegram: null })], null);
  assert.deepEqual(t.people.map((p) => [p.telegram, p.telegramInvalid]), [[null, true], [null, false]], "некоректне ≠ порожнє");
});

/** Одна scratch-база на файл: схема двічі (другий прогін — як наступний викат). */
async function scratch(t: { skip: (m: string) => void }) {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const s = provisionScratch();
  if ("unavailable" in s) { t.skip(skipReason(s)); return null; }
  process.env.DATABASE_URL = s.url;
  process.env.JWT_SECRET ??= "test"; process.env.KOMMO_BASE_URL ??= "https://x.invalid"; process.env.KOMMO_API_TOKEN ??= "x";
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: s.url });
  await c.connect();
  const schema = SRC("db/schema.sql");
  return { c, s, schema, done: async () => { await c.end(); s.dispose(); } };
}

/**
 * #2702 — ЖИВИЙ SQL СХЕМИ: сід дає 14 блоків + 2 «збоку» з привʼязкою до команд дашборду за групою Kommo; керівники
 * прототипу — лише за ОДНОЗНАЧНИМ збігом ПІБ і РАЗОВО (свідомо знятого наступний викат не повертає); дерево —
 * лише працюючі, а поля людини — поіменно: телефону, пошти, дат немає у відповіді взагалі.
 * 🧨 Червоніє, якщо додати `phone` у вибірку, пустити звільнених, прибрати разову позначку керівників або
 * брати першого з двох тезок.
 */
test("#2702 ЖИВИЙ SQL: сід 14+2 блоків, керівники разово й однозначно, лише працюючі, без телефону й дат", async (t) => {
  const x = await scratch(t); if (!x) return;
  const { c } = x;
  try {
    await c.query(x.schema);
    // «Комерційний відділ» і «Лідогенерація» (50011) сідить сама схема — тут лише команда з групою Kommo.
    await c.query(`INSERT INTO teams (id, name, kommo_group_id) VALUES (901, 'РНК - Безпамʼятного Андрія', 588532)`);
    await c.query(`INSERT INTO managers (id, name, team_id, is_team_lead) VALUES (801, 'Безпамятний Андрій', 901, true)`);
    await c.query(`INSERT INTO employees (id, full_name, import_key, status, position, team_label, phone, email, birth_date, manager_id) VALUES
      (1, 'Ступаківський Олександр Олександрович', 'k1', 'active', 'Власники компанії', '0', '+380501112233', 'a@x.ua', '1980-01-01', NULL),
      (2, 'Роман Денисюк', 'k2', 'active', 'IT відділ', NULL, '+380501112234', NULL, NULL, NULL),
      (3, 'Коваль Артем', 'k3', 'active', 'Власники компанії', '0', NULL, NULL, NULL, NULL),
      (4, 'Коваль Артем Іванович', 'k4', 'active', 'менеджер', NULL, NULL, NULL, NULL, NULL),
      (5, 'Безпамʼятний Андрій', 'k5', 'active', 'TeamLead', '1', NULL, NULL, NULL, 801),
      (6, 'Звільнений Тест', 'k6', 'dismissed', 'менеджер', 'Бухгалтерія', '+380501112235', NULL, NULL, NULL),
      (7, 'Завершує Тест', 'k7', 'finishing', 'бухгалтерія', 'Бухгалтерія', NULL, NULL, NULL, NULL)`);
    // Наступний викат: сід знову (з командами тепер), разова позначка керівників — знята, щоб вона відпрацювала тут.
    await c.query(`DELETE FROM org_units; DELETE FROM org_migrations`);
    await c.query(x.schema);
    const u = async () => new Map((await c.query(`SELECT seed_key, team_id, side, head_employee_id, label FROM org_units`)).rows.map((r) => [r.seed_key, r]));
    let units = await u();
    assert.equal(units.size, 16, `🔴 сід дав ${units.size} блоків, а не 14 + 2 «збоку»`);
    assert.deepEqual([...units.values()].filter((r) => r.side).map((r) => r.seed_key).sort(), ["ba", "owner2"]);
    assert.equal(units.get("rnk1")!.team_id, 901, "🔴 блок не привʼязався до команди за групою Kommo");
    assert.equal(units.get("lid")!.team_id, 50011, "🔴 «Лідогенерація» (без групи) не привʼязалась за назвою");
    assert.equal(units.get("sales")!.team_id, (await c.query(`SELECT id FROM teams WHERE name = 'Комерційний відділ'`)).rows[0].id);
    assert.equal(units.get("sales")!.label, null, "блок, привʼязаний до команди, бере її назву, а не власну «Команду»");
    assert.equal(units.get("rpk1")!.team_id, null, "команди немає в дашборді — блок без привʼязки, а не чужа команда");
    assert.equal(units.get("ceo")!.head_employee_id, 1);
    assert.equal(units.get("it")!.head_employee_id, 2, "🔴 «Роман Денисюк» (імʼя першим) не знайдено");
    assert.equal(units.get("owner2")!.head_employee_id, null, "🔴 з двох «Коваль Артем…» узято першого — керівник має бути однозначним");
    await c.query(`UPDATE org_units SET head_employee_id = NULL WHERE seed_key = 'ceo'`);
    await c.query(x.schema);
    units = await u();
    assert.equal(units.get("ceo")!.head_employee_id, null, "🔴 наступний викат повернув свідомо знятого керівника");
    assert.equal(units.size, 16, "🔴 повторний прогін схеми задублював блоки");

    const { loadOrg } = await import("./orgTree.js");
    const tree = await loadOrg(c as never, null);
    assert.deepEqual(tree.people.map((p) => p.id).sort(), [1, 2, 3, 4, 5, 7], "🔴 у схемі звільнений або немає того, хто «завершує»");
    const keys = [...new Set(tree.people.flatMap((p) => Object.keys(p)))].sort();
    assert.deepEqual(keys, ["id", "isHead", "isMe", "name", "photo", "position", "teamLabel", "telegram", "telegramInvalid", "unitId"],
      `🔴 у відповіді схеми зайві поля людини: ${keys.join(", ")}`);
    const raw = JSON.stringify(tree);
    for (const leak of ["+38050", "a@x.ua", "1980-01-01"]) assert.ok(!raw.includes(leak), `🔴 у відповіді схеми є «${leak}»`);
    const idOf = async (k: string) => (await c.query(`SELECT id FROM org_units WHERE seed_key = $1`, [k])).rows[0].id as number;
    assert.equal(tree.people.find((p) => p.id === 5)!.unitId, await idOf("rnk1"), "🔴 тімлід команди не став керівником її блоку");
    const rnk1 = await idOf("rnk1");
    assert.equal(tree.units.find((x) => x.id === rnk1)?.headId, 5);
    assert.equal(tree.people.find((p) => p.id === 7)!.unitId, await idOf("fin2"), "🔴 той, хто «завершує», не на своєму місці");
  } finally { await x.done(); }
});

/**
 * #2703 — ЖИВИЙ SQL «МОЄ» І ПЕРЕТЯГУВАННЯ: нік пишеться в СВІЙ рядок реєстру (за акаунтом), без рядка — 404, сміття —
 * 400 без запису; перемістити людину = її «Команда» в «Наймі» (той самий `updateEmployee` з аудитом) + рядок журналу
 * зі старим значенням; блок без «Команди» — 409; «Без блоку» — «Команда» знімається.
 * 🧨 Червоніє, якщо нік піде в чужий рядок, сміття збережеться, переміщення не змінить «Найм» чи не лишить журналу.
 */
test("#2703 ЖИВИЙ SQL: свій нік — лише у свій рядок; перетягнути = «Команда» в «Наймі» + аудит + журнал", async (t) => {
  const x = await scratch(t); if (!x) return;
  const { c } = x;
  try {
    await c.query(x.schema);
    await c.query(`INSERT INTO users (id, email, password_hash, role) VALUES (71, 'hr@x.ua', 'x', 'manager'), (72, 'me@x.ua', 'x', 'manager'), (73, 'no@x.ua', 'x', 'manager')`);
    await c.query(`INSERT INTO employees (id, full_name, import_key, status, team_label, telegram, user_id) VALUES
      (11, 'Я Сам', 'k11', 'active', '3', NULL, 72), (12, 'Інший', 'k12', 'active', NULL, '@other_uts', NULL)`);
    const o = await import("./orgTree.js");
    assert.equal(await o.setMyTelegram(c as never, 72, " https://t.me/sam_uts "), "@sam_uts");
    const tg = async (id: number) => (await c.query(`SELECT telegram FROM employees WHERE id = $1`, [id])).rows[0].telegram;
    assert.equal(await tg(11), "@sam_uts"); assert.equal(await tg(12), "@other_uts", "🔴 нік записано не в свій рядок");
    await assert.rejects(o.setMyTelegram(c as never, 72, "@a    @b"), (e: { status?: number }) => e.status === 400, "🔴 сміття прийнято за нік");
    assert.equal(await tg(11), "@sam_uts", "🔴 відмова все одно переписала нік");
    await assert.rejects(o.setMyTelegram(c as never, 73, "@nobody_uts"), (e: { status?: number }) => e.status === 404, "🔴 акаунт без рядка «Найму» щось записав");
    assert.equal(await o.setMyTelegram(c as never, 72, ""), null, "порожньо — прибрати свій нік");

    const fin2 = (await c.query(`SELECT id FROM org_units WHERE seed_key = 'fin2'`)).rows[0].id as number;
    const ceo = (await c.query(`SELECT id FROM org_units WHERE seed_key = 'ceo'`)).rows[0].id as number;
    await c.query(`INSERT INTO org_units (parent_id, name, dept) VALUES ($1, 'Без команди', 'top')`, [ceo]);
    const bare = (await c.query(`SELECT id FROM org_units WHERE name = 'Без команди'`)).rows[0].id as number;
    await o.moveEmployee(c as never, 71, 12, fin2);
    const lbl = async (id: number) => (await c.query(`SELECT team_label FROM employees WHERE id = $1`, [id])).rows[0].team_label;
    assert.equal(await lbl(12), "Бухгалтерія", "🔴 переміщення не змінило «Команду» в «Наймі»");
    const audit = (await c.query(`SELECT action, details FROM access_audit WHERE target_id = 'e12' ORDER BY id DESC LIMIT 1`)).rows[0];
    assert.equal(audit?.action, "employees.update", "🔴 переміщення обійшло аудит реєстру");
    assert.deepEqual(audit.details, { changed: ["team_label"] }, "в аудиті — назва поля, без значень (правило реєстру)");
    const lg = (await c.query(`SELECT action, actor_id, before, after FROM org_log WHERE employee_id = 12 ORDER BY id DESC LIMIT 1`)).rows[0];
    assert.deepEqual([lg.action, lg.actor_id, lg.before, lg.after], ["move", 71, { team_label: null }, { team_label: "Бухгалтерія" }], "🔴 журнал без старого значення");
    await assert.rejects(o.moveEmployee(c as never, 71, 12, bare), (e: { status?: number }) => e.status === 409, "🔴 переміщення в блок без «Команди»");
    assert.equal(await lbl(12), "Бухгалтерія");
    await o.moveEmployee(c as never, 71, 12, null);
    assert.equal(await lbl(12), null, "«Без блоку» — «Команда» знімається");
    const tree = await o.loadOrg(c as never, 72);
    assert.equal(tree.people.find((p) => p.id === 11)!.isMe, true);
    assert.equal(tree.people.find((p) => p.id === 12)!.unitId, null);
  } finally { await x.done(); }
});

/**
 * #2704 — ЖИВИЙ SQL БЛОКІВ: зміна «Команди» блоку ПЕРЕНОСИТЬ людей (їм ставиться нова «Команда»), інакше
 * перейменування висипало б блок у «Без блоку»; дві однакові «Команди» — 409; коло підпорядкування — 400; команда
 * дашборду — лише в одному блоці; непорожній блок і блок із підпорядкованими не видаляються.
 * 🧨 Червоніє, якщо прибрати перенесення людей, перевірку близнюка, кола або непорожнього видалення.
 */
test("#2704 ЖИВИЙ SQL: «Команда» блоку несе людей, близнюк 409, коло 400, непорожній не видаляється", async (t) => {
  const x = await scratch(t); if (!x) return;
  const { c } = x;
  try {
    await c.query(x.schema);
    await c.query(`INSERT INTO teams (id, name) VALUES (911, 'РПК - Тест')`);
    await c.query(`INSERT INTO users (id, email, password_hash, role) VALUES (81, 'ba@x.ua', 'x', 'manager')`);
    await c.query(`INSERT INTO employees (id, full_name, import_key, status, team_label) VALUES
      (21, 'Бухгалтер Один', 'k21', 'active', 'бухгалтерія'), (22, 'Бухгалтер Два', 'k22', 'active', 'Бухгалтерія'),
      (23, 'Звільнений', 'k23', 'dismissed', 'Бухгалтерія')`);
    const o = await import("./orgTree.js");
    const id = async (k: string) => (await c.query(`SELECT id FROM org_units WHERE seed_key = $1`, [k])).rows[0].id as number;
    const fin2 = await id("fin2"), ops = await id("ops"), ceo = await id("ceo"), sales = await id("sales");
    await o.updateUnit(c as never, 81, fin2, { label: "Бухгалтерія ЮТС", name: "Бухгалтерія" });
    const lbl = async (eid: number) => (await c.query(`SELECT team_label FROM employees WHERE id = $1`, [eid])).rows[0].team_label;
    assert.deepEqual([await lbl(21), await lbl(22)], ["Бухгалтерія ЮТС", "Бухгалтерія ЮТС"], "🔴 нова «Команда» блоку не перенесла людей");
    assert.equal(await lbl(23), "Бухгалтерія", "🔴 зачеплено звільненого");
    assert.deepEqual((await o.loadOrg(c as never, null)).units.find((u) => u.id === fin2)!.memberIds.sort(), [21, 22]);
    await assert.rejects(o.updateUnit(c as never, 81, ops, { label: " бухгалтерія  ютс " }), (e: { status?: number }) => e.status === 409, "🔴 дві однакові «Команди»");
    await assert.rejects(o.updateUnit(c as never, 81, ceo, { parentId: fin2 }), (e: { status?: number }) => e.status === 400, "🔴 коло підпорядкування");
    await assert.rejects(o.updateUnit(c as never, 81, fin2, { label: null }), (e: { status?: number }) => e.status === 409, "🔴 блок із людьми лишився без «Команди»");
    const a = await o.createUnit(c as never, 81, { name: "Нова команда", parentId: sales, dept: "sales", teamId: 911 });
    await assert.rejects(o.createUnit(c as never, 81, { name: "Двійник", parentId: sales, dept: "sales", teamId: 911 }), (e: { status?: number }) => e.status === 409, "🔴 одна команда — у двох блоках");
    await assert.rejects(o.createUnit(c as never, 81, { name: "Збоку", dept: "top", side: true }), (e: { status?: number }) => e.status === 400, "🔴 «збоку» без батька");
    await assert.rejects(o.deleteUnit(c as never, 81, fin2), (e: { status?: number }) => e.status === 409, "🔴 видалено блок із людьми");
    await assert.rejects(o.deleteUnit(c as never, 81, sales), (e: { status?: number }) => e.status === 409, "🔴 видалено блок із підпорядкованими");
    await o.deleteUnit(c as never, 81, a);
    assert.equal((await c.query(`SELECT 1 FROM org_units WHERE id = $1`, [a])).rowCount, 0, "порожній блок видаляється");
    const acts = (await c.query(`SELECT action FROM org_log ORDER BY id`)).rows.map((r) => r.action);
    assert.deepEqual(acts, ["move", "move", "unit.update", "unit.create", "unit.delete"], `🔴 журнал блоків: ${acts.join(", ")}`);
  } finally { await x.done(); }
});

/**
 * #2705 — ДОСТУП: вкладка `org` — УСІМ ролям, включно з кандидатом; право `edit_org` — рівно admin, HR, БА, і після
 * ДРУГОГО прогону схеми теж (синк копіює права адміна керівництву й фінансисту — без зняття воно б розтеклось).
 * Роутер: вкладка ще раз першим middleware, кожен запис у схему — під `edit_org`, «моє» не читає id із запиту.
 * 🧨 Червоніє, якщо поставити видачу права вище синків без зняття, забути `requirePerm` на одному роуті, або дати
 * «моєму» роуту `req.params`.
 */
test("#2705 ДОСТУП: org — усім, edit_org — admin/HR/БА після двох прогонів, запис — під правом, «моє» — без id", async (t) => {
  const tab = SRC("auth/routeTab.ts");
  assert.match(tab, /\{ test: pre\("\/api\/org"\), tabs: \["org"\] \}/, "🔴 немає межі вкладки для /api/org");
  const r = SRC("routes/org.ts");
  assert.match(r, /orgRouter\.use\(requireAuth\);\s*\norgRouter\.use\(\(req, res, next\) => \{\s*\n\s*if \(!req\.auth \|\| !roleHasTab\(req\.auth\.roleKey, "org"\)\)/, "🔴 друга лінія (вкладка на роутері) зникла");
  const routes = [...r.matchAll(/orgRouter\.(get|post|put|patch|delete)\("([^"]+)"(, requirePerm\("edit_org"\))?/g)].map((m) => ({ m: m[1], p: m[2], perm: !!m[3] }));
  assert.equal(routes.length, 8, `🔴 роутів орг-структури ${routes.length}, а не 8 — матриця й гейт розійдуться`);
  for (const x of routes) {
    const mine = x.p.startsWith("/me/") || x.p === "/tree";
    assert.equal(x.perm, !mine, `🔴 ${x.m.toUpperCase()} ${x.p}: ${mine ? "«моє»/перегляд під правом редагування" : "запис без edit_org"}`);
  }
  for (const p of ["/me/telegram", "/me/photo"]) {
    const body = r.slice(r.indexOf(`"${p}"`), r.indexOf("});", r.indexOf(`"${p}"`)));
    assert.ok(!/req\.params|req\.body\??\.(employeeId|id)\b/.test(body), `🔴 ${p} читає id людини з запиту`);
  }
  const schema = SRC("db/schema.sql");
  assert.match(schema, /UPDATE roles SET screen_access = screen_access \|\| '\{"org":true\}'::jsonb\s*\n\s*WHERE NOT \(screen_access \? 'org'\);/, "🔴 вкладка org — не всім ролям");
  const x = await scratch(t); if (!x) return;
  try {
    await x.c.query(x.schema);
    await x.c.query(x.schema);
    const rows = (await x.c.query(`SELECT key, (screen_access->>'org')::boolean AS tab, COALESCE((permissions->>'edit_org')::boolean, false) AS edit FROM roles ORDER BY key`)).rows;
    assert.ok(rows.length >= 9, "ролей мало — сід не відпрацював");
    assert.deepEqual(rows.filter((x) => !x.tab).map((x) => x.key), [], "🔴 ролі без вкладки «Орг структура»");
    assert.ok(rows.some((x) => x.key === "candidate" && x.tab), "🔴 кандидат не бачить схеми (рішення Романа 27.10)");
    assert.deepEqual(rows.filter((x) => x.edit).map((x) => x.key), ["admin", "business_assistant", "hr"], "🔴 edit_org розтеклось або загубилось");
  } finally { await x.done(); }
});

/**
 * #2706 — ФРОНТ: «Компанія → Орг структура» першою групою меню з позначкою «НОВЕ» до дати; статичний імпорт (#225);
 * стартова вкладка ролі НЕ стає «org» (бухгалтерія й БА без «Звіту» лишаються на своїй першій вкладці); у секції немає
 * телефону й дат — лише те, що віддає API.
 * 🧨 Червоніє, якщо дозволити homeSection обрати «org», лінивий імпорт секції або показати телефон.
 */
test("#2706 ФРОНТ: група «Компанія» першою, НОВЕ до дати, статичний імпорт, стартова вкладка не «org», без телефону", async () => {
  const lay = FSRC("components/Layout.tsx");
  const first = lay.slice(lay.indexOf("export const NAV_GROUPS = ["), lay.indexOf("label: \"Аналітика\""));
  assert.match(first, /label: "Компанія"[\s\S]*key: "org", label: "Орг структура"/, "🔴 «Компанія → Орг структура» не першою групою");
  assert.match(lay, /const ORG_NEW_UNTIL = "\d{4}-\d{2}-\d{2}"/, "🔴 позначка «НОВЕ» без кінцевої дати");
  const dash = FSRC("pages/Dashboard.tsx");
  assert.match(dash, /import \{ OrgSection \} from "\.\/dashboard\/sections\/OrgSection";/, "🔴 секція не статичним імпортом (#225)");
  assert.match(dash, /\{section === "org" && <OrgSection \/>\}/);
  const ts = await import("typescript");
  const js = ts.transpileModule(FSRC("pages/dashboard/homeSection.ts"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { homeSection } = await import(`data:text/javascript,${encodeURIComponent(js)}`);
  const nav = ["org", "report", "receivables", "ba", "bank"];
  assert.equal(homeSection({ roleKey: "business_assistant", screens: ["org", "ba"], navKeys: nav }), "ba", "🔴 БА стартує на орг-структурі");
  assert.equal(homeSection({ roleKey: "____________", screens: ["org", "bank", "receivables"], navKeys: nav }), "receivables", "🔴 бухгалтерія стартує на орг-структурі");
  assert.equal(homeSection({ roleKey: "manager", screens: ["org", "report"], navKeys: nav }), "report", "дзеркало: «Звіт» лишається");
  assert.equal(homeSection({ roleKey: "x", screens: ["org"], navKeys: nav }), "org", "дзеркало: якщо більше нічого — схема");
  const sec = FSRC("pages/dashboard/sections/OrgSection.tsx");
  assert.ok(!/phone|birth|телефон/i.test(sec), "🔴 у секції орг-структури телефон або дата народження");
  assert.match(sec, /href=\{`https:\/\/t\.me\/\$\{/, "🔴 немає кнопки «Telegram» на t.me/<нік>");
});

/**
 * #2709 — ЕТАП 2 = ЛИШЕ ВІДКРИТИ TELEGRAM (рішення Романа 27.10.2026: «не можна слати повідомлення … тільки відкривання
 * телеграма»). «Написати» є і в картці, і в кожному рядку списку — посиланням на t.me/<нік>, лише коли нік є; поля
 * повідомлення, кнопки «Надіслати» й виклику месенджера в секції немає.
 * 🧨 Червоніє, якщо прибрати «Написати» зі списку, показати його без ніка або додати відправку повідомлення.
 */
test("#2709 ЕТАП 2: «Написати» в картці й у списку відкриває t.me/<нік>, лише з ніком; надсилання з дашборда немає", () => {
  const sec = FSRC("pages/dashboard/sections/OrgSection.tsx");
  const list = sec.slice(sec.indexOf('<table className="org-list">'), sec.indexOf("</table>"));
  assert.ok(list.length > 0, "🔴 таблицю списку не знайдено — гейту нема що перевіряти");
  assert.match(list, /\{p\.telegram && <a [^>]*href=\{`https:\/\/t\.me\/\$\{p\.telegram\.slice\(1\)\}`\}[^>]*>Написати<\/a>\}/, "🔴 у рядку списку немає «Написати» на t.me/<нік> під умовою ніка");
  assert.match(list, /colSpan=\{5\}/, "🔴 колонку додано, а порожній рядок «Нікого не знайдено» не розтягнуто на неї");
  const card = sec.slice(sec.indexOf("function PersonCard("), sec.indexOf("function UnitDialog("));
  assert.match(card, /\{p\.telegram && \([\s\S]*?href=\{`https:\/\/t\.me\/\$\{p\.telegram\.slice\(1\)\}`\}[\s\S]*?>Написати в Telegram<\/a>/, "🔴 у картці немає «Написати в Telegram» під умовою ніка");
  assert.ok(!/<textarea|Надіслати|sendMessage|\/api\/messenger/.test(sec), "🔴 у секції зʼявилось надсилання повідомлення з дашборда");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { matchFilesToEmployees } from "./employeeAdd.js";

/**
 * 👤 «+ СПІВРОБІТНИК», ЗАПИС ІЗ НАЙМУ, 📎 РОЗКЛАДАННЯ ФАЙЛІВ ПО ЛЮДЯХ (22.09.2026) — гейти `#646`–`#649`.
 * Номери з запасом над `#645` — борг 17: перед мержем перемірити перетин.
 */

async function scratch(t: { skip: (m: string) => void }) {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const s = provisionScratch();
  if ("unavailable" in s) { t.skip(skipReason(s)); return null; }
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: s.url });
  await c.connect();
  await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
  const hr = (await c.query(`INSERT INTO users (email, password_hash, role, role_override, full_name) VALUES ('ivan@uts.ua','x','manager','hr','Іван') RETURNING id`)).rows[0].id as number;
  await c.query("INSERT INTO teams(id,name) VALUES (3,'РПК · Дмитрук') ON CONFLICT DO NOTHING");
  const db = c as unknown as import("./hiring.js").Db;
  return { c, db, hr, add: await import("./employeeAdd.js"), h: await import("./hiring.js"), done: async () => { await c.end(); s.dispose(); } };
}
const bad = (st: number) => (e: unknown) => (e as { status?: number }).status === st;

/**
 * #646 — «+ СПІВРОБІТНИК»: прізвище й імʼя обовʼязкові; погана дата — 400; та сама людина вже є — 409 з її id;
 * повторний імпорт таблиці з цією людиною знаходить ТОЙ САМИЙ запис (спільний ключ ПІБ), а не створює другий.
 * 🧨 Червоніє, якщо ключ ручного запису розійдеться з ключем імпорту або дубль пройде.
 */
test("#646 ЖИВИЙ SQL: «+ Співробітник» — ПІБ обовʼязкове, дубль 409 з id, імпорт знаходить ту саму людину", async (t) => {
  const s = await scratch(t); if (!s) return;
  const emp = await import("./employees.js");
  try {
    await assert.rejects(s.add.createEmployee(s.db, s.hr, { full_name: "Коваленко" }), bad(400), "🔴 без імені прийнято");
    await assert.rejects(s.add.createEmployee(s.db, s.hr, { full_name: "Коваленко Олена", hired_at: "31.02.2026" }), bad(400), "🔴 неіснуючу дату прийнято");
    const { id } = await s.add.createEmployee(s.db, s.hr, { full_name: "  Коваленко   Олена  Петрівна ", position: "менеджер", team_label: "3", hired_at: "22.09.2026" });
    const row = (await s.c.query(`SELECT full_name, status, source, hired_at::text AS h FROM employees WHERE id = $1`, [id])).rows[0];
    assert.deepEqual(row, { full_name: "Коваленко Олена Петрівна", status: "active", source: "manual", h: "2026-09-22" });
    try { await s.add.createEmployee(s.db, s.hr, { full_name: "коваленко олена петрівна" }); assert.fail("🔴 дубль прийнято"); }
    catch (e) { assert.equal((e as { status?: number; existingId?: number }).status, 409); assert.equal((e as { existingId?: number }).existingId, id, "🔴 у 409 немає id наявної людини"); }
    const { randomBytes } = await import("node:crypto");
    await emp.commitImport(s.db as never, randomBytes(32), s.hr, "ПІБ,Телефон\nКоваленко Олена Петрівна,0501112233\n", ["full_name", "phone"], "active");
    assert.equal((await s.c.query(`SELECT count(*)::int n FROM employees`)).rows[0].n, 1, "🔴 імпорт створив другу людину");
    assert.equal((await s.c.query(`SELECT phone FROM employees WHERE id = $1`, [id])).rows[0].phone, "0501112233", "дзеркало: імпорт знайшов саме цей запис");
  } finally { await s.done(); }
});

/**
 * #647 — КАНДИДАТ СТАВ «МЕНЕДЖЕР» → У РЕЄСТРІ: із командою кандидата, посадою з вакансії, датою прийому сьогодні, привʼязкою
 * до кандидата; другий раз — без дубля. Та сама людина вже в реєстрі — привʼязується, не дублюється. Повернення з
 * «Менеджер» прибирає щойно створений запис; якщо до нього вже прикріпили документ — запис лишається.
 * 🧨 Червоніє, якщо «Менеджер» не пише в реєстр, дублює або повернення стирає людину з даними.
 */
test("#647 ЖИВИЙ SQL: «Менеджер» у наймі → людина в реєстрі; без дублів; повернення прибирає лише порожній запис", async (t) => {
  const s = await scratch(t); if (!s) return;
  try {
    const vac = await s.h.createVacancy(s.db, null, { title: "Менеджер з продажу", position: "менеджер з продажу" });
    const mk = async (name: string, phone: string) => {
      const id = await s.h.createCandidate(s.db, null, { fullName: name, phone, vacancyId: vac });
      await s.c.query(`UPDATE hiring_candidates SET status = 'training', team_id = 3 WHERE id = $1`, [id]);
      return id;
    };
    const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
    const a = await mk("Нова Марія", "0501110001");
    await s.h.changeStatus(s.db, s.hr, a, { to: "manager", comment: "прийнята" }, "edit", null);
    const e = (await s.c.query(`SELECT id, full_name, status, team_label, position, hired_at::text AS h, source, candidate_id FROM employees`)).rows;
    assert.equal(e.length, 1, "🔴 «Менеджер» не записав людину в реєстр");
    assert.deepEqual({ ...e[0], id: undefined }, { id: undefined, full_name: "Нова Марія", status: "active", team_label: "РПК · Дмитрук", position: "менеджер з продажу", h: today, source: "hiring", candidate_id: a });
    // Повернення з «Менеджер» — порожній запис зникає; знову «Менеджер» — зʼявляється, без дубля.
    await s.h.changeStatus(s.db, s.hr, a, { to: "training", comment: "назад" }, "edit", null);
    assert.equal((await s.c.query(`SELECT count(*)::int n FROM employees`)).rows[0].n, 0, "🔴 повернення лишило щойно створений запис");
    await s.h.changeStatus(s.db, s.hr, a, { to: "manager", comment: "таки так" }, "edit", null);
    const eid = (await s.c.query(`SELECT id FROM employees WHERE candidate_id = $1`, [a])).rows[0].id;
    await s.add.ensureEmployeeFromCandidate(s.db, s.hr, a);
    assert.equal((await s.c.query(`SELECT count(*)::int n FROM employees`)).rows[0].n, 1, "🔴 другий виклик задублював людину");
    // До запису прикріпили документ — повернення людину НЕ стирає.
    await s.c.query(`INSERT INTO doc_files (name, stored_name, section, employee_id, created_by) VALUES ('NDA.pdf','n.pdf','personal',$1,$2)`, [eid, s.hr]);
    await s.h.changeStatus(s.db, s.hr, a, { to: "training", comment: "ще раз назад" }, "edit", null);
    assert.equal((await s.c.query(`SELECT count(*)::int n FROM employees WHERE id = $1`, [eid])).rows[0].n, 1, "🔴 повернення стерло людину з документом");
    // Людина вже в реєстрі (імпорт) — кандидат із тим самим ПІБ привʼязується, не дублюється.
    await s.c.query(`INSERT INTO employees (full_name, import_key, status) VALUES ('Стара Ольга', 'стара ольга', 'active')`);
    const b = await mk("Стара Ольга", "0501110002");
    await s.h.changeStatus(s.db, s.hr, b, { to: "manager", comment: "прийнята" }, "edit", null);
    assert.deepEqual((await s.c.query(`SELECT count(*)::int n, max(candidate_id) AS cid FROM employees WHERE import_key = 'стара ольга'`)).rows[0], { n: 1, cid: b }, "🔴 наявну людину задубльовано або не привʼязано");
  } finally { await s.done(); }
});

/**
 * #648 — ЧИЙ ФАЙЛ: у назві мусять бути прізвище І імʼя людини (будь-який порядок, «_», «-», «.» — роздільники);
 * лише ЄДИНИЙ збіг; однофамільці — «неоднозначно»; лише прізвище — «не впізнано»; той самий ПІБ у працюючого й
 * звільненого — перевага працюючому.
 * 🧨 Червоніє, якщо брати першого з однофамільців або впізнавати за самим прізвищем.
 */
test("#648 ЧИЙ ФАЙЛ: прізвище й імʼя в назві, лише єдиний збіг, однофамільців не вгадує", () => {
  const people = [
    { id: 1, full_name: "Коваленко Олена Петрівна", status: "active" },
    { id: 2, full_name: "Бондар Андрій", status: "active" },
    { id: 3, full_name: "Бондар Андрій Іванович", status: "active" },
    { id: 4, full_name: "Шевчук Назар", status: "dismissed" },
    { id: 5, full_name: "Шевчук Назар", status: "active" },
    { id: 6, full_name: "Мельник Ірина", status: "dismissed" },
  ];
  const r = matchFilesToEmployees([
    "Офер_Коваленко_Олена.pdf", "olena.pdf", "NDA - Олена Коваленко.docx", "Бондар Андрій NDA.pdf",
    "Коваленко.pdf", "Шевчук.Назар.офер.pdf", "мельник_ірина_заява.PDF",
  ], people);
  assert.deepEqual(r.map((x) => [x.employeeId, x.how]), [
    [1, "name"], [null, "none"], [1, "name"], [null, "ambiguous"], [null, "none"], [5, "name"], [6, "name"],
  ], "🔴 розкладання не те: " + JSON.stringify(r.map((x) => [x.file, x.employeeId, x.how])));
  assert.deepEqual(r[3].candidates.sort(), [2, 3], "однофамільці названі обидва, щоб обрати вручну");
});

/**
 * #649 — ЖИВИЙ SQL: прев'ю розкладання бере людей із реєстру і не пише нічого; порожній пакет — 400.
 * 🧨 Червоніє, якщо прев'ю щось записує або пускає порожній пакет.
 */
test("#649 ЖИВИЙ SQL: прев'ю пакета — лише читання, люди з реєстру, порожній пакет 400", async (t) => {
  const s = await scratch(t); if (!s) return;
  try {
    await s.c.query(`INSERT INTO employees (full_name, import_key, status) VALUES ('Коваленко Олена', 'коваленко олена', 'active')`);
    const before = (await s.c.query(`SELECT count(*)::int n FROM doc_files`)).rows[0].n;
    const r = await s.add.matchFiles(s.db, ["Офер Коваленко Олена.pdf", "хтось.pdf"]);
    assert.deepEqual(r.map((x) => x.how), ["name", "none"]);
    assert.equal((await s.c.query(`SELECT count(*)::int n FROM doc_files`)).rows[0].n, before, "🔴 прев'ю записало документ");
    await assert.rejects(s.add.matchFiles(s.db, []), bad(400));
  } finally { await s.done(); }
});

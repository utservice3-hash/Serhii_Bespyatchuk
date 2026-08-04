import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * #27 — ДЗВІНКИ RINGOSTAT: таблиця, дедуп батча, звʼязка з клієнтом.
 * Проти справжньої бази: урок #25 — запит, який ніхто не виконував, падає в проді.
 */
const SCHEMA = path.join(import.meta.dirname, "..", "db", "schema.sql");

test("#27 ДЗВІНКИ: запис, дедуп батча, звʼязка номер→клієнт", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(scratch.unavailable);
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET ??= "test";
  process.env.KOMMO_BASE_URL ??= "https://x.invalid";
  process.env.KOMMO_API_TOKEN ??= "x";
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  const { pool } = await import("../db/pool.js");
  try {
    await c.query(readFileSync(SCHEMA, "utf8"));
    await c.query(`INSERT INTO teams (id,name) VALUES (1,'РПК') ON CONFLICT DO NOTHING`);
    await c.query(`INSERT INTO managers (id,name,team_id,is_active) VALUES (7,'Гаркушина Юлія',1,true) ON CONFLICT DO NOTHING`);
    await c.query(`INSERT INTO pipeline_stage_map (pipeline_id,status_id,funnel_stage) VALUES (8921932,142,'paid') ON CONFLICT DO NOTHING`);
    await c.query(`INSERT INTO deals (kommo_id,name,manager_id,pipeline_id,status_id,price,client_key,client_key_raw,client_name,closed_at_kommo)
                   VALUES (500,'d',7,8921932,142,1000,'тесткліент','тесткліент','ТОВ Тест', now() - interval '5 days')`);
    await c.query(`INSERT INTO deal_contacts (deal_kommo_id, contact_id, is_main) VALUES (500, 4242, true)`);
    await c.query(`INSERT INTO contact_phones (contact_id, phone, raw_phone, is_main) VALUES (4242,'380671234567','+38 (067) 123-45-67',true)`);

    const S = await import("./syncCalls.js");
    // 🔴 БАТЧ ІЗ ДУБЛЕМ `uniqueid` — саме той клас, що поклав syncKommo 03.08.2026.
    const written = await S.upsertCalls([
      { uniqueid: "u1", calldate: new Date().toISOString(), call_type: "in",
        caller: "+380671234567", billsec: 120, disposition: "ANSWERED",
        recording: "https://app.ringostat.com/recordings/u1", employee_fio: "Гаркушина Юлія" },
      { uniqueid: "u1", calldate: new Date().toISOString(), call_type: "in",
        caller: "+380671234567", billsec: 130, disposition: "ANSWERED",
        recording: "https://app.ringostat.com/recordings/u1",
        employee_fio: "Гаркушина Юлія Олексіївна" },   // ДУБЛЬ (повне ПІБ, як у Ringostat)
      { uniqueid: "u2", calldate: new Date().toISOString(), call_type: "out",
        caller: "utsua_sip", dst: "380671234567", billsec: 0, disposition: "NO ANSWER" },
      { uniqueid: "u3", calldate: new Date().toISOString(), call_type: "in",
        caller: "380990000000", billsec: 60, disposition: "ANSWERED" },      // чужий номер
    ]);
    assert.ok(written >= 3, "🔴 нічого не записалось — це провал, а не «немає даних»");
    assert.equal(Number((await c.query(`SELECT COUNT(*) n FROM ringostat_calls`)).rows[0].n), 3,
      "дубль uniqueid мав злитись в один рядок");

    // Номер клієнта: для вихідного взято `dst`, а не SIP-логін із `caller`.
    const u2 = (await c.query<{ client_phone: string | null }>(
      `SELECT client_phone FROM ringostat_calls WHERE uniqueid='u2'`)).rows[0];
    assert.equal(u2.client_phone, "380671234567",
      "🔴 для вихідного взято caller (SIP-логін) — усі вихідні звʼязались би з фантомом");

    const linked = await S.linkCalls();
    assert.ok(linked.byPhone >= 2, "два дзвінки на номер клієнта мали звʼязатись");
    const rows = (await c.query<{ uniqueid: string; client_key: string | null; manager_id: number | null }>(
      `SELECT uniqueid, client_key, manager_id FROM ringostat_calls ORDER BY uniqueid`)).rows;
    const by = new Map(rows.map((r) => [r.uniqueid, r]));
    assert.equal(by.get("u1")?.client_key, "тесткліент");
    assert.equal(by.get("u2")?.client_key, "тесткліент");
    // ДЗЕРКАЛО: чужий номер НЕ звʼязується. Без цього «звʼязка» могла б чіпляти всіх.
    assert.equal(by.get("u3")?.client_key, null,
      "🔴 невідомий номер отримав клієнта — тоді звʼязка приписує дзвінки навмання");

    // ПІБ мапиться на менеджера; порожній ПІБ лишає NULL — «менеджер невідомий».
    // ПІБ у Ringostat ПОВНЕ («…Олексіївна»), у managers коротке — точний збіг
    // дав би нуль мапінгів і всі дзвінки стали б «менеджер невідомий».
    assert.equal(by.get("u1")?.manager_id, 7, "🔴 повне ПІБ не змапилось на коротке імʼя менеджера");
    assert.equal(Number((await c.query(`SELECT billsec FROM ringostat_calls WHERE uniqueid='u1'`)).rows[0].billsec), 130,
      "🔴 переміг ПЕРШИЙ запис дубля; має перемагати останній (свіжіший знімок)");
    assert.equal(by.get("u3")?.manager_id, null,
      "🔴 дзвінок без employee_fio отримав менеджера — це вгадування, яке заборонено");

    // ── Підтести в ТОМУ САМОМУ кластері: окремий provisionScratch на тест колись
    //    поклав сусідні тести («Connection terminated unexpectedly»).
    await t.test("#27c ПІБ У managers ТЕЖ ТРИЧЛЕННЕ — ключ зрізається з ОБОХ боків", async () => {
      // 🔴 РЕГРЕСІЯ, ЗАМІРЯНА НА ПРОДІ 04.08.2026. Правило різало ПІБ дзвінка до
      // двох слів, а `managers.name` брало ЦІЛИМ. Поки в тесті був лише менеджер
      // із коротким імʼям, баг був невидимий — а на проді 55 менеджерів (19
      // активних) мають тричленне імʼя, і 111 366 дзвінків (26.8%) тихо лишались
      // «менеджер невідомий». Цей менеджер існує САМЕ щоб ловити асиметрію.
      await c.query(`INSERT INTO managers (id,name,team_id,is_active)
                     VALUES (8,'Демчук Вікторія Олександрівна',1,true) ON CONFLICT DO NOTHING`);
      await S.upsertCalls([{ uniqueid: "u4", calldate: new Date().toISOString(), call_type: "in",
        caller: "380991112233", billsec: 42, disposition: "ANSWERED",
        employee_fio: "Демчук Вікторія Олександрівна" }]);
      await S.linkCalls();
      const r = (await c.query<{ manager_id: number | null }>(
        `SELECT manager_id FROM ringostat_calls WHERE uniqueid='u4'`)).rows[0];
      assert.equal(r.manager_id, 8,
        "🔴 тричленне імʼя в managers не змапилось — саме так губились 26.8% дзвінків");
    });

    await t.test("#27d ДУБЛЬ КЛЮЧА: беремо АКТИВНОГО, а не першого-ліпшого", async () => {
      // На проді 8 ключів дублюються — це та сама людина двома рядками (активний +
      // деактивований). Вибір має бути ДЕТЕРМІНОВАНИЙ, інакше історія дзвінків
      // перескакує між рядками щопрогону.
      await c.query(`INSERT INTO managers (id,name,team_id,is_active)
                     VALUES (9,'Пехньо Ксенія Олександрівна',1,false) ON CONFLICT DO NOTHING`);
      await c.query(`INSERT INTO managers (id,name,team_id,is_active)
                     VALUES (10,'Пехньо Ксенія Олександрівна',1,true) ON CONFLICT DO NOTHING`);
      await S.upsertCalls([{ uniqueid: "u5", calldate: new Date().toISOString(), call_type: "in",
        caller: "380991112244", billsec: 10, disposition: "ANSWERED",
        employee_fio: "Пехньо Ксенія Олександрівна" }]);
      await S.linkCalls();
      const r = (await c.query<{ manager_id: number | null }>(
        `SELECT manager_id FROM ringostat_calls WHERE uniqueid='u5'`)).rows[0];
      assert.equal(r.manager_id, 10, "🔴 обрано деактивований рядок замість активного");
    });

    await t.test("#27e ЗВІЛЬНЕНОМУ ДЗВІНОК ПРИПИСУЄТЬСЯ (рішення власника 04.08.2026)", async () => {
      // ЗМІНА ПОЛІТИКИ. Було: деактивований → NULL («менеджер невідомий»).
      // Стало: історія має казати правду — «дзвонила конкретна людина (звільнена)»
      // корисніше за «невідомо». Тест перевернуто, не видалено.
      await c.query(`INSERT INTO managers (id,name,team_id,is_active)
                     VALUES (11,'Ліненко Софія Євгенівна',1,false) ON CONFLICT DO NOTHING`);
      await S.upsertCalls([{ uniqueid: "u6", calldate: new Date().toISOString(), call_type: "in",
        caller: "380991112255", billsec: 10, disposition: "ANSWERED",
        employee_fio: "Ліненко Софія Євгенівна" }]);
      await S.linkCalls();
      const r = (await c.query<{ manager_id: number | null }>(
        `SELECT manager_id FROM ringostat_calls WHERE uniqueid='u6'`)).rows[0];
      assert.equal(r.manager_id, 11,
        "🔴 дзвінок звільненого лишився без менеджера — історія втрачає правду");
    });

    await t.test("#27f ДЗЕРКАЛО ЗАБОРОНИ: невідомий ПІБ і далі NULL", async () => {
      // Без цього #27e зеленів би й тоді, коли ми почали чіпляти КОГО ЗАВГОДНО.
      // «Приписуємо звільненим» ≠ «приписуємо навмання»: людини, якої немає в
      // managers, у звʼязці бути не може.
      await S.upsertCalls([{ uniqueid: "u7", calldate: new Date().toISOString(), call_type: "in",
        caller: "380991112266", billsec: 10, disposition: "ANSWERED",
        employee_fio: "Неіснуючий Персонаж Вигаданович" }]);
      await S.linkCalls();
      const r = (await c.query<{ manager_id: number | null }>(
        `SELECT manager_id FROM ringostat_calls WHERE uniqueid='u7'`)).rows[0];
      assert.equal(r.manager_id, null,
        "🔴 ПІБ, якого немає в managers, отримав менеджера — це вгадування");
    });
  } finally {
    await pool.end().catch(() => {});
    await c.end();
    scratch.dispose();
  }
});

test("#27b ТЕЛЕФОНИ КОНТАКТУ: беремо ВСІ, не лише перший", async () => {
  const { allPhones } = await import("./backfillContactPhones.js");
  const c = { id: 1, name: "К", custom_fields_values: [
    { field_code: "PHONE", values: [{ value: "+38 (067) 111-22-33" }, { value: "0509998877" }, { value: "—" }] },
  ] } as unknown as Parameters<typeof allPhones>[0];
  const out = allPhones(c);
  // `extractPhone` у kommo/client.ts бере [0] — цього мало: у клієнта буває
  // мобільний і робочий, і дзвінок може прийти з будь-якого.
  assert.deepEqual(out.map((p) => p.norm), ["380671112233", "380509998877"]);
  assert.equal(out[0].raw, "+38 (067) 111-22-33", "сире значення зберігається поруч");
  // «—» відкинуто: краще без номера, ніж із вигаданим.
  assert.equal(out.length, 2);
});

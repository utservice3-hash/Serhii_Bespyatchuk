import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  screenVerdict, countsAsContact, countsAsContactSql, interpretScreen, buildScreenRequest, imageMimeOf,
  SCREENS_FROM_UNIX, SCREENS_FROM_ISO, SCREEN_KINDS, SCREEN_SCHEMA, KOMMO_CHANNEL, SCREEN_OPERATION, type AttachmentNote,
} from "./kommoScreens.js";
import { CONTACT_CHANNEL_KEYS } from "./clientContacts.js";
import { skipReason } from "../db/scratchDb.js";

/**
 * 📎 ЗАДАЧА 8347 (ТЗ Юлі 06.11, п.3; Роман 11.11 «1 так 2 ТІЛЬКИ З СЬОГОДНІ 3 так 4 так, роби»): скрін з угоди Kommo
 * сам потрапляє в картку клієнта з AI-коментарем і рахується контактом — лише якщо це переписка.
 */
const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const note = (o: Partial<AttachmentNote> = {}): AttachmentNote => ({
  id: 1, entityId: 100, createdBy: 555, createdAt: SCREENS_FROM_UNIX + 60, noteType: "attachment",
  isDrive: true, fileUuid: "f-1", originalName: "IMG_1.png", ...o,
});

/**
 * #3840 🪞 — ЯКИЙ ФАЙЛ БЕРЕМО, по обидва боки кожної межі: png/jpg/jpeg/webp/heic з файлів Kommo, прикріплений людиною,
 * не раніше 11.11.2026 00:00 за Києвом (рішення п.2). Не беремо: PDF/Word, вкладення не з файлів Kommo, від бота
 * (`created_by = 0`), на секунду раніше старту, нотатку іншого типу.
 * 🧨 Червоніє, якщо прибрати перевірку типу файлу (у контакти полізуть PDF), автора (скріни ботів) або дати старту
 * (підтягнуться старі скріни всупереч рішенню).
 */
test("#3840 🪞 СКРІН: картинка з файлів Kommo від людини з 11.11 — так; PDF, не drive, бот, до старту — ні", () => {
  assert.equal(SCREENS_FROM_ISO, "2026-11-10T22:00:00.000Z", "🔴 дата старту — не 11.11.2026 00:00 за Києвом");
  assert.deepEqual(screenVerdict(note()), { take: true, mime: "image/png" });
  assert.deepEqual(screenVerdict(note({ originalName: "Знімок.JPG" })), { take: true, mime: "image/jpeg" });
  assert.equal(imageMimeOf("a.webp"), "image/webp");
  assert.equal(imageMimeOf("a.heic"), "image/heic");
  assert.deepEqual(screenVerdict(note({ originalName: "Рахунок.pdf" })), { take: false, why: "not_image" }, "🔴 PDF узято як скрін");
  assert.deepEqual(screenVerdict(note({ originalName: "договір.docx" })), { take: false, why: "not_image" });
  assert.deepEqual(screenVerdict(note({ originalName: null })), { take: false, why: "not_image" });
  assert.deepEqual(screenVerdict(note({ isDrive: false })), { take: false, why: "not_drive" });
  assert.deepEqual(screenVerdict(note({ fileUuid: null })), { take: false, why: "not_drive" });
  assert.deepEqual(screenVerdict(note({ createdBy: 0 })), { take: false, why: "system" }, "🔴 скрін бота узято як контакт менеджера");
  assert.deepEqual(screenVerdict(note({ createdAt: SCREENS_FROM_UNIX - 1 })), { take: false, why: "too_old" }, "🔴 скрін до 11.11 узято");
  assert.deepEqual(screenVerdict(note({ createdAt: SCREENS_FROM_UNIX })), { take: true, mime: "image/png" }, "🔴 межа старту — не включно");
  assert.deepEqual(screenVerdict(note({ noteType: "common" })), { take: false, why: "not_attachment" });
});

/**
 * #3841 🪞 — КОНТАКТ = ЛИШЕ ПЕРЕПИСКА (рішення п.1), і правило одне для коду й SQL. Ручний контакт — як був (будь-який
 * канал); скрін з Kommo — лише `chat`; документ, фото, інше й ще не прочитаний — ні. SQL-вираз дає те саме на всіх
 * п'яти випадках (перевірка на справжній БД — у `#3846`). Канал `kommo` руками створити не можна.
 * 🧨 Червоніє, якщо скрін зараховувати без огляду на тип (фото ТТН стане «контактом»), якщо зламати ручні контакти, або
 * якщо `kommo` потрапить у перелік «＋ Контакт».
 */
test("#3841 🪞 КОНТАКТ ЛИШЕ ПЕРЕПИСКА: ручний — так; Kommo chat — так; документ, фото, інше, не прочитаний — ні", () => {
  for (const ch of CONTACT_CHANNEL_KEYS) assert.equal(countsAsContact(ch, null), true, `🔴 ручний контакт «${ch}» перестав рахуватись`);
  assert.equal(countsAsContact(KOMMO_CHANNEL, "chat"), true, "🔴 переписка з Kommo не рахується контактом");
  for (const k of ["document", "photo", "other", null]) assert.equal(countsAsContact(KOMMO_CHANNEL, k), false, `🔴 скрін «${String(k)}» рахується контактом`);
  assert.equal(countsAsContactSql("cc"), "(cc.channel <> 'kommo' OR cc.ai_kind = 'chat')");
  assert.ok(!CONTACT_CHANNEL_KEYS.includes(KOMMO_CHANNEL), "🔴 канал «kommo» можна створити кнопкою «＋ Контакт»");
});

/**
 * #3842 🪞 — ВІДПОВІДЬ AI. Переписка з коментарем — прийнято; переписка без коментаря — непридатна (інакше «контакт» без
 * змісту); документ із коментарем — коментар відкинуто; невідомий тип, не JSON, відмова моделі — непридатна. Запит несе
 * саму картинку (`inline_data`, base64, MIME), а перелік типів у схемі == перелік у коді.
 * 🧨 Червоніє, якщо прийняти переписку без коментаря, показати коментар до фото ТТН чи розійтись переліку типів зі схемою.
 */
test("#3842 🪞 ВІДПОВІДЬ AI: переписка з коментарем — так; без — ні; документ без коментаря; запит несе картинку", () => {
  assert.deepEqual(interpretScreen(JSON.stringify({ kind: "chat", summary: " Домовились на завантаження в пн. " })),
    { ok: true, kind: "chat", summary: "Домовились на завантаження в пн." });
  assert.equal(interpretScreen(JSON.stringify({ kind: "chat", summary: "  " })).ok, false, "🔴 прийнято переписку без коментаря");
  assert.deepEqual(interpretScreen(JSON.stringify({ kind: "document", summary: "ТТН №5" })), { ok: true, kind: "document", summary: null },
    "🔴 коментар до документа показується як домовленість");
  assert.equal(interpretScreen(JSON.stringify({ kind: "selfie", summary: "" })).ok, false);
  assert.equal(interpretScreen("не json").ok, false);
  assert.equal(interpretScreen(null).ok, false);
  assert.equal(interpretScreen("{}", "SAFETY").ok, false);
  const body = buildScreenRequest(new Uint8Array([1, 2, 3]), "image/png") as {
    contents: { parts: { inline_data?: { mime_type: string; data: string }; text?: string }[] }[];
    generationConfig: { responseFormat: { text: { schema: typeof SCREEN_SCHEMA } } };
  };
  const img = body.contents[0].parts.find((p) => p.inline_data)?.inline_data;
  assert.deepEqual(img, { mime_type: "image/png", data: "AQID" }, "🔴 у запиті до AI немає самої картинки");
  assert.deepEqual(body.generationConfig.responseFormat.text.schema.properties.kind.enum, [...SCREEN_KINDS]);
});

/** Усі `.ts` бекенда без тестів — простір перелічено ЦІЛКОМ, потім фільтр (правило 16). */
function backendFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = path.join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith(".ts") && !f.endsWith(".test.ts")) out.push(p);
    }
  };
  walk(path.join(ROOT, "backend/src"));
  return out;
}

/**
 * #3843 — КОЖЕН, ХТО ЧИТАЄ КОНТАКТИ КЛІЄНТА, ЗНАЄ ПРАВИЛО «ЛИШЕ ПЕРЕПИСКА». Критерій — від предмета (правило 12): кожен
 * SQL-шаблон у бекенді, що читає `client_contacts` (`FROM`/`JOIN`). Кожен або несе `countsAsContactSql(…)`, або має
 * названу причину, чому правило йому не потрібне: рядок за id, перелік у картці (показує все з підписом), обґрунтування
 * плану (лише збережені в нас файли — скріна з Kommo там бути не може), власні запити черги скрінів. Порожній простір —
 * провал: читачів щонайменше чотири.
 * 🧨 Червоніє, якщо новий запит рахує «контакт був» без правила — тоді фото ТТН з Kommo знову стане контактом.
 */
test("#3843 УСІ ЧИТАЧІ КОНТАКТІВ: правило «лише переписка» або названа причина; порожній перелік — провал", () => {
  const found: string[] = [];
  const bad: string[] = [];
  for (const f of backendFiles()) {
    const src = readFileSync(f, "utf8");
    const re = /(FROM|JOIN)\s+client_contacts\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const start = src.lastIndexOf("`", m.index);
      const end = src.indexOf("`", m.index);
      const sql = src.slice(start, end);
      const rel = path.relative(ROOT, f);
      found.push(rel);
      const why =
        /countsAsContactSql\(/.test(sql) ? "правило" :
        /WHERE (c\.)?id = \$1/.test(sql) || /JOIN client_contacts \w+ ON \w+\.id = \w+\.contact_id/.test(sql) ? "за id" :
        /channel = 'kommo' AND ai_status IN/.test(sql) ? "черга скрінів" :
        /FROM client_contacts c LEFT JOIN users u/.test(sql) ? "перелік у картці" :
        // Умова відбору (`AND … IS NOT NULL`), а не колонка у SELECT: «є файл» у переліку полів правила не замінює.
        /AND (\w+\.)?stored_name IS NOT NULL/.test(sql) ? "лише збережені файли" :
        rel === "backend/src/core/kommoScreens.ts" ? "черга скрінів" : null;
      if (!why) bad.push(`${rel}: …${sql.slice(0, 120).replace(/\s+/g, " ")}…`);
    }
  }
  assert.ok(found.length >= 4, `🔴 знайдено лише ${String(found.length)} читачів контактів — сканер зламався (порожньо ≠ чисто)`);
  assert.ok(found.includes("backend/src/routes/dashboard.ts") && found.includes("backend/src/core/planBasis.ts"), "🔴 сканер не бачить відомих читачів");
  assert.deepEqual(bad, [], `🔴 читач контактів без правила «лише переписка»:\n${bad.join("\n")}`);
});

/**
 * #3844 — ПРОВОДКА РОУТІВ. Скрін з Kommo віддається з Kommo ПІСЛЯ перевірки «хто бачить клієнта»; видалити його з
 * дашборда не можна (живе в угоді); «Останній контакт» бере `countsAsContactSql`; картка позначає, звідки контакт і чи він
 * рахується, тим самим правилом (`chat`). Фронт: скрін з Kommo не закріплюється обґрунтуванням (файла в нас немає).
 * 🧨 Червоніє, якщо файл віддаватиметься до перевірки скоупу, якщо скрін з Kommo можна видалити, або «Останній контакт»
 * знову рахуватиме будь-яку картинку.
 */
test("#3844 ПРОВОДКА РОУТІВ: файл — після скоупу; видалити не можна; «Останній контакт» — за правилом; фронт", () => {
  const d = codeOnly(read("backend/src/routes/dashboard.ts"));
  const file = d.slice(d.indexOf('dashboardRouter.get("/client-contacts/:id/file"'), d.indexOf('dashboardRouter.delete("/client-contacts/:id"'));
  assert.ok(file.length > 100, "🔴 роуту файлу не знайдено");
  assert.ok(file.indexOf("canSeeClient(") > 0 && file.indexOf("canSeeClient(") < file.indexOf("kommoDriveFile("), "🔴 файл з Kommo віддається до перевірки скоупу");
  const del = d.slice(d.indexOf('dashboardRouter.delete("/client-contacts/:id"'), d.indexOf('dashboardRouter.get("/client-card"'));
  assert.ok(del.indexOf("row.channel === KOMMO_CHANNEL") > 0 && del.indexOf("row.channel === KOMMO_CHANNEL") < del.indexOf("DELETE FROM client_contacts"),
    "🔴 скрін з Kommo можна видалити з дашборда");
  assert.match(d, /FROM client_contacts cc WHERE cc\.client_key = ANY\(\$1\) AND \$\{countsAsContactSql\("cc"\)\}/, "🔴 «Останній контакт» без правила «лише переписка»");
  assert.match(d, /countsAsContact: !fromKommo \|\| r\.ai_kind === "chat"/, "🔴 картка позначає «рахується» не тим правилом");
  const card = codeOnly(read("frontend/src/pages/dashboard/sections/ClientCardPanel.tsx"));
  assert.match(card, /k\.hasFile && k\.source !== "kommo" && \(card\.planBasis/, "🔴 скрін з Kommo можна закріпити обґрунтуванням");
  assert.match(card, /screenAiLine\(k\)/, "🔴 картка не показує, що прочитав AI");
  assert.match(read("frontend/src/api.ts"), /if \(key === "kommo"\) return "Скрін у Kommo";/, "🔴 канал скріна без назви на екрані");
});

/**
 * #3845 — ПРОВОДКА ДЖОБИ. Крон «20,50» і нагляд 30 хв збігаються; перший прохід — від дати старту; кожен виклик AI
 * пишеться в журнал витрат своєю операцією й рахується в СПІЛЬНУ стелю Gemini (`monthSpend` провайдера + `llmMonthCapUsd`);
 * без ключа чи цін — AI не кличеться. Лог називає обсяг.
 * 🧨 Червоніє, якщо джоба витрачатиме AI мимо журналу чи стелі, або розійдуться крон і нагляд (мовчання не помітять).
 */
test("#3845 ПРОВОДКА ДЖОБИ: крон == нагляд; старт 11.11; журнал витрат і спільна стеля; без ключа — без AI", () => {
  const idx = codeOnly(read("backend/src/index.ts"));
  assert.match(idx, /cron\.schedule\("20,50 \* \* \* \*", \(\) => \{\s*if \(isKommoPaused\(\)\) return;\s*void runJob\("syncKommoScreens", \(\) => syncKommoScreens\(\)\);/);
  assert.match(read("backend/src/jobs/monitoredJobs.ts"), /\{ name: "syncKommoScreens", everyMin: 30,/, "🔴 нагляд не збігається з кроном");
  const j = codeOnly(read("backend/src/jobs/syncKommoScreens.ts"));
  assert.match(j, /Math\.max\(SCREENS_FROM_UNIX, last \?/, "🔴 перший прохід не від дати старту");
  assert.match(j, /const spend = await monthSpend\(pool, LLM_PROVIDER, new Date\(\)\);/, "🔴 стеля не спільна з рештою Gemini");
  assert.match(j, /spent \+ estimate > llmMonthCapUsd/, "🔴 стеля не перевіряється перед викликом");
  assert.ok(j.indexOf("recordScreenResult(") > j.indexOf("geminiGenerate("), "🔴 результат AI не пишеться разом із витратою");
  assert.ok(j.indexOf("if (!key)") < j.indexOf("geminiGenerate("), "🔴 AI кличеться без ключа");
  assert.match(j, /нових контактів \$\{String\(report\.inserted\)\}/, "🔴 лог не називає обсяг");
  assert.equal(SCREEN_OPERATION, "screen_analysis");
});

/**
 * #3846 🪞 — НА СПРАВЖНІЙ СХЕМІ. Міграція лягає; скріни вставляються з клієнтом угоди й автором-менеджером; повтор тієї
 * самої нотатки — не новий рядок; угода без клієнта — числом, не рядком; CHECK не пускає `kommo` без нотатки; результат AI
 * пишеться разом із двома рядками журналу; «Останній контакт» (той самий SQL-вираз) бачить ручний контакт і переписку, а
 * документ — ні; черга віддає лише непрочитані.
 * 🧨 Червоніє, якщо зламати SQL вставки, унікальність, CHECK, запис витрати чи предикат (SQL у шаблоні не типізується).
 */
test("#3846 🪞 ЖИВА СХЕМА: вставка, повтор, без клієнта, CHECK, витрата + результат, «контакт» лише переписка", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) { t.skip(skipReason(scratch)); return; }
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(read("backend/src/db/schema.sql"));
    await c.query(read("backend/src/db/schema.sql")); // повторне застосування — без помилок
    await c.query(`INSERT INTO teams (id,name) VALUES (1,'РПК') ON CONFLICT (id) DO NOTHING`);
    await c.query(`INSERT INTO managers (id,name,team_id,is_active,kommo_user_id) VALUES (10,'Ліля',1,true,555) ON CONFLICT (id) DO NOTHING`);
    await c.query(`INSERT INTO users (id,email,password_hash,role,manager_id,is_active) VALUES (7,'l@x','x','manager',10,true)`);
    await c.query(`INSERT INTO deals (kommo_id,name,manager_id,pipeline_id,status_id,price,client_key,client_key_raw,client_name,created_at_kommo)
                   VALUES (100,'угода',10,8921932,1,0,'марвік','марвік','Марвік',now()), (101,'без клієнта',10,8921932,1,0,NULL,NULL,NULL,now())`);
    const S = await import("./kommoScreens.js");
    const row = (noteId: number, dealId: number, file: string) => ({ noteId, dealId, fileUuid: file, fileName: `${file}.png`, mime: "image/png",
      authorKommoId: 555, createdAtUnix: S.SCREENS_FROM_UNIX + noteId });
    const a = await S.insertScreens(c, [row(1, 100, "f1"), row(2, 100, "f2"), row(3, 101, "f3")]);
    assert.deepEqual(a, { inserted: 2, noClient: 1 }, "🔴 вставка скрінів: не ті числа");
    assert.deepEqual(await S.insertScreens(c, [row(1, 100, "f1")]), { inserted: 0, noClient: 0 }, "🔴 повтор нотатки дав новий рядок");
    const rows = (await c.query<{ client_key: string; created_by: number; ai_status: string }>(
      `SELECT client_key, created_by, ai_status FROM client_contacts WHERE channel = 'kommo' ORDER BY kommo_note_id`)).rows;
    assert.deepEqual(rows, [{ client_key: "марвік", created_by: 7, ai_status: "queued" }, { client_key: "марвік", created_by: 7, ai_status: "queued" }]);
    await assert.rejects(c.query(`INSERT INTO client_contacts (client_key, channel) VALUES ('марвік', 'kommo')`), /client_contacts_kommo_shape/,
      "🔴 CHECK пустив скрін без нотатки Kommo");
    await assert.rejects(c.query(`INSERT INTO client_contacts (client_key, channel, kommo_note_id, kommo_deal_id, kommo_file_uuid, ai_status)
                                  VALUES ('марвік', 'viber', 9, 100, 'x', 'queued')`), /client_contacts_kommo_shape/, "🔴 ручний контакт із полями Kommo");
    const q = await S.queuedScreens(c, 10);
    assert.equal(q.length, 2);
    const at = new Date("2026-11-11T10:00:00Z");
    await S.recordScreenResult(c, { id: q[0].id, noteId: q[0].noteId, at, provider: "google", inputTokens: 1500, outputTokens: 100, unitSuffix: "",
      usdPerInputToken: 0.75e-6, usdPerOutputToken: 3.75e-6, verdict: { ok: true, kind: "chat", summary: "Домовились на пн." } });
    await S.recordScreenResult(c, { id: q[1].id, noteId: q[1].noteId, at, provider: "google", inputTokens: 1500, outputTokens: 50, unitSuffix: "",
      usdPerInputToken: 0.75e-6, usdPerOutputToken: 3.75e-6, verdict: { ok: true, kind: "document", summary: null } });
    const led = (await c.query<{ n: number; usd: string }>(`SELECT count(*)::int AS n, sum(usd)::text AS usd FROM ai_spend_ledger WHERE operation = 'screen_analysis'`)).rows[0];
    assert.equal(led.n, 4, "🔴 витрата AI не записана (по два рядки на скрін)");
    assert.ok(Math.abs(Number(led.usd) - (3000 * 0.75e-6 + 150 * 3.75e-6)) < 1e-9, `🔴 сума витрати: ${led.usd}`);
    assert.equal((await S.queuedScreens(c, 10)).length, 0, "🔴 прочитаний скрін лишився в черзі");
    await c.query(`INSERT INTO client_contacts (client_key, channel, note, created_at) VALUES ('ручний', 'viber', 'дзвонив', now())`);
    const seen = (await c.query<{ client_key: string; ai_kind: string | null }>(
      `SELECT cc.client_key, cc.ai_kind FROM client_contacts cc WHERE ${S.countsAsContactSql("cc")} ORDER BY cc.client_key, cc.ai_kind`)).rows;
    assert.deepEqual(seen, [{ client_key: "марвік", ai_kind: "chat" }, { client_key: "ручний", ai_kind: null }],
      "🔴 «контакт» на справжній БД: документ зараховано або ручний/переписку загублено");
  } finally { await c.end(); }
});

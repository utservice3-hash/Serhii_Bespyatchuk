import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { skipReason } from "../db/scratchDb.js";
import {
  parseRingostatLink, planAgreementChange, callLinkState, isReschedule,
  callFactsLateral, rescheduleCountSql, toCallFacts, type CallLinkState,
} from "./receivableCallLink.js";

/**
 * 📞 РОЗМОВА БІЛЯ ДАТИ ДОМОВЛЕНОСТІ (задача 4631, 09.10.2026). Посилання → дзвінок, правило «нова дата — нова розмова»,
 * журнал перенесень, стан колонки, межі роутів.
 */
const srcOf = (rel: string) => fileURLToPath(new URL(rel, import.meta.url).href.replace("/dist/", "/src/"));
const SRC = (p: string) => readFileSync(srcOf(`../${p}`), "utf8");
const FE = (p: string) => readFileSync(srcOf(`../../../frontend/src/${p}`), "utf8");

/** Тіло обробника `router.<method>("<path>", …)` — до наступного `dashboardRouter.`. Межа змістова, не за довжиною. */
function handlerBody(src: string, method: string, route: string): string {
  const start = src.indexOf(`dashboardRouter.${method}("${route}"`);
  assert.ok(start >= 0, `🔴 обробника ${method.toUpperCase()} ${route} не знайдено — перевірка не має права мовчки пропускатись`);
  const next = src.indexOf("\ndashboardRouter.", start + 10);
  return src.slice(start, next < 0 ? undefined : next);
}

test("#1530 ПОСИЛАННЯ RINGOSTAT: запис → номер дзвінка; голий номер — теж; інше посилання чи текст — відмова з поясненням", () => {
  const uid = "ua18_-1791545397.2215926";
  const real = `https://app.ringostat.com/recordings/${uid}.wav?token=fe60f9f4e172935459b9053daf647f20`;
  assert.deepEqual(parseRingostatLink(real), { ok: true, uniqueid: uid }, "🔴 справжнє посилання на запис не розпізнано");
  assert.deepEqual(parseRingostatLink(`  ${real}\n`), { ok: true, uniqueid: uid }, "🔴 пробіли навколо зламали розбір");
  assert.deepEqual(parseRingostatLink(`https://app.ringostat.com/recordings/${uid}.mp3`), { ok: true, uniqueid: uid });
  assert.deepEqual(parseRingostatLink(uid), { ok: true, uniqueid: uid }, "🔴 голий номер дзвінка не прийнято");
  const bad = [
    "https://app.ringostat.com/calls/journal",
    "https://app.ringostat.com/recordings/.wav",
    "https://evil.example.com/recordings/ua18_-1791545397.2215926.wav",
    "домовились на пʼятницю",
    "",
    "x".repeat(2001),
  ];
  for (const b of bad) {
    const r = parseRingostatLink(b);
    assert.equal(r.ok, false, `🔴 прийнято як посилання на запис: «${b.slice(0, 60)}»`);
    if (!r.ok) assert.ok(r.error.length > 10, "🔴 відмова без пояснення");
  }
});

test("#1530b НОВА ДАТА — НОВА РОЗМОВА: дата змінилась без посилання — розмова знімається й пишеться перенесення; та сама дата — лишається", () => {
  const callA = { uniqueid: "ua1_-1.1", url: "u" };
  const callB = { uniqueid: "ua2_-2.2", url: "v" };
  const prev = { exists: true, dealId: 7, dueDate: "2026-10-07", call: callA };
  // перенесли без посилання
  let r = planAgreementChange(prev, { dealId: 7, dueDate: "2026-10-14", call: undefined });
  assert.equal(r.call, null, "🔴 стара розмова лишилась біля нової дати");
  assert.deepEqual(r.log, { oldDate: "2026-10-07", newDate: "2026-10-14", callUniqueid: null });
  assert.equal(isReschedule(r.log!.oldDate, r.log!.newDate), true);
  // перенесли з новим посиланням
  r = planAgreementChange(prev, { dealId: 7, dueDate: "2026-10-14", call: callB });
  assert.deepEqual(r.call, callB);
  assert.deepEqual(r.log, { oldDate: "2026-10-07", newDate: "2026-10-14", callUniqueid: callB.uniqueid });
  // ДЗЕРКАЛО: та сама дата, правка коментаря — розмова лишається, журнал мовчить
  r = planAgreementChange(prev, { dealId: 7, dueDate: "2026-10-07", call: undefined });
  assert.deepEqual(r.call, callA, "🔴 правка коментаря зняла розмову");
  assert.equal(r.log, null, "🔴 журнал записав крок, хоча нічого не змінилось");
  // та сама дата, додали розмову — крок журналу, але НЕ перенесення
  r = planAgreementChange({ ...prev, call: null }, { dealId: 7, dueDate: "2026-10-07", call: callB });
  assert.deepEqual(r.log, { oldDate: "2026-10-07", newDate: "2026-10-07", callUniqueid: callB.uniqueid });
  assert.equal(isReschedule(r.log!.oldDate, r.log!.newDate), false, "🔴 додана розмова порахувалась перенесенням");
  // явно прибрали
  r = planAgreementChange(prev, { dealId: 7, dueDate: "2026-10-07", call: null });
  assert.equal(r.call, null);
  assert.ok(r.log);
  // нова угода — не перенесення, стара розмова не переїжджає
  r = planAgreementChange(prev, { dealId: 8, dueDate: "2026-10-14", call: undefined });
  assert.equal(r.call, null, "🔴 розмова попередньої угоди переїхала на нову");
  assert.deepEqual(r.log, { oldDate: null, newDate: "2026-10-14", callUniqueid: null });
  assert.equal(isReschedule(r.log!.oldDate, r.log!.newDate), false, "🔴 нова угода порахувалась перенесенням");
  // перший запис без дати й без розмови — журнал мовчить
  r = planAgreementChange({ exists: false, dealId: null, dueDate: null, call: null }, { dealId: null, dueDate: null, call: undefined });
  assert.equal(r.log, null);
  // перша дата — крок, але не перенесення
  r = planAgreementChange({ exists: false, dealId: null, dueDate: null, call: null }, { dealId: 7, dueDate: "2026-10-07", call: undefined });
  assert.deepEqual(r.log, { oldDate: null, newDate: "2026-10-07", callUniqueid: null });
  assert.equal(isReschedule(null, "2026-10-07"), false);
  assert.equal(isReschedule("2026-10-07", null), false, "🔴 зняття дати порахувалось перенесенням");
});

test("#1530c МЕЖІ: запис домовленості — роль першою дією, далі СКОУП ДО запису; запис розмови — ролі першого дотику + лише прикріплений дзвінок", () => {
  const src = SRC("routes/dashboard.ts");
  const put = handlerBody(src, "put", "/receivables/note");
  const gate = put.indexOf("canWriteAgreement(auth)");
  const scope = put.indexOf("receivableInScope(auth, clientKey)");
  const write = put.indexOf("INSERT INTO receivable_notes");
  assert.ok(gate >= 0 && scope > gate && write > scope,
    "🔴 PUT /receivables/note: роль → скоуп → запис порушено (менеджер записав би чужому клієнту)");
  assert.ok(put.indexOf("req.body") > gate, "🔴 тіло читається ДО перевірки ролі — 403 стане 400 (гарантія #11)");
  // ДЗЕРКАЛО: менеджер дозволений, тобто правило не звелось до «тімлід або адмін»
  const fn = src.slice(src.indexOf("function canWriteAgreement"), src.indexOf("function canWriteAgreement") + 200);
  assert.match(fn, /isAdminOrLead\(auth\)\s*\|\|\s*auth\.role === "manager"/, "🔴 менеджер знову не може писати домовленість (рішення Юлі 09.10)");
  const rec = handlerBody(src, "get", "/receivables/call-recording");
  const rGate = rec.indexOf("transcriptAllowed(auth, FIRST_TOUCH_TRANSCRIPT_ROLES)");
  const rScope = rec.indexOf("receivableInScope(auth, clientKey)");
  const rLinked = rec.indexOf("receivableLinkedCall(clientKey, uniqueid)");
  const rFetch = rec.indexOf("fetchCallRecording(");
  assert.ok(rGate >= 0 && rScope > rGate && rLinked > rScope && rFetch > rLinked,
    "🔴 /receivables/call-recording віддає байти без перевірки ролі, скоупу або привʼязки дзвінка до клієнта");
  // Сама привʼязка: зараз (запис домовленості) АБО в журналі — обидві гілки в спільній функції.
  const helper = src.slice(src.indexOf("async function receivableLinkedCall"), src.indexOf("async function receivableLinkedCall") + 900);
  assert.match(helper, /WHERE n\.call_uniqueid = \$2/, "🔴 привʼязка не перевіряє поточний запис домовленості");
  assert.match(helper, /FROM receivable_date_log l WHERE l\.client_key = \$1 AND l\.call_uniqueid = \$2/, "🔴 привʼязка не перевіряє журнал перенесень");
  const log = handlerBody(src, "get", "/receivables/date-log");
  assert.ok(log.indexOf("receivableInScope(auth, clientKey)") >= 0 && log.indexOf("receivableInScope") < log.indexOf("FROM receivable_date_log"),
    "🔴 журнал перенесень читається без скоупу");
});

/** Підняти одноразовий кластер зі СПРАВЖНЬОЮ схемою. */
async function withScratch(t: { skip: (m: string) => void },
  body: (q: (s: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) => Promise<void>): Promise<void> {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    await body(((s: string, p?: unknown[]) => c.query(s, p)) as never);
  } finally {
    await c.end().catch(() => {});
  }
}

test("#1530d ЖИВА СХЕМА: «номер клієнта» — за звʼязкою дзвінка АБО за телефоном контакту; лічильник — лише перенесення поточної угоди", async (t) => {
  await withScratch(t, async (q) => {
    // Клієнт «агро»: угода 501 з контактом 9001 (телефон 380671112233). Чужий клієнт «інший»: угода 502, контакт 9002.
    await q(`INSERT INTO deals (kommo_id, client_key, pipeline_id, status_id, price) VALUES (501, 'агро', 1, 1, 0), (502, 'інший', 1, 1, 0)`);
    await q(`INSERT INTO deal_contacts (deal_kommo_id, contact_id) VALUES (501, 9001), (502, 9002)`);
    await q(`INSERT INTO contact_phones (contact_id, phone) VALUES (9001, '380671112233'), (9002, '380509998877')`);
    await q(`INSERT INTO ringostat_calls (uniqueid, calldate, call_type, billsec, client_phone, client_key) VALUES
      ('ua1_-1.1', '2026-10-08T08:42:00Z', 'out', 134, '380671112233', NULL),   -- номер з контакту, звʼязки немає
      ('ua1_-2.2', '2026-10-08T09:00:00Z', 'out', 65,  '380509998877', 'інший'), -- номер іншого клієнта
      ('ua1_-3.3', '2026-10-08T10:00:00Z', 'out', 40,  '380631234567', 'агро')`); // звʼязаний із клієнтом, телефону в контактах немає
    const facts = async (uid: string) => {
      const r = await q(`SELECT cf.* FROM (SELECT $1::text AS call_uniqueid) n LEFT JOIN LATERAL (${callFactsLateral("n", "'агро'")}) cf ON true`, [uid]);
      return toCallFacts(r.rows[0] as never);
    };
    assert.equal((await facts("ua1_-1.1"))?.sameClient, true, "🔴 номер із контактів клієнта прочитано як «інший номер»");
    assert.equal((await facts("ua1_-2.2"))?.sameClient, false, "🔴 дзвінок іншому клієнту прочитано як розмову з цим");
    assert.equal((await facts("ua1_-3.3"))?.sameClient, true, "🔴 дзвінок, звʼязаний із клієнтом, прочитано як «інший номер»");
    assert.equal(await facts("ua9_-9.9"), null, "🔴 неіснуючий дзвінок дав факти");
    const f1 = await facts("ua1_-1.1");
    assert.equal(f1?.billsec, 134);
    assert.equal(f1?.calledAt, "2026-10-08T08:42:00Z");

    // Журнал: угода 501 — перша дата, два перенесення, додана розмова; угода 400 (стара) — одне перенесення.
    await q(`INSERT INTO receivable_notes (client_key, due_date, deal_id, call_uniqueid) VALUES ('агро', '2026-10-14', 501, 'ua1_-1.1')`);
    await q(`INSERT INTO receivable_date_log (client_key, deal_id, old_date, new_date) VALUES
      ('агро', 400, '2026-09-01', '2026-09-10'),
      ('агро', 501, NULL, '2026-10-07'),
      ('агро', 501, '2026-10-07', '2026-10-10'),
      ('агро', 501, '2026-10-10', '2026-10-14'),
      ('агро', 501, '2026-10-14', '2026-10-14'),
      ('агро', 501, '2026-10-14', NULL)`);
    const cnt = await q(`SELECT ${rescheduleCountSql("n")} AS c FROM receivable_notes n WHERE n.client_key = 'агро'`);
    assert.equal(Number(cnt.rows[0].c), 2, "🔴 «переносили N» рахує не лише перенесення поточної угоди");
    // ДЗЕРКАЛО: запис без угоди рахує по всьому клієнту — і бачить перенесення старої угоди теж
    await q(`UPDATE receivable_notes SET deal_id = NULL WHERE client_key = 'агро'`);
    const all = await q(`SELECT ${rescheduleCountSql("n")} AS c FROM receivable_notes n WHERE n.client_key = 'агро'`);
    assert.equal(Number(all.rows[0].c), 3);
  });
});

test("#1530e СТАН КОЛОНКИ: «звідки дата» збігається з `agreementView` фронту; без розмови — жовтий; дзвінок без розмови й інший номер — окремо", async () => {
  const VIEW = "../../../frontend/src/pages/dashboard/receivablesView.ts";
  const V = (await import(VIEW)) as {
    agreementView: (p: Record<string, unknown>) => { source: "dashboard" | "crm" | "none" };
  };
  const call = { calledAt: "2026-10-08T08:42:00Z", billsec: 134, managerName: "Семенюк", sameClient: true, ai: null, aiPending: false };
  const now = new Date("2026-10-09T09:00:00Z");
  const cases: { noteActual: boolean; noteDue: string | null; crmDue: string | null }[] = [];
  for (const noteActual of [true, false]) for (const noteDue of ["2026-10-14", null]) for (const crmDue of ["2026-10-20", null]) cases.push({ noteActual, noteDue, crmDue });
  for (const k of cases) {
    const st = callLinkState({ ...k, callUniqueid: null, call: null });
    const src = V.agreementView({ dueDate: k.noteDue, note: "", comment: null, noteUpdatedAt: null, noteActual: k.noteActual, crmDue: k.crmDue, now }).source;
    const expect: CallLinkState = src === "crm" ? "crm" : src === "none" ? "none" : "no_call";
    assert.equal(st, expect, `🔴 сервер і фронт по-різному кажуть, звідки дата: ${JSON.stringify(k)} → ${st} / ${src}`);
  }
  const own = { noteActual: true, noteDue: "2026-10-14", crmDue: null };
  assert.equal(callLinkState({ ...own, callUniqueid: "ua1_-1.1", call }), "ok");
  assert.equal(callLinkState({ ...own, callUniqueid: "ua1_-1.1", call: { ...call, sameClient: false } }), "other_number");
  assert.equal(callLinkState({ ...own, callUniqueid: "ua1_-1.1", call: { ...call, billsec: 0 } }), "no_talk", "🔴 недодзвін підтвердив дату");
  assert.equal(callLinkState({ ...own, callUniqueid: "ua1_-1.1", call: null }), "pending");
  assert.equal(callLinkState({ ...own, callUniqueid: null, call: null }), "no_call");
  // запис з попередньої угоди: його розмова дату НЕ підтверджує — дата з CRM
  assert.equal(callLinkState({ noteActual: false, noteDue: "2026-10-14", crmDue: "2026-10-20", callUniqueid: "ua1_-1.1", call }), "crm");
});

test("#1530f ФРОНТ: фільтр і лічильник чипа беруть стан сервера; жовтий рядок — рівно «дата без розмови»; домовленість пише й менеджер", async () => {
  const VIEW = "../../../frontend/src/pages/dashboard/receivablesView.ts";
  const V = (await import(VIEW)) as {
    passesFilters: (c: never, f: never) => boolean; EMPTY_FILTERS: Record<string, unknown>;
    callCounts: (all: never[]) => { no_call: number; crm: number };
    rescheduleLabel: (n: number | undefined) => string | null;
  };
  const row = (state: string) => ({ callLink: { state, uniqueid: null, call: null }, facts: { carrier: {}, entity: {}, aging: {}, carrierReasons: [] } });
  const all = ["no_call", "no_call", "crm", "ok", "none", "other_number"].map(row);
  const shown = (call: string) => all.filter((c) => V.passesFilters(c as never, { ...V.EMPTY_FILTERS, call } as never)).length;
  assert.equal(shown("no_call"), 2, "🔴 фільтр «дата без розмови» показує не ті рядки");
  assert.equal(shown("crm"), 1);
  assert.equal(shown(""), all.length, "🔴 порожній фільтр ховає рядки");
  assert.deepEqual(V.callCounts(all as never[]), { no_call: 2, crm: 1 }, "🔴 число на чипі розходиться з фільтром");
  assert.equal(V.rescheduleLabel(0), null);
  assert.equal(V.rescheduleLabel(1), "переносили 1 раз");
  assert.equal(V.rescheduleLabel(3), "переносили 3 рази");
  assert.equal(V.rescheduleLabel(12), "переносили 12 разів");
  const sec = FE("pages/dashboard/sections/ReceivablesSection.tsx");
  assert.match(sec, /className="recv-row" data-call=\{c\.callLink\?\.state \?\? "none"\}/, "🔴 рядок не несе стан розмови — жовтому нема за що вчепитись");
  const css = FE("index.css");
  assert.match(css, /tr\.recv-row\[data-call="no_call"\] > td \{ background:/, "🔴 жовтий рядок не привʼязаний до стану «дата без розмови»");
  assert.match(sec, /agreeFor === c\.clientKey && canEditAgreement && \(\s*<AgreementEditor/, "🔴 форма домовленості не за правом писати — менеджер не може записати або пише той, кому не можна");
  const dash = FE("pages/Dashboard.tsx");
  assert.match(dash, /canEditAgreement=\{receivablesPerms\.canEditAgreement\}/, "🔴 право писати домовленість не доходить із сервера");
});

test("#1531 РУБРИКА БОРГУ: відповідь перевіряється суворо — обіцянка без строку чи цитата без обіцянки не приймаються; нуль і порожнє стають null", async () => {
  const { validateDebt, debtLine, verifyDebtQuote } = await import("./receivableCallAi.js");
  const base = { summary: "s", manager_channel: "1", promised: true, amount_uah: 500000, pay_date: "2026-10-09", partial: true,
    remainder: "до 16-го", who: "Олена", delay_reason: "", next_step: "", quote: "500 тисяч у четвер" };
  const ok = validateDebt(base);
  assert.ok(ok.ok, "🔴 правильна відповідь відхилена");
  if (ok.ok) assert.equal(debtLine(ok.value), "обіцяли 500 000 ₴ до 09.10 · частина боргу · Олена", "🔴 у рядку «AI:» немає, з ким домовлялись (вимога ТЗ)");
  if (ok.ok) assert.equal(debtLine({ ...ok.value, who: "" }), "обіцяли 500 000 ₴ до 09.10 · частина боргу", "🔴 невідоме «з ким» вигадано або лишило хвіст");
  const none = validateDebt({ ...base, promised: false, amount_uah: 0, pay_date: "", quote: "", partial: false });
  assert.ok(none.ok);
  if (none.ok) {
    assert.equal(none.value.amount_uah, null, "🔴 «не назвали» (0) прочитано як суму");
    assert.equal(none.value.pay_date, null, "🔴 порожня дата прочитана як дата");
    assert.match(debtLine(none.value), /^без обіцянки оплати/);
  }
  assert.equal(validateDebt({ ...base, pay_date: "" }).ok, false, "🔴 «обіцяли» без строку прийнято");
  assert.equal(validateDebt({ ...base, promised: false }).ok, false, "🔴 цитата обіцянки без обіцянки прийнята");
  assert.equal(validateDebt({ ...base, pay_date: "09.10.2026" }).ok, false, "🔴 дата не в форматі YYYY-MM-DD прийнята");
  assert.equal(validateDebt({ ...base, amount_uah: -5 }).ok, false, "🔴 відʼємна сума прийнята");
  assert.equal(validateDebt({ ...base, manager_channel: "2" }).ok, false);
  const turns = [{ channel: 0, start: 0, end: 1, text: "500 тисяч у четвер", lang: null }, { channel: 1, start: 1, end: 2, text: "добре фіксую", lang: null }];
  if (ok.ok) {
    assert.equal(verifyDebtQuote(ok.value, turns).quote_found, true);
    assert.equal(verifyDebtQuote({ ...ok.value, quote: "у четвер добре фіксую" }, turns).quote_found, false, "🔴 цитата зі склейки двох каналів прийнята");
  }
});

test("#1531c КАРТКА РОЗМОВИ: текст — ролі першого дотику → скоуп → лише прикріплений дзвінок; фронт питає текст лише коли можна слухати", () => {
  const src = SRC("routes/dashboard.ts");
  const card = handlerBody(src, "get", "/receivables/call-card");
  const g = card.indexOf("transcriptAllowed(auth, FIRST_TOUCH_TRANSCRIPT_ROLES)");
  const sc = card.indexOf("receivableInScope(auth, clientKey)");
  const ln = card.indexOf("receivableLinkedCall(clientKey, uniqueid)");
  const q = card.indexOf("FROM ringostat_calls rc");
  assert.ok(g >= 0 && sc > g && ln > sc && q > ln, "🔴 /receivables/call-card віддає текст без ролі, скоупу або привʼязки дзвінка до клієнта");
  const dr = FE("pages/dashboard/sections/ReceivableCallDrawer.tsx");
  assert.match(dr, /if \(!playing \|\| !canListen\) \{ setCard\(null\); return; \}/, "🔴 картка питає текст розмови в ролі, якій слухати не можна");
  const sec = FE("pages/dashboard/sections/ReceivablesSection.tsx");
  assert.match(sec, /\{call\?\.ai && \(/, "🔴 рядок «AI:» зник зі списку");
});

test("#1532 ДОМОВЛЕНІСТЬ — БІЧНА ПАНЕЛЬ, ЯК В AI-АНАЛІЗІ: форма в панелі з розмовою; закривається кліком поза нею й Esc, клік не йде в рядок", () => {
  const ed = FE("pages/dashboard/sections/AgreementEditor.tsx");
  assert.match(ed, /return <ReceivableCallDrawer client=\{client\} view=\{view\} canListen=\{canListen\} editor=\{form\} onClose=\{onClose\} \/>;/,
    "🔴 домовленість знову відкривається поповером у клітинці, а не бічною панеллю");
  assert.ok(!/usePopoverClamp\(/.test(ed), "🔴 у панелі лишився затискач поповера");
  const dr = FE("pages/dashboard/sections/ReceivableCallDrawer.tsx");
  assert.match(dr, /<div className="hr-overlay" onClick=\{\(e\) => \{ e\.stopPropagation\(\); onClose\(\); \}\}>/,
    "🔴 клік поза панеллю її не закриває — або ще й розгортає рахунки клієнта (подія порталу пішла в рядок)");
  assert.match(dr, /onClick=\{\(e\) => e\.stopPropagation\(\)\}/, "🔴 клік усередині панелі закриває її або розгортає рядок");
  assert.match(dr, /if \(e\.key === "Escape"\) onClose\(\);/, "🔴 Esc не закриває панель");
  assert.match(dr, /\{editor \?\? <div style=\{box\}>/, "🔴 форма не стоїть у панелі (або роль без права бачить порожнечу замість домовленості)");
  // ДЗЕРКАЛО: роль без права писати теж відкриває панель — бачить домовленість і розмову, лише без форми.
  const sec = FE("pages/dashboard/sections/ReceivablesSection.tsx");
  assert.match(sec, /agreeFor === c\.clientKey && !canEditAgreement && \(\s*<ReceivableCallDrawer client=\{c\}/,
    "🔴 роль без права писати більше не бачить панелі — право мало б керувати дією, а не видимістю");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { clientTabGroup, tabOf, TAB_GROUP_RANK, YELLOW_DAYS } from "./clientTabs.js";
import { assignTeamIdFor, assignAllowed } from "../auth/mergeScope.js";
import { monthCell, CALLS_BY_MONTH_SQL } from "./clientCalls.js";
import { basisTarget, basisMonth, BASIS_BELONGS_SQL, BASIS_UPSERT_SQL, BASIS_CLEAR_SQL, BASIS_FOR_MONTH_SQL, shapeBasis } from "./planBasis.js";
import { skipReason } from "../db/scratchDb.js";

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const SECTIONS = "frontend/src/pages/dashboard/sections";

/**
 * 🗂 #810–#812b — ТЗ Юлі 22.09.2026, блок 3, прохід 1 (задача 4312): вкладки, порядок «Всі»,
 * колонки таблиці, згорнуті тижні, передача клієнта тімлідом.
 */

test("#810 clientTabGroup: активний до/після 30 днів, сплячий і втрачений — реактивація; порядок постійні → жовті → реактивація", () => {
  // По обидва боки межі «жовтого» (правило 11).
  assert.equal(clientTabGroup("active", YELLOW_DAYS - 1), "regular", "🔴 29 днів уже «жовтий»");
  assert.equal(clientTabGroup("active", YELLOW_DAYS), "yellow", "🔴 30 днів ще не «жовтий» — розійдеться з фоном рядка");
  assert.equal(clientTabGroup("active", null), "regular", "🔴 клієнт без дати замовлення став «жовтим»");
  // Реактивація — за СТАНОМ, а не за днями: сплячий на 10-му дні теж у реактивації.
  assert.equal(clientTabGroup("sleeping", 10), "react", "🔴 сплячий потрапив у «Постійні»");
  assert.equal(clientTabGroup("lost", 400), "react");
  assert.equal(clientTabGroup("sleeping", null), "react");
  // Вкладка: «жовтий» — у «Постійних», реактивація — лише в «Реактивації».
  assert.equal(tabOf("regular"), "regular");
  assert.equal(tabOf("yellow"), "regular", "🔴 «жовтий» випав із «Постійних»");
  assert.equal(tabOf("react"), "react");
  assert.ok(TAB_GROUP_RANK.regular < TAB_GROUP_RANK.yellow && TAB_GROUP_RANK.yellow < TAB_GROUP_RANK.react,
    "🔴 порядок у «Всі» не «постійні → жовті → реактивація»");
});

test("#810b ФРОНТ НЕ МАЄ ВЛАСНОГО ПРАВИЛА ВКЛАДОК: фільтр, порядок і жовтий фон — з поля сервера", () => {
  const list = read(`${SECTIONS}/ClientPlansSection.tsx`);
  assert.match(list, /tab === "regular" && c\.tabGroup === "react"\) return false/, "🔴 вкладка «Постійні» фільтрує не за групою сервера");
  assert.match(list, /tab === "react" && c\.tabGroup !== "react"\) return false/, "🔴 вкладка «Реактивація» фільтрує не за групою сервера");
  assert.match(list, /data\.tabGroupRank\[a\.tabGroup\] - data\.tabGroupRank\[b\.tabGroup\]/, "🔴 порядок «Всі» не з рангів сервера");
  assert.match(list, /const risk = c\.tabGroup === "yellow";/, "🔴 жовтий фон рядка рахується не тією групою, що вкладки");
  assert.doesNotMatch(list, /const risk = [^;]*lastOrderDays/, "🔴 у фронті знову власний поріг «жовтого» — друга редакція правила");
  assert.doesNotMatch(list, /stateFilter/, "🔴 повернувся ряд «Стан:» поруч із вкладками — дві осі на одне питання");
  const dash = read("backend/src/routes/dashboard.ts");
  assert.match(dash, /tabGroup: clientTabs\.clientTabGroup\(stateOf\(c\.client_key\), dayOf\(c\.last_paid\)\)/,
    "🔴 рядок /client-plans не несе групи з ядра — або група рахується не від того стану, що чип");
  assert.match(dash, /tabGroupRank: clientTabs\.TAB_GROUP_RANK,/, "🔴 ранги груп не приходять із сервера");
});

/**
 * #811 — КОЛОНКИ ТАБЛИЦІ СХОДЯТЬСЯ. До блоку 3 у шапці було 9 колонок, а підсумок і розгорнута
 * картка — на 8 (заміряно 28.09.2026): дані підсумку стояли під чужими заголовками. Тепер
 * «Історія · 6 міс» прибрано, а тижні згортаються — і рахувати треба в ОБОХ станах.
 */
test("#811 КОЛОНКИ СХОДЯТЬСЯ: шапка == рядок == підсумок у обох станах тижнів; «Історії · 6 міс» немає", () => {
  const src = read(`${SECTIONS}/ClientPlansSection.tsx`);
  assert.doesNotMatch(src, /Історія · 6 міс|<Spark /, "🔴 колонка «Історія · 6 міс» повернулась (ТЗ 22.09, п.3.4)");
  assert.doesNotMatch(src, /colSpan=\{\d+\}/, "🔴 colSpan знову числом — розійдеться з кількістю колонок при згорнутих тижнях");
  const count = (block: string, tag: string) => {
    const all = (block.match(new RegExp(`<${tag}[ >]`, "g")) ?? []).length;
    const cond = (block.match(new RegExp(`\\{weeksOpen && (?:\\(\\s*)?<${tag}[ >]`, "g")) ?? []).length;
    return { open: all, closed: all - cond, cond };
  };
  const head = src.slice(src.indexOf("<thead>"), src.indexOf("</thead>"));
  const foot = src.slice(src.indexOf("<tfoot>"), src.indexOf("</tfoot>"));
  const rs = src.indexOf("<tr style={{ background: risk");
  assert.ok(rs > 0, "🔴 гейт втратив предмет: рядка клієнта не знайдено");
  const row = src.slice(rs, src.indexOf("</tr>", rs));
  const h = count(head, "th"), f = count(foot, "td"), r = count(row, "td");
  assert.ok(h.open > 0 && r.open > 0 && f.open > 0, "🔴 гейт втратив предмет: шапку, рядок чи підсумок не знайдено");
  assert.deepEqual([r.open, f.open], [h.open, h.open], `🔴 ТИЖНІ РОЗГОРНУТІ: шапка ${h.open}, рядок ${r.open}, підсумок ${f.open}`);
  assert.deepEqual([r.closed, f.closed], [h.closed, h.closed], `🔴 ТИЖНІ ЗГОРНУТІ: шапка ${h.closed}, рядок ${r.closed}, підсумок ${f.closed}`);
  assert.equal(h.cond, 1, "🔴 тижні в шапці не залежать від перемикача (або залежить ще щось)");
  // Рядок-шапка команди/менеджера: назва на GROUP_LEAD_COLS колонок + решта клітинок == колонок.
  const gr = src.slice(src.indexOf("function GroupRow("), src.indexOf("</tr>", src.indexOf("function GroupRow(")));
  const lead = Number(/const GROUP_LEAD_COLS = (\d+);/.exec(src)?.[1]);
  assert.ok(lead > 0 && /colSpan=\{GROUP_LEAD_COLS\}/.test(gr), "🔴 назва рівня більше не займає GROUP_LEAD_COLS колонок");
  const g = count(gr, "td");
  assert.deepEqual([lead + g.open - 1, lead + g.closed - 1], [h.open, h.closed],
    `🔴 ШАПКА КОМАНДИ/МЕНЕДЖЕРА: ${lead + g.closed - 1}/${lead + g.open - 1} колонок проти ${h.closed}/${h.open} — план ляже не під «План»`);
  // План і факт рівня стоять під своїми заголовками: перед «План» рівно GROUP_LEAD_COLS колонок.
  const heads = [...head.matchAll(/<th[ >][^>]*>([^<]*)</g)].map((m) => m[1]);  // `<th[ >]`, бо інакше ловиться сам `<thead>`
  assert.equal(heads.indexOf("План (міс)"), lead, "🔴 підсумок плану рівня стоїть не під «План»");
  assert.match(src, new RegExp(`const colCount = weeksOpen \\? ${h.open} : ${h.closed};`),
    `🔴 colCount не дорівнює кількості колонок (${h.closed}/${h.open}) — картка й порожній стан поїдуть`);
  // 📅 Згорнуто за замовчуванням (п.3.5): без збереженого вибору — false.
  assert.match(src, /localStorage\.getItem\("clientPlans\.weeksOpen"\) === "1"; \} catch \{ return false; \}/,
    "🔴 тижні більше не згорнуті за замовчуванням");
});

test("#812 КОГО ПОКАЗАТИ У ПЕРЕДАЧІ: КВП/адмін — усіх, тімлід — свою команду, без команди — нікого; межа та сама, що в assignAllowed", () => {
  assert.equal(assignTeamIdFor({ canAll: true, role: "admin", teamId: 5 }), null, "🔴 адміну/КВП звузили список");
  assert.equal(assignTeamIdFor({ canAll: false, role: "team_lead", teamId: 6 }), 6, "🔴 тімлід бачить не свою команду");
  assert.equal(assignTeamIdFor({ canAll: false, role: "team_lead", teamId: null }), -1, "🔴 тімлід без команди бачить УСІХ — null відкрив би всіх");
  assert.equal(assignTeamIdFor({ canAll: false, role: "manager", teamId: 6 }), -1);
  // 🪞 Список і сервер кажуть одне: кого показали — того сервер і пропустить.
  const t = assignTeamIdFor({ canAll: false, role: "team_lead", teamId: 6 })!;
  assert.equal(assignAllowed({ canAll: false, leadTeamId: 6, clientTeamId: 6, targetTeamId: t }), true, "🔴 показали менеджера, якого сервер не пропустить");
  assert.equal(assignAllowed({ canAll: false, leadTeamId: 6, clientTeamId: 6, targetTeamId: 7 }), false, "🔴 сервер пропускає чужу команду");
});

test("#812b ПЕРЕДАЧА — КНОПКОЮ В КАРТЦІ, клієнт підставлений, список за командою з сервера", () => {
  const card = read(`${SECTIONS}/ClientCardPanel.tsx`);
  assert.match(card, /\{card\.canAssign && \(\s*<div style=\{\{ marginTop: 10 \}\}>\s*<button type="button" onClick=\{\(\) => setAssigning/,
    "🔴 кнопки «Передати клієнта» немає — передача знову захована");
  const det = card.indexOf("<details"); const btn = card.indexOf("setAssigning((v) => !v)");
  assert.ok(det > 0 && btn > 0 && btn < det, "🔴 передача знову всередині згорнутого блоку обʼєднання");
  assert.match(card, /<ManagerPanel clients=\{\[\]\} teamId=\{card\.assignTeamId \?\? null\}\s*preset=\{\{ clientKey: card\.clientKey, clientName: card\.clientName, managerName: card\.managerName \}\}/,
    "🔴 форма передачі в картці не отримала клієнта або межу команди");
  const panels = read(`${SECTIONS}/ClientAdminPanels.tsx`);
  assert.match(panels, /useState<ClientPickerValue \| null>\(preset \?\? null\)/, "🔴 форма ігнорує підставленого клієнта — треба шукати заново");
  assert.match(panels, /if \(teamId === -1\) \{ setManagers\(\[\]\); return; \}/, "🔴 тімлід без команди бачить усіх");
  assert.match(panels, /fetchManagerOptions\(teamId \?\? undefined\)/, "🔴 список менеджерів не звужено до команди");
  const dash = read("backend/src/routes/dashboard.ts");
  const cardRoute = dash.slice(dash.indexOf('dashboardRouter.get("/client-card"'));
  assert.match(cardRoute.slice(0, cardRoute.indexOf("\ndashboardRouter.", 10)),
    /assignTeamId: assignTeamIdFor\(\{ canAll: roleHasPerm\(auth\.roleKey, "merge_clients"\), role: auth\.role, teamId: auth\.teamId \?\? null \}\)/,
    "🔴 картка не віддає межі команди з тієї самої функції");
});

/* ═══════════════════════════ ПРОХІД 2: дзвінок у рядку, дзвінки за місяць, обґрунтування ═══════════════════════════ */

/** Код без коментарів: гейт стереже виклик, а не слово в поясненні (правило 9). */
const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("#813 ▶ У РЯДКУ ГРАЄ ТУ САМУ РОЗМОВУ, ДАТА ЯКОЇ ПОКАЗАНА: запис із того самого рядка ядра", () => {
  const core = read("backend/src/core/reactivation.ts");
  const lt = core.slice(core.indexOf("LEFT JOIN LATERAL (\n         SELECT rc.calldate"), core.indexOf(") lt ON true"));
  assert.ok(lt.length > 0, "🔴 гейт втратив предмет: запиту останньої розмови не знайдено");
  // Дата і запис — з ОДНОГО підзапиту (одного рядка), а не з двох окремих «останніх».
  assert.match(lt, /SELECT rc\.calldate, rc\.call_type, rc\.recording, rc\.billsec/, "🔴 запис береться не з того рядка, що дата — ▶ заграє інший дзвінок");
  assert.match(lt, /rc\.billsec > 0\s+ORDER BY rc\.calldate DESC LIMIT 1/, "🔴 «остання розмова» перестала бути останньою розмовою");
  assert.match(core, /lt\.recording AS last_talk_recording/, "🔴 запис останньої розмови не доходить до рядка");
  const dash = read("backend/src/routes/dashboard.ts");
  assert.match(dash, /lastTalkRecording: reactByKey\.get\(c\.client_key\)\?\.lastTalkRecording \?\? null,/, "🔴 рядок /client-plans не несе запису останньої розмови");
  const list = codeOnly(read(`${SECTIONS}/ClientPlansSection.tsx`));
  assert.match(list, /\{c\.lastTalk && c\.lastTalkRecording && \(/, "🔴 кнопка ▶ показується без запису — кнопка в нікуди");
  assert.match(list, /<audio src=\{c\.lastTalkRecording\} controls autoPlay/, "🔴 запис не грає в рядку");
  assert.doesNotMatch(list, /href=\{c\.lastTalkRecording\}/, "🔴 запис відкривається посиланням, а не грає на місці");
});

test("#814 «📞 ЗА МІСЯЦЬ» У РЯДКУ — з ядра за обраний місяць; «Дзвінків по роках» і річного підрахунку немає", () => {
  const dash = read("backend/src/routes/dashboard.ts");
  assert.match(dash, /clientCalls\.callsByMonth\(clientKeys, monthStr\)/, "🔴 дзвінки рядка рахуються не за місяць ЕКРАНА");
  assert.match(dash, /callsMonth: clientCalls\.monthCell\(callsMonthByKey\.get\(c\.client_key\), monthStr\),/, "🔴 рядок не несе дзвінків за місяць із ядра");
  assert.doesNotMatch(dash, /callsByYear|callsYear|clientCallsYear/, "🔴 повернувся річний підрахунок — другий лічильник поруч із місячним");
  const list = read(`${SECTIONS}/ClientPlansSection.tsx`);
  assert.match(list, /📞 за \{monthName\}: \{c\.callsMonth\.talks\}\/\{c\.callsMonth\.calls\}/, "🔴 рядок не показує розмови/дзвінки за місяць");
  assert.doesNotMatch(list, /📞 0|callsYear/, "🔴 повернувся «📞 0» або річне число");
  const card = read(`${SECTIONS}/ClientCardPanel.tsx`);
  assert.doesNotMatch(codeOnly(card), /Дзвінки по роках|callsByYear/, "🔴 статистика «Дзвінки по роках» повернулась у картку (п.3.4)");
  assert.match(card, /📞 Останні розмови/, "🔴 разом зі статистикою зник і список розмов — нема де слухати й що закріпити");
});

test("#814b monthCell: місяць із дзвінками / без дзвінків / клієнт без жодного дзвінка", () => {
  assert.deepEqual(monthCell({ calls: 9, talks: 4 }, "2026-09"), { month: "2026-09", calls: 9, talks: 4 }, "🔴 переплутано розмови з дзвінками");
  assert.deepEqual(monthCell(undefined, "2026-09"), { month: "2026-09", calls: 0, talks: 0 }, "🔴 місяць без дзвінків дає не нуль");
  assert.deepEqual(monthCell({ calls: 3, talks: 0 }, "2026-10"), { month: "2026-10", calls: 3, talks: 0 }, "🔴 недодзвони пропали, коли розмов нуль");
});

test("#814c ЖИВИЙ SQL: місяць за Києвом по обидва боки межі, розмова = billsec>0, чужі ключі не рахуються", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(path.join(ROOT, "backend/src/db/schema.sql"), "utf8"));
    // Вересень у Києві — UTC+3. Обидві межі місяця по обидва боки.
    await c.query(`INSERT INTO ringostat_calls (uniqueid, calldate, call_type, billsec, client_key) VALUES
      ('s1', '2026-09-30T20:30:00Z', 'out', 40, 'k1'),  -- 30.09 23:30 Київ → вересень, розмова
      ('s2', '2026-09-30T21:30:00Z', 'out', 55, 'k1'),  -- 01.10 00:30 Київ → жовтень (за UTC був би вересень)
      ('s3', '2026-08-31T21:30:00Z', 'in',  0,  'k1'),  -- 01.09 00:30 Київ → вересень, спроба (за UTC — серпень)
      ('s4', '2026-08-31T20:30:00Z', 'out', 30, 'k1'),  -- 31.08 23:30 Київ → серпень
      ('s5', '2026-09-15T10:00:00Z', 'out', 99, 'k2')`); // чужий ключ
    const r = await c.query<{ client_key: string; calls: number; talks: number }>(CALLS_BY_MONTH_SQL, [["k1"], "2026-09"]);
    assert.deepEqual(r.rows.map((x) => `${x.client_key}:${x.talks}/${x.calls}`), ["k1:1/2"],
      "🔴 місяць рахується не за Києвом, розмови переплутано зі спробами або підмішано чужий ключ");
  } finally {
    await c.end();
    scratch.dispose();
  }
});

test("#815 ОБҐРУНТУВАННЯ — РІВНО ОДНЕ: дзвінок або скрин, не обидва і не жодного; місяць лише YYYY-MM", () => {
  assert.deepEqual(basisTarget({ callId: "ua1-123.4" }), { kind: "call", callId: "ua1-123.4" });
  assert.deepEqual(basisTarget({ contactId: 7 }), { kind: "contact", contactId: 7 });
  assert.ok("error" in basisTarget({ callId: "x", contactId: 7 }), "🔴 прийнято дзвінок І скрин разом");
  assert.ok("error" in basisTarget({}), "🔴 прийнято порожнє обґрунтування");
  assert.ok("error" in basisTarget({ callId: "  ", contactId: "abc" }), "🔴 сміття прийнято за ціль");
  assert.ok("error" in basisTarget({ contactId: -3 }), "🔴 відʼємний id скрину прийнято");
  assert.equal(basisMonth("2026-09"), "2026-09-01");
  assert.equal(basisMonth("2026-13"), null, "🔴 13-й місяць прийнято");
  assert.equal(basisMonth("2026-09-15"), null, "🔴 дата замість місяця прийнята");
  const schema = read("backend/src/db/schema.sql");
  assert.match(schema, /CONSTRAINT client_plan_basis_one CHECK \(\(call_uniqueid IS NULL\) <> \(contact_id IS NULL\)\)/,
    "🔴 «рівно одне» не тримає база — лише код");
});

test("#815b ЖИВИЙ SQL: закріпити → замінити → зняти; обидва разом відхиляє CHECK; скрин видалили — обґрунтування зникло; чужий дзвінок не належить", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(path.join(ROOT, "backend/src/db/schema.sql"), "utf8"));
    await c.query(`INSERT INTO ringostat_calls (uniqueid, calldate, call_type, billsec, client_key, recording) VALUES
      ('c1', '2026-09-18T09:00:00Z', 'out', 185, 'k1', 'https://rec/c1'),
      ('c2', '2026-09-18T10:00:00Z', 'out', 60,  'k2', 'https://rec/c2')`);
    const withFile = (await c.query<{ id: number }>(`INSERT INTO client_contacts (client_key, channel, stored_name, file_name) VALUES ('k1','viber','f.png','скрин.png') RETURNING id`)).rows[0].id;
    const noFile = (await c.query<{ id: number }>(`INSERT INTO client_contacts (client_key, channel, note) VALUES ('k1','viber','без файла') RETURNING id`)).rows[0].id;
    const belongs = async (call: string | null, contact: number | null) =>
      (await c.query<{ ok: boolean }>(BASIS_BELONGS_SQL, ["k1", call, contact])).rows[0].ok;
    // Належність — по обидва боки.
    assert.equal(await belongs("c1", null), true, "🔴 власний дзвінок клієнта не належить йому");
    assert.equal(await belongs("c2", null), false, "🔴 ЧУЖИЙ дзвінок прийнято як обґрунтування — доступ повз canSeeClient");
    assert.equal(await belongs(null, withFile), true, "🔴 власний скрин не належить клієнту");
    assert.equal(await belongs(null, noFile), false, "🔴 контакт БЕЗ скрину прийнято як «скрин»");
    const rows = async () => (await c.query(`SELECT call_uniqueid, contact_id FROM client_plan_basis WHERE client_key='k1'`)).rows;
    await c.query(BASIS_UPSERT_SQL, ["k1", "2026-09-01", "c1", null, null]);
    const shown = (await c.query(BASIS_FOR_MONTH_SQL, [["k1"], "2026-09-01"])).rows.map(shapeBasis);
    assert.deepEqual(shown.map((b) => [b.kind, b.callId, b.sec, b.recording]), [["call", "c1", 185, "https://rec/c1"]], "🔴 закріплена розмова показується не такою");
    await c.query(BASIS_UPSERT_SQL, ["k1", "2026-09-01", null, withFile, null]);
    assert.deepEqual(await rows(), [{ call_uniqueid: null, contact_id: withFile }], "🔴 друге закріплення не ЗАМІНИЛО перше (або дзвінок лишився поруч)");
    await assert.rejects(c.query(`INSERT INTO client_plan_basis (client_key, month, call_uniqueid, contact_id) VALUES ('k9','2026-09-01','c1',${withFile})`),
      /client_plan_basis_one/, "🔴 база прийняла дзвінок І скрин разом");
    await c.query(`DELETE FROM client_contacts WHERE id = $1`, [withFile]);
    assert.deepEqual(await rows(), [], "🔴 скрин видалили, а обґрунтування на нього лишилось висіти");
    await c.query(BASIS_UPSERT_SQL, ["k1", "2026-09-01", "c1", null, null]);
    await c.query(BASIS_CLEAR_SQL, ["k1", "2026-09-01"]);
    assert.deepEqual(await rows(), [], "🔴 «зняти» не зняло — дія незворотна через інтерфейс");
  } finally {
    await c.end();
    scratch.dispose();
  }
});

test("#815c РОУТИ ОБҐРУНТУВАННЯ: межа першою, належність до запису, матриця й вкладка; у картці й рядку є «закріпити» і «зняти»", () => {
  const dash = read("backend/src/routes/dashboard.ts");
  const body = (route: string) => {
    const i = dash.indexOf(`dashboardRouter.post("${route}"`);
    assert.ok(i > 0, `🔴 роуту ${route} немає`);
    return dash.slice(i, dash.indexOf("\n});", i));
  };
  const pin = body("/client-plan-basis"), clr = body("/client-plan-basis/clear");
  const order = ["canSeeClient(", "planBasis.basisMonth(", "planBasis.basisTarget(", "planBasis.BASIS_BELONGS_SQL", "planBasis.BASIS_UPSERT_SQL"].map((k) => pin.indexOf(k));
  assert.ok(order.every((x) => x > 0), "🔴 у роуті закріплення бракує межі, розбору або перевірки належності");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "🔴 порядок у роуті зламаний: межа має стояти ПЕРШОЮ, належність — ДО запису");
  assert.ok(clr.indexOf("canSeeClient(") > 0 && clr.indexOf("canSeeClient(") < clr.indexOf("planBasis.BASIS_CLEAR_SQL"), "🔴 «зняти» пише без межі");
  const matrix = read("backend/src/auth/accessMatrix.ts");
  for (const p of ["/api/dashboard/client-plan-basis\"", "/api/dashboard/client-plan-basis/clear\""]) assert.ok(matrix.includes(p), `🔴 ${p} немає в матриці`);
  assert.match(read("backend/src/auth/routeTab.ts"), /pre\("\/api\/dashboard\/client-plan-basis"\), tabs: \["loyalty"\]/, "🔴 роут обґрунтування без вкладки");
  const card = read(`${SECTIONS}/ClientCardPanel.tsx`);
  assert.match(card, /onClick=\{\(\) => pin\(\{ callId: c\.id \}\)\}/, "🔴 розмову не можна закріпити з картки");
  assert.match(card, /onClick=\{\(\) => pin\(\{ contactId: k\.id \}\)\}/, "🔴 скрин не можна закріпити з картки");
  assert.match(card, /onClick=\{unpin\}/, "🔴 у картці немає «зняти»");
  assert.match(card, /fetchClientCard\(clientKey, month\)/, "🔴 картка не знає місяця екрана — закріплення піде не в той місяць");
  const list = read(`${SECTIONS}/ClientPlansSection.tsx`);
  assert.match(list, /clearPlanBasis\(\{ clientKey: c\.clientKey, month \}\)/, "🔴 у рядку немає «зняти»");
  assert.match(list, /<ClientCardPanel clientKey=\{c\.clientKey\} onChanged=\{load\} month=\{month\} \/>/, "🔴 картка з екрана планів відкривається без місяця");
});

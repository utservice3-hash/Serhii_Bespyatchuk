import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { clientTabGroup, tabOf, TAB_GROUP_RANK, YELLOW_DAYS } from "./clientTabs.js";
import { assignTeamIdFor, assignAllowed } from "../auth/mergeScope.js";

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const SECTIONS = "frontend/src/pages/dashboard/sections";

/**
 * 🗂 #770–#772b — ТЗ Юлі 22.09.2026, блок 3, прохід 1 (задача 4312): вкладки, порядок «Всі»,
 * колонки таблиці, згорнуті тижні, передача клієнта тімлідом.
 */

test("#770 clientTabGroup: активний до/після 30 днів, сплячий і втрачений — реактивація; порядок постійні → жовті → реактивація", () => {
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

test("#770b ФРОНТ НЕ МАЄ ВЛАСНОГО ПРАВИЛА ВКЛАДОК: фільтр, порядок і жовтий фон — з поля сервера", () => {
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
 * #771 — КОЛОНКИ ТАБЛИЦІ СХОДЯТЬСЯ. До блоку 3 у шапці було 9 колонок, а підсумок і розгорнута
 * картка — на 8 (заміряно 28.09.2026): дані підсумку стояли під чужими заголовками. Тепер
 * «Історія · 6 міс» прибрано, а тижні згортаються — і рахувати треба в ОБОХ станах.
 */
test("#771 КОЛОНКИ СХОДЯТЬСЯ: шапка == рядок == підсумок у обох станах тижнів; «Історії · 6 міс» немає", () => {
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

test("#772 КОГО ПОКАЗАТИ У ПЕРЕДАЧІ: КВП/адмін — усіх, тімлід — свою команду, без команди — нікого; межа та сама, що в assignAllowed", () => {
  assert.equal(assignTeamIdFor({ canAll: true, role: "admin", teamId: 5 }), null, "🔴 адміну/КВП звузили список");
  assert.equal(assignTeamIdFor({ canAll: false, role: "team_lead", teamId: 6 }), 6, "🔴 тімлід бачить не свою команду");
  assert.equal(assignTeamIdFor({ canAll: false, role: "team_lead", teamId: null }), -1, "🔴 тімлід без команди бачить УСІХ — null відкрив би всіх");
  assert.equal(assignTeamIdFor({ canAll: false, role: "manager", teamId: 6 }), -1);
  // 🪞 Список і сервер кажуть одне: кого показали — того сервер і пропустить.
  const t = assignTeamIdFor({ canAll: false, role: "team_lead", teamId: 6 })!;
  assert.equal(assignAllowed({ canAll: false, leadTeamId: 6, clientTeamId: 6, targetTeamId: t }), true, "🔴 показали менеджера, якого сервер не пропустить");
  assert.equal(assignAllowed({ canAll: false, leadTeamId: 6, clientTeamId: 6, targetTeamId: 7 }), false, "🔴 сервер пропускає чужу команду");
});

test("#772b ПЕРЕДАЧА — КНОПКОЮ В КАРТЦІ, клієнт підставлений, список за командою з сервера", () => {
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

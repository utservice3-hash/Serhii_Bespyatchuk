import { test } from "node:test";
import assert from "node:assert/strict";
import { orphanReason, orphanManagerSql, SERVICE_KOMMO_USER_IDS, ORPHAN_DEFAULT_MONTHS, clientKind, orphanRowOrder, orphanPoolAccess } from "./orphanClients.js";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 🔴 Ці тести існують через КОНКРЕТНУ помилку 05.08.2026: перший критерій
 * «службовий = немає пошти @uts.ua» затягнув у службові звільнену людину
 * (Мельник Лілія, пошта в картці просто не заповнена). Тому головне, що вони
 * стережуть, — це РОЗДІЛЬНІСТЬ двох ознак, а не сам факт «щось повертається».
 */

test("#30 НІЧИЙНИЙ: службовий і звільнений — РІЗНІ причини, не змішані", () => {
  assert.equal(orphanReason({ kommoUserId: "904923", isActive: true }), "service");
  assert.equal(orphanReason({ kommoUserId: 904923, isActive: true }), "service",
    "🔴 число і рядок мають давати те саме — kommo_user_id приходить і так, і так");
  assert.equal(orphanReason({ kommoUserId: "111", isActive: false }), "inactive");
  // Службовий ВАЖЛИВІШИЙ: якщо адмінський акаунт колись деактивують, клієнти
  // мають лишитись «службовими» — їх треба роздати, а не «перепризначити».
  assert.equal(orphanReason({ kommoUserId: "904923", isActive: false }), "service");
});

test("#30b ДЗЕРКАЛО: звичайний активний менеджер НЕ нічийний", () => {
  // Без цього #30 зеленів би й тоді, коли в пул поїхала б уся компанія.
  assert.equal(orphanReason({ kommoUserId: "7181916", isActive: true }), null);
  assert.equal(orphanReason({ kommoUserId: null, isActive: true }), null);
});

test("#30c ПОШТА НЕ Є КРИТЕРІЄМ (саме через неї Мельник впала у службові)", () => {
  assert.equal(orphanReason({ kommoUserId: "5", isActive: true }), null,
    "🔴 повернулась евристика по пошті/порожньому полю");
  assert.equal(orphanReason({ kommoUserId: "5", isActive: false }), "inactive");
});

test("#30d SQL-ПРЕДИКАТ і TS-функція говорять про ТЕ САМЕ", () => {
  const sql = orphanManagerSql("mm");
  for (const id of SERVICE_KOMMO_USER_IDS) assert.ok(sql.includes(`'${id}'`), `у SQL немає ${id}`);
  assert.ok(sql.includes("NOT mm.is_active"), "у SQL немає ознаки деактивації");
  assert.ok(sql.includes("mm.kommo_user_id"), "алиас не підставився");
  assert.ok(SERVICE_KOMMO_USER_IDS.length > 0, "🔴 список службових порожній");
  assert.equal(ORPHAN_DEFAULT_MONTHS, 18);
});

// ── 🏢 ПУЛ ДЛЯ ДВОХ МЕНЕДЖЕРІВ І ПОРЯДОК «ЮР/ФОП ЗВЕРХУ» (05.10.2026, Роман) ─────────────────────────────
const K = (name: string, anyCashless = false, hasCode = false) => clientKind({ name, anyCashless, hasCode }).kind;

test("#1366 ВИД КЛІЄНТА: безнал, код ЄДРПОУ/ІПН або форма в назві — «юр/ФОП»; інакше «фіз» (по обидва боки кожної ознаки)", () => {
  assert.equal(K("Ковальчук Іван", true), "legal", "🔴 безготівкова оплата не робить клієнта юрособою/ФОП");
  assert.equal(K("Ковальчук Іван"), "person", "🔴 людина на готівці без коду пішла вгору");
  assert.equal(K("Агро Інвест", false, true), "legal", "🔴 код ЄДРПОУ/ІПН у компанії Kommo не враховано");
  assert.equal(K("Агро Інвест"), "person", "🔴 назва без форми й без коду на готівці пішла вгору — свідчення немає");
  for (const n of ["ТОВ \"Ромашка\"", "ФОП Сопельник Георгій", "ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ «БУД»", "ПП Іванов", "LLC Foo"]) {
    assert.equal(K(n), "legal", `🔴 форма в назві не впізнана: ${n}`);
  }
  // Межі слова: «ТОВАР…» і прізвища з «Ат»/«Ск» — це не форма.
  for (const n of ["Товарчук Олена", "Остапенко Ат", "Скороход Ігор", "Бондаренко Ігор"]) {
    assert.equal(K(n), "person", `🔴 людину впізнано як юрособу за шматком слова: ${n}`);
  }
  assert.deepEqual(clientKind({ name: "ТОВ А", anyCashless: true, hasCode: true }).why, "cashless", "порядок свідчень: безнал → код → назва");
});

test("#1366b ПОРЯДОК У ГРУПІ: жоден «фіз» не стоїть вище «юр/ФОП», усередині виду — за сумою", () => {
  const rows = [
    { k: "фіз-великий", kind: "person" as const, revenueAll: 900 },
    { k: "юр-малий", kind: "legal" as const, revenueAll: 10 },
    { k: "фіз-малий", kind: "person" as const, revenueAll: 5 },
    { k: "юр-великий", kind: "legal" as const, revenueAll: 500 },
  ];
  assert.deepEqual([...rows].sort(orphanRowOrder).map((r) => r.k), ["юр-великий", "юр-малий", "фіз-великий", "фіз-малий"],
    "🔴 «фіз» із більшою сумою обігнав «юр/ФОП» — сортування знову лише за сумою");
});

test("#1367 ДОСТУП ДО ПУЛУ: менеджер без прапорця — ні, з прапорцем — лише собі; керівники — повний", () => {
  assert.equal(orphanPoolAccess({ role: "manager", orphanPoolFlag: false }), "none", "🔴 пул відкрився ВСІМ менеджерам");
  assert.equal(orphanPoolAccess({ role: "manager", orphanPoolFlag: true }), "self", "🔴 прапорець не відкриває пул менеджеру");
  for (const role of ["admin", "team_lead", "company"]) {
    assert.equal(orphanPoolAccess({ role, orphanPoolFlag: false }), "full", `🔴 керівник (${role}) втратив пул`);
  }
});

test("#1367b РОУТИ ПУЛУ: межа першою дією в обох; менеджер із прапорцем закріплює лише за собою", () => {
  const src = readFileSync(path.join(import.meta.dirname, "..", "..", "src", "routes", "dashboard.ts"), "utf8");
  for (const r of ['dashboardRouter.get("/orphan-clients"', 'dashboardRouter.post("/orphan-clients/claim"']) {
    const at = src.indexOf(r);
    assert.ok(at > 0, `🔴 роут ${r} не знайдено`);
    assert.match(src.slice(at, at + 260), /const auth = req\.auth!;\s*const access = await poolAccessOf\(auth\);\s*if \(access === "none"\) return res\.status\(403\)/,
      `🔴 ${r}: межа доступу не першою дією — 400 замість 403 ламає гарантію матриці`);
  }
  const claim = src.slice(src.indexOf('dashboardRouter.post("/orphan-clients/claim"'));
  assert.match(claim.slice(0, 1200), /if \(access === "self" && managerId !== auth\.managerId\)\s*\{\s*return res\.status\(403\)/,
    "🔴 менеджер із прапорцем може закріпити клієнта за іншим");
  assert.match(src, /SELECT orphan_pool FROM users WHERE id = \$1/, "🔴 прапорець читається не з БД — вимкнення в Налаштуваннях не діятиме до нового входу");
});

test("#1369 НАЛАШТУВАННЯ → КОРИСТУВАЧІ: широка таблиця у власному горизонтальному скролі, заголовки не злипаються", () => {
  const fe = readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", "pages", "dashboard", "sections", "SettingsSection.tsx"), "utf8");
  const head = fe.indexOf("<thead><tr><th style={TH}>ПІБ</th>");
  assert.ok(head > 0, "🔴 таблицю користувачів не знайдено (або заголовки знову без відступу)");
  const before = fe.slice(Math.max(0, head - 400), head);
  assert.match(before, /<div className="settings-users-scroll" style=\{\{ overflowX: "auto"[^}]*\}\}>\s*<table className="data-table"/,
    "🔴 таблиця користувачів без горизонтального скролу — на великому масштабі кнопки праворуч зрізаються (05.10.2026)");
  assert.match(fe, /const TH: React\.CSSProperties = \{ whiteSpace: "nowrap", paddingRight: \d+ \}/, "🔴 заголовки без відступу — «АКТИВНИЙСТАН»");
});

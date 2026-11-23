import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 💰↔🧑‍💼 Задача 10723 (Тетяна 23.11.2026): «Зарплата» показує, що в «Наймі» розходиться з нею, і не ховає порожні команди
 * в «Оферах», а ставить їх у кінець. Гейти `#10870`–`#10874`. Модуль чистий (без БД), але тягне `core/employeeLevel` →
 * імпорт лінивий, як велить правило зони testing.
 */
const FRONT = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", p), "utf8");
const lazy = async () => await import("./naimSync.js");

type P = { userId: string; name: string; role: string; level: "start" | "profi" | null; levelChange: { level: "start" | "profi" } | null; leave: unknown | null };
const zp = (userId: string, o: Partial<P> = {}): P => ({ userId, name: `ЗП ${userId}`, role: "manager", level: "start", levelChange: null, leave: null, ...o });
const nm = (employeeId: number, userId: string | null, o: Record<string, unknown> = {}) => ({
  employeeId, userId, userActive: true, candidateRole: false, name: `Найм ${employeeId}`, position: "Менеджер", status: "active", dismissedAt: null,
  isSalesManager: true, level: "start" as "start" | "profi" | null, ...o });

/**
 * #10870 — ЗВІЛЬНЕНИЙ У «НАЙМІ», АЛЕ НЕ В «ЗАРПЛАТІ» видно, по обидва боки межі: звільнений у «Наймі» без звільнення в «Зарплаті»
 * → рядок `dismissed` з датою; звільнений в обох → немає (обхідний лист уже є); працює в обох → немає.
 * 🧨 Червоніє, якщо прибрати умову на звільнення в «Зарплаті» (у списку зʼявиться вже оформлений) або перестати дивитись
 * на статус «Найму» (Сердюк зникне з блоку, а рушій і далі рахуватиме йому ставку).
 */
test("#10870 ЗАРПЛАТА ↔ НАЙМ: звільнений у «Наймі» без обхідного листа — рядок з датою; звільнений в обох і працюючий — без рядка", async () => {
  const { naimChanges } = await lazy();
  const out = naimChanges([zp("1"), zp("2", { leave: { date: "2026-10-31" } }), zp("3")],
    [nm(10, "1", { status: "dismissed", dismissedAt: "2026-10-31" }), nm(20, "2", { status: "dismissed", dismissedAt: "2026-10-31" }), nm(30, "3")]);
  const d = out.filter((r) => r.kind === "dismissed");
  assert.deepEqual(d.map((r) => [r.userId, r.date]), [["1", "2026-10-31"]], "🔴 у блоці не той набір звільнених");
  assert.equal(out.some((r) => r.userId === "2"), false, "🔴 звільнений в обох реєстрах потрапив у «зміни»");
  assert.equal(out.some((r) => r.userId === "3"), false, "🔴 працюючий в обох реєстрах потрапив у «зміни»");
});

/**
 * #10871 — НОВИЙ У «НАЙМІ» ≠ БЕЗ АКАУНТА: працює в «Наймі», активний акаунт, у «Зарплаті» немає → `new` (кнопка «Додати»);
 * без акаунта → `noAccount/none`; акаунт вимкнено → `noAccount/inactive`; уже в «Зарплаті» → немає; роль `candidate` → немає.
 * 🧨 Червоніє, якщо злити два види (кнопка «Додати» зʼявиться людині, якої форма не знайде — так виглядало «немає такої опції»
 * у Тищенка й Білоуса) або перестати звіряти з «Зарплатою».
 */
test("#10871 ЗАРПЛАТА ↔ НАЙМ: новий з акаунтом — «додати», без акаунта чи з вимкненим — окремо, уже в зарплаті і кандидат — без рядка", async () => {
  const { naimChanges } = await lazy();
  const out = naimChanges([zp("5")], [
    nm(1, "7"), nm(2, null), nm(3, "8", { userActive: false }), nm(4, "5"), nm(6, "9", { candidateRole: true }),
  ]);
  const k = (id: number) => out.filter((r) => r.employeeId === id).map((r) => [r.kind, r.reason ?? null]);
  assert.deepEqual(k(1), [["new", null]], "🔴 новий з активним акаунтом — не «додати»");
  assert.deepEqual(k(2), [["noAccount", "none"]], "🔴 людина без акаунта — не в «без акаунта»");
  assert.deepEqual(k(3), [["noAccount", "inactive"]], "🔴 вимкнений акаунт — не «вимкнено»");
  assert.deepEqual(k(4), [], "🔴 людина вже в «Зарплаті», а її пропонують додати");
  assert.deepEqual(k(6), [], "🔴 кандидат найму потрапив у «зміни»");
});

/**
 * #10872 — РІВЕНЬ «НАЙМУ» ПРОТИ «ЗАРПЛАТИ» з урахуванням запланованого переходу: «Профі» в «Наймі» і «Старт» у «Зарплаті» → рядок;
 * у «Зарплаті» «Профі» з наступного місяця → немає (уже внесено); однакові → немає; не менеджер з продажу в «Наймі» → немає.
 * 🧨 Червоніє, якщо порівнювати без `levelChange` (кожен, хто сам обрав «Профі», висітиме в блоці до 1-го) або перестати
 * порівнювати зовсім.
 */
test("#10872 ЗАРПЛАТА ↔ НАЙМ: різний рівень — рядок, запланований перехід і однаковий рівень — без рядка, не продажник — без рядка", async () => {
  const { naimChanges } = await lazy();
  const out = naimChanges([zp("1"), zp("2", { levelChange: { level: "profi" } }), zp("3", { level: "profi" }), zp("4")],
    [nm(1, "1", { level: "profi" }), nm(2, "2", { level: "profi" }), nm(3, "3", { level: "profi" }), nm(4, "4", { isSalesManager: false, level: null })]);
  assert.deepEqual(out.map((r) => [r.kind, r.userId, r.naimLevel, r.payrollLevel]), [["level", "1", "profi", "start"]], "🔴 розбіжність рівня визначено неправильно");
});

/**
 * #10873 — «ОФЕРИ»: ПОРОЖНЯ КОМАНДА НЕ ЗНИКАЄ, А ЙДЕ В КІНЕЦЬ З ПОЗНАЧКОЮ (Тетяна 23.11.2026). Команда, де лишився лише звільнений,
 * — `stale`, після всіх команд з людьми; команда з одним працюючим (або лише з тім-лідом) — не `stale`, з кількістю.
 * 🧨 Червоніє, якщо повернути «усі команди як є» (Сердюк знову серед живих) або ховати порожні (команда зникне з «Оферів»).
 */
test("#10873 ОФЕРИ: команди з людьми — спершу з кількістю, порожні (лише звільнені) — у кінці як неактуальні, не зникають", async () => {
  const { offerTeams } = await lazy();
  const out = offerTeams(
    [{ code: "ys", name: "Ярослав Сердюк TeamLead", offer: "std" }, { code: "yt", name: "Яцик Team lead", offer: "std" }, { code: "bz", name: "Безпамʼятний Team lead", offer: null }, { code: "lead", name: "Лише тім-лід", offer: "ls" }],
    [{ team: "ys", leave: { date: "2026-10-31" } }, { team: "yt" }, { team: "yt" }, { team: "bz" }, { team: null, leadsTeam: "lead" }]);
  assert.deepEqual(out.map((t) => [t.code, t.people, t.stale]), [["bz", 1, false], ["lead", 1, false], ["yt", 2, false], ["ys", 0, true]], "🔴 порядок або позначка команд у «Оферах» неправильні");
  assert.equal(out.find((t) => t.code === "bz")?.offer, "std", "🔴 команда без коду оферу мусить бути на стандартному");
});

/**
 * #10874 — КАБІНЕТ: БЛОКУ «ДНІ НАРОДЖЕННЯ · МІСЯЦЬ» НЕМАЄ, А ПРАВИЛО ДН — Є (Тетяна 23.11.2026: «прибрати в усіх»). Парне
 * твердження «а де воно тепер»: правило днів народження лишається в «Правилах», інакше зникнення читалося б як успіх.
 * Сервер більше не віддає `birthdaysMonth`, екран його не читає. Блок «Зміни з «Найму»» і «Офери» беруть дані з `employeesView`.
 * 🧨 Червоніє, якщо блок повернеться, якщо разом з ним зникне правило ДН або якщо «Офери» знову читатимуть сирі `teams`.
 */
test("#10874 КАБІНЕТ І НАЛАШТУВАННЯ: блоку ДН місяця немає, правило ДН у «Правилах» є; «Офери» й «Зміни з Найму» — з employeesView", () => {
  const terms = FRONT("payroll/cabinet/Terms.tsx");
  assert.equal(/BdaysBlock|birthdaysMonth/.test(terms), false, "🔴 блок «Дні народження · місяць» повернувся в кабінет");
  assert.match(terms, /\["Дні народження", `/, "🔴 разом із блоком зникло правило днів народження");
  const svc = readFileSync(path.join(import.meta.dirname, "..", "..", "src", "payroll", "service.ts"), "utf8");
  assert.equal(/birthdaysMonth:/.test(svc), false, "🔴 сервер знову віддає список іменинників місяця");
  assert.match(svc, /return \{ month: live, people, naim, offerTeams: offerTeamList, candidates:/, "🔴 employeesView не віддає «зміни з Найму» або команди «Оферів»");
  const set = FRONT("payroll/system/SettingsTab.tsx"), ppl = FRONT("payroll/system/PeopleSettings.tsx");
  assert.match(set, /<Offers S=\{S\} teams=\{\(data\.emp\.offerTeams/, "🔴 «Офери» читають не впорядковані команди сервера");
  assert.match(ppl, /<NaimBlock rows=\{\(emp\.naim/, "🔴 блок «Зміни з «Найму»» не показано");
});

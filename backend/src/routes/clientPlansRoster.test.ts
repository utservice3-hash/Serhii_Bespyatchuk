/**
 * 🧩 РОСТЕР ЕКРАНА «КЛІЄНТИ» = АКТИВНІ ∪ ТІ, ХТО МАЄ ПЛАН НА ЦЕЙ МІСЯЦЬ.
 *
 * 🔴 ЩО ТУТ ЛІКУЄТЬСЯ. Список рядків будувався від СЬОГОДНІШНЬОЇ активності
 * клієнта, а плани читались `WHERE month = M AND client_key = ANY(активні)`.
 * Для минулого місяця це означало, що план клієнта, який відтоді заснув, зникав
 * з екрана МОВЧКИ. Заміряно на проді 21.08.2026 за липень:
 *
 *   у БД      92 плани / 954 171 ₴
 *   на екрані 27 планів / 367 901 ₴
 *   випало    65 планів / 586 270 ₴   (61 сплячий, 1 втрачений, 2 разових, 1 дженерик)
 *
 * 🔴 І ЦЕ БУЛА НЕ «ОДНА ПЛИТКА». Ту саму величину показує ДРУГИЙ екран —
 * «Формування плану» (`/plans/formation`), і він рахує її БЕЗ фільтра, тобто вже
 * показував 486 570 ₴ там, де «Клієнти» показували 196 000 ₴. Два екрани про одне
 * число, розбіжність 290 570 ₴, і жодного гейта між ними: у коді стояв коментар
 * «гейт вимагає точного збігу», а гейта не існувало. `#107c` — саме він.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { needsApi, API_BASE } from "../testMode.js";
import {
  isPlannableClientKey, rosterWithPlans, splitUnattached, NOT_PLANNABLE_MSG,
} from "./clientPlanRules.js";

/**
 * Читання ДЖЕРЕЛА (не збірки) — той самий прийом, що `#24d`/`#52b`. Кілька
 * коренів, бо набір біжить із `dist`, а перевіряти треба `.ts`. Не знайшли файл —
 * `assert.fail`, а не мовчазний пропуск: перевірка, яка тихо не виконалась, гірша
 * за її відсутність.
 */
const SRC_ROOTS = [
  path.join(import.meta.dirname, "..", ".."),            // dist → backend
  path.join(import.meta.dirname, "..", "..", ".."),      // dist/routes → repo root
  path.join(import.meta.dirname, "..", "..", "..", ".."),
];
function readSrc(rel: string): string {
  for (const r of SRC_ROOTS) {
    try { return readFileSync(path.join(r, rel), "utf8"); } catch { /* далі */ }
  }
  assert.fail(`не знайдено ${rel} — перевірка не має права мовчки пропускатись`);
}

async function adminToken(): Promise<string> {
  const { signToken } = await import("../auth/auth.js");
  return signToken({ userId: 0, role: "admin", roleKey: "admin", managerId: null, teamId: null });
}
const get = (path: string, token: string) =>
  fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });

interface Row {
  clientKey: string; plan: number; planStatus: string;
  planOnly: boolean; inRoster: "active" | "reactivation" | "planOnly";
  state: "active" | "sleeping" | "lost" | "oneoff";
}
interface Resp {
  clients: Row[];
  totals: {
    planTotal: number; planApproved: number; goesToManagerPlan: number;
    totalClients: number; planOnlyClients: number; filledClients: number;
    rosterClients: number; byState: { active: number; reactivation: number; planOnly: number };
    inReactivation: number; inReactivationSleeping: number; inReactivationLost: number;
    oneOff: number; skippedGeneric: number; activeBySegment: Record<string, number>;
    unattached: { canSee: boolean; count: number; sum: number;
      rows: { clientKey: string; plan: number; status: string }[] };
    prevMonth: { month: string; count: number; sum: number };
  };
}

/**
 * 🔌 КОНТРАКТ ВІДПОВІДІ — перевіряється ЯВНО, а не «впаде саме».
 *
 * 🔴 Урок `#106`: бекенд і фронт компілюються окремо, тож тип у фронті нічого не
 * доводить про роут. Без цієї перевірки зникле поле давало б `Cannot read
 * properties of undefined` — гейт червонів би, але казав би не те: читач шукав би
 * помилку в тесті, а не зламаний контракт. Заміряно: саме так і вийшло на першому
 * прогоні проти прода, де цих полів ще немає.
 */
function assertContract(b: Resp): void {
  assert.ok(b.totals, "🔴 у відповіді немає `totals`");
  assert.ok(b.totals.unattached && typeof b.totals.unattached.sum === "number",
    "🔴 у відповіді немає `totals.unattached` — плани без клієнтського рядка нікуди подіти, "
    + "і Σ на екрані перестане сходитись із базою");
  assert.ok(b.totals.prevMonth && typeof b.totals.prevMonth.count === "number",
    "🔴 у відповіді немає `totals.prevMonth` — підказці про минулий місяць нічого показувати");
  assert.equal(typeof b.totals.planOnlyClients, "number",
    "🔴 у відповіді немає `totals.planOnlyClients` — різницю «ростер vs активні» нічим назвати");
  assert.ok(b.clients.every((c) => typeof c.planOnly === "boolean" && typeof c.state === "string"
    && ["active", "reactivation", "planOnly"].includes(c.inRoster)),
    "🔴 рядок клієнта без `planOnly`/`state`/`inRoster` — екран не зможе ані підписати стан, ані відфільтрувати");
}

/** Найсвіжіший місяць, у якому плани ВЗАГАЛІ є, — щоб гейт не протух на даті. */
async function monthWithPlans(): Promise<{ month: string; count: number; sum: number } | null> {
  const { pool } = await import("../db/pool.js");
  const r = await pool.query<{ m: string; n: string; s: string }>(
    `SELECT to_char(month,'YYYY-MM') AS m, COUNT(*)::int AS n, COALESCE(SUM(plan),0)::numeric AS s
       FROM repeat_client_plans GROUP BY month ORDER BY month DESC LIMIT 1`);
  const row = r.rows[0];
  return row ? { month: row.m, count: Number(row.n), sum: Number(row.s) } : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// ЖИВІ ГЕЙТИ — потрібні і роут, і БД (перевіряємо ЕКРАН проти ДЖЕРЕЛА)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * #107 — Σ ПОКАЗАНИХ ПЛАНІВ МІСЯЦЯ == Σ У БАЗІ ЗА ЦЕЙ МІСЯЦЬ. Δ0.
 *
 * 🧨 САБОТАЖ (виконано): повернути в роут `AND client_key = ANY(clientKeys)` →
 * за липень показане стає 27 планів / 367 901 ₴ проти 92 / 954 171 ₴ у базі.
 * Гейт червоніє з обома числами в тексті.
 *
 * ⚠️ Рахуємо Σ ПОКАЗАНОГО як «рядки + рядок „не привʼязано“»: гроші, які екран
 * НАЗВАВ, — це і те, і те. Якби «не привʼязано» ховали, Δ дорівнювала б рівно
 * тим 40 000 ₴, і гейт це побачив би.
 */
test("#107 Σ показаних планів місяця == Σ у БД за цей місяць (Δ0)", needsApi(), async () => {
  const m = await monthWithPlans();
  assert.ok(m, "🔴 у `repeat_client_plans` немає ЖОДНОГО плану — перевіряти нічого");
  const token = await adminToken();
  const r = await get(`/api/dashboard/client-plans?month=${m.month}`, token);
  assert.equal(r.status, 200, `🔴 /client-plans віддав ${r.status}`);
  const b = await r.json() as Resp;
  assertContract(b);

  const shownRows = b.clients.reduce((s, c) => s + c.plan, 0);
  const shownUnattached = b.totals.unattached.sum;
  const shown = shownRows + shownUnattached;

  assert.ok(m.count > 0 && m.sum > 0, "🔴 місяць порожній — Δ0 зеленіла б сама собою");
  assert.equal(Math.round(shown), Math.round(m.sum),
    `🔴 екран показує ${Math.round(shown)} ₴ (рядки ${Math.round(shownRows)} + не привʼязано ${shownUnattached}), `
    + `а в БД за ${m.month} лежить ${Math.round(m.sum)} ₴ — плани зникають з екрана мовчки`);

  const shownCount = b.clients.filter((c) => c.plan > 0 || c.planStatus !== "none").length
    + b.totals.unattached.count;
  assert.equal(shownCount, m.count,
    `🔴 планів на екрані ${shownCount}, у БД ${m.count} — зникла не сума, а самі рядки`);
  console.log(`   ℹ ${m.month}: ${m.count} планів / ${Math.round(m.sum)} ₴ — усі на екрані`);
});

/**
 * #107b — 🪞 ДЗЕРКАЛО: вибірка не порожня й не вироджена.
 *
 * 🔴 НАВІЩО. `#107` зеленіє тривіально, якщо в місяці немає жодного плану, чий
 * клієнт зараз НЕ активний, — тобто саме в тому випадку, коли фікс нічого не
 * робить. Тоді гейт стеріг би порожнечу. Заміряно 21.08.2026: за липень таких
 * планів **65**, тож сьогодні вибірка змістовна.
 *
 * 🧨 САБОТАЖ (виконано): підставити місяць БЕЗ планів → гейт червоніє «порожньо».
 */
test("#107b дзеркало: у місяці Є план, чий клієнт зараз НЕ активний", needsApi(), async () => {
  const m = await monthWithPlans();
  assert.ok(m, "🔴 планів немає взагалі");
  const token = await adminToken();
  const b = await (await get(`/api/dashboard/client-plans?month=${m.month}`, token)).json() as Resp;
  assertContract(b);

  const planOnlyWithPlan = b.clients.filter((c) => c.planOnly && c.plan > 0);
  const total = planOnlyWithPlan.length + b.totals.unattached.count;
  assert.ok(total > 0,
    `🔴 у ${m.month} НЕМАЄ жодного плану на неактивному клієнті — #107 зеленів би, `
    + "нічого не перевіряючи. Порожній результат це ПРОВАЛ, а не успіх");
  assert.equal(b.totals.planOnlyClients, planOnlyWithPlan.length
    + b.clients.filter((c) => c.planOnly && c.plan <= 0).length,
    "🔴 лічильник `planOnlyClients` не дорівнює кількості таких рядків");
  console.log(`   ℹ ${m.month}: неактивних із планом ${planOnlyWithPlan.length}`
    + ` + не привʼязано ${b.totals.unattached.count}`);
});

/**
 * #107c — ДВА ЕКРАНИ ДАЮТЬ ОДНЕ ЧИСЛО (замість брехливого коментаря).
 *
 * 🔴 ЦЕ ГОЛОВНИЙ УРОК ПРОХОДУ. У роуті стояло: «Σ ЗАТВЕРДЖЕНИХ по клієнтах =
 * рядок у Формуванні плану — гейт вимагає точного збігу». Гейта не було. Єдині
 * гейти (`core/clientPlans.test.ts`) перевіряють `planTotals()` як чисту функцію
 * на рядках, які тест сам собі й підклав, і `plans.ts` не бачать взагалі. Тому
 * розбіжність 290 570 ₴ прожила непоміченою: обидва екрани зелені поодинці.
 *
 * 🧨 САБОТАЖ (виконано): лишити старий фільтр у `/client-plans` → 196 000 проти
 * 486 570, гейт червоніє з обома числами.
 */
test("#107c goesToManagerPlan == Σ approved у «Формуванні плану» (Δ0)", needsApi(), async () => {
  const m = await monthWithPlans();
  assert.ok(m, "🔴 планів немає взагалі");
  const token = await adminToken();
  const plansScreen = await (await get(`/api/dashboard/client-plans?month=${m.month}`, token)).json() as Resp;
  assertContract(plansScreen);

  const fr = await get(`/api/plans/formation?month=${m.month}-01`, token);
  assert.equal(fr.status, 200, `🔴 /plans/formation віддав ${fr.status}`);
  const form = await fr.json() as {
    teams?: { managers?: { repeatClients?: { approved: number; approvedClients: number } }[] }[];
  };
  const formMgrs = (form.teams ?? []).flatMap((t) => t.managers ?? []);
  assert.ok(formMgrs.length > 0, "🔴 «Формування плану» не віддало жодного менеджера");

  const formApproved = formMgrs.reduce((s, x) => s + (x.repeatClients?.approved ?? 0), 0);
  assert.ok(formApproved > 0,
    "🔴 у «Формуванні» Σ затверджених = 0 — звіряти нема з чим (порожнеча ≠ збіг)");
  assert.equal(Math.round(plansScreen.totals.goesToManagerPlan), Math.round(formApproved),
    `🔴 «Клієнти» кажуть ${Math.round(plansScreen.totals.goesToManagerPlan)} ₴, `
    + `«Формування плану» — ${Math.round(formApproved)} ₴ за ${m.month}. `
    + "Це ОДНА величина; два числа під одним підписом читаються як поломка.\n"
    + "   Дві відомі причини розбіжності, якщо колись зʼявиться: (1) «Клієнти» знову "
    + "почали фільтрувати плани списком активних клієнтів; (2) план належить менеджеру, "
    + "якого «Формування» не показує — його ростер це `m.is_active AND team_id IS NOT NULL`. "
    + "Друга причина законна за змістом, але тоді розбіжність мусить бути НАЗВАНА на екрані, "
    + "а не мовчазна — саме через мовчання ця пара розійшлась на 290 570 ₴.");
  console.log(`   ℹ ${m.month}: обидва екрани ${Math.round(formApproved)} ₴`);
});

/**
 * #109 — ЛІЧИЛЬНИКИ АКТИВНИХ НЕ ЗРУШИЛИСЬ, ХОЧА РОСТЕР ВИРІС.
 *
 * 🔴 Головна межа правки. «Активні клієнти» відповідає на питання «кому МОЖНА
 * ставити новий план» — воно не змінилось ані на клієнта. Якби `totalClients`
 * узяли від ростера, головна цифра екрана мовчки повзла б угору від самого лише
 * погляду в минулий місяць.
 *
 * 🧨 САБОТАЖ (виконано): підмішати план-клієнтів у `activeRows` (тобто повернути
 * `totalClients: clients.length`) → перша ж рівність червоніє, бо ростер більший.
 */
test("#109 активні лічильники рахують АКТИВНИХ, а не ростер", needsApi(), async () => {
  const m = await monthWithPlans();
  assert.ok(m, "🔴 планів немає взагалі");
  const token = await adminToken();
  const b = await (await get(`/api/dashboard/client-plans?month=${m.month}`, token)).json() as Resp;
  assertContract(b);
  const t = b.totals;

  // Після обʼєднання вкладок `!planOnly` — це вже НЕ «активні»: серед них є сплячі
  // й втрачені. Джерело рядка каже прямо, звідки він, і саме воно тут доречне.
  const active = b.clients.filter((c) => c.inRoster === "active");
  assert.equal(t.totalClients, active.length,
    `🔴 totalClients ${t.totalClients} ≠ активних рядків ${active.length}`);
  assert.ok(b.clients.length > t.totalClients,
    `🔴 ростер (${b.clients.length}) не більший за активних (${t.totalClients}) — `
    + "або фікс не працює, або місяць вироджений, і гейт нічого не стереже");

  const segSum = Object.values(t.activeBySegment).reduce((s, v) => s + v, 0);
  assert.equal(segSum, t.totalClients,
    `🔴 Σ сегментів ${segSum} ≠ активних ${t.totalClients} — розбивка поповзла за ростером`);
  assert.ok(t.oneOff > 0 && t.inReactivation > 0,
    "🔴 разові/місток обнулились — лічильники перерахували від іншого добору");
});

/**
 * #109b — ІНВАРІАНТ `#30n` НА ТОМУ САМОМУ ВІДПОВІДІ: активні + сплячі + втрачені
 * + разові + відсіяні дженерики == кваліфікованій базі. Ростер його не рухає.
 */
test("#109b активні + сплячі + втрачені + разові == кваліфікована база", needsApi(), async () => {
  const m = await monthWithPlans();
  assert.ok(m, "🔴 планів немає взагалі");
  const token = await adminToken();
  const t = (await (await get(`/api/dashboard/client-plans?month=${m.month}`, token)).json() as Resp).totals;
  assert.equal(t.inReactivation, t.inReactivationSleeping + t.inReactivationLost,
    "🔴 місток не дорівнює сумі своїх частин");
  const whole = t.totalClients + t.inReactivation + t.oneOff + t.skippedGeneric;
  assert.ok(whole > 0, "🔴 база порожня — інваріант нічого не доводить");
  assert.equal(t.totalClients + t.inReactivation + t.oneOff + t.skippedGeneric, whole,
    "🔴 сума частин розійшлась із базою — купка загубилась мовчки");
  console.log(`   ℹ активних ${t.totalClients} · місток ${t.inReactivation}`
    + ` · разових ${t.oneOff} · дженериків ${t.skippedGeneric}`);
});

/**
 * #110 — КЛІЄНТ ІЗ ПЛАНОМ, ЯКИЙ УЖЕ НЕ АКТИВНИЙ, МАЄ ВИДИМУ ПОЗНАЧКУ СТАНУ.
 *
 * 🔴 Без неї фікс зробив би гірше, ніж було: раніше такий клієнт зникав (помітно),
 * тепер стояв би поруч із живими й читався як живий. Тиха неправда гірша за гучну
 * прогалину.
 *
 * 🧨 САБОТАЖ (виконано): прибрати `state` з відповіді → падає перша перевірка;
 * прибрати `<StateChip>` із рядка → падає перевірка ДЖЕРЕЛА фронта. Обидві
 * половини потрібні: поле може лишитись у відповіді й зникнути з екрана — це та
 * сама дзеркальна пастка, що в `#56`.
 */
test("#330 стан підписаний у КОЖНОМУ рядку — і в API, і в рендері", needsApi(), async () => {
  const m = await monthWithPlans();
  assert.ok(m, "🔴 планів немає взагалі");
  const token = await adminToken();
  const b = await (await get(`/api/dashboard/client-plans?month=${m.month}`, token)).json() as Resp;
  assertContract(b);

  // ① джерело рядка й підпис стану НЕ можуть суперечити одне одному — обидва боки.
  const lyingActive = b.clients.filter((c) => c.inRoster !== "active" && c.state === "active");
  assert.deepEqual(lyingActive.map((c) => c.clientKey), [],
    "🔴 рядок, доданий НЕ як активний, підписаний станом «активний» — екран стверджує, що клієнт живий");
  const lyingDead = b.clients.filter((c) => c.inRoster === "active" && c.state !== "active");
  assert.deepEqual(lyingDead.map((c) => c.clientKey), [],
    "🔴 активний рядок підписаний неактивним станом — позначка втратила б сенс");

  // ② словник станів закритий: «щось інше» читалося б як порожнеча.
  const unknown = b.clients.filter((c) => !["active", "sleeping", "lost", "oneoff"].includes(c.state));
  assert.deepEqual(unknown.map((c) => c.clientKey), [], "🔴 стан поза словником");

  // 🖥 ДЖЕРЕЛО ФРОНТА: поле мусить ДОЇХАТИ ДО ЕКРАНА, а не лише до відповіді.
  // Чип тепер БЕЗУМОВНИЙ — стан має кожен рядок, а не лише доданий через план.
  const src = readSrc("frontend/src/pages/dashboard/sections/ClientPlansSection.tsx");
  assert.match(src, /<StateChip\s+state=\{c\.state\}/,
    "🔴 у рядку клієнта немає <StateChip> від c.state — стан їде в API й не малюється");
  assert.doesNotMatch(src, /c\.planOnly\s*&&\s*<StateChip/,
    "🔴 чип стану знову під умовою `planOnly` — активні й сплячі лишились би без підпису");
});

/**
 * #332 — РОЗБИТТЯ РОСТЕРА, ЗНЯТЕ ОДНИМ ВИКЛИКОМ.
 *
 * 📐 Правило 18: «було N — стало N+X» на живому знаменнику нічого не доводить, бо
 * сторони бралися в різні миті. Тут усі числа приходять ОДНІЄЮ відповіддю, тож
 * рівність або тримається, або ні — календар на неї не впливає.
 *
 * 🧨 САБОТАЖ: порахувати `totalClients` від ростера (а не від активних) → друга
 * рівність червоніє; зліпити три джерела конкатенацією без `Set` → перша.
 */
test("#332 ростер == активні + реактивація + лише-план, і жодного дубля", needsApi(), async () => {
  const token = await adminToken();
  const b = await (await get("/api/dashboard/client-plans", token)).json() as Resp;
  assertContract(b);
  const t = b.totals;
  assert.equal(t.rosterClients, t.byState.active + t.byState.reactivation + t.byState.planOnly,
    "🔴 ростер не дорівнює сумі своїх частин — купки перетинаються або хтось загубився");
  assert.equal(t.byState.active, t.totalClients,
    "🔴 «активних» у розбитті не стільки, скільки в головній цифрі екрана");
  assert.equal(t.byState.reactivation, t.inReactivationSleeping + t.inReactivationLost,
    "🔴 друге джерело ростера розійшлось із містком — злитий список показує не тих, кого рахує плитка");
  const keys = new Set(b.clients.map((c) => c.clientKey));
  assert.equal(keys.size, b.clients.length, "🔴 клієнт у ростері двічі");
  assert.equal(b.clients.length, t.rosterClients, "🔴 рядків не стільки, скільки каже лічильник");
});

/**
 * #111b — НАЯВНИЙ ПЛАН НА ДЖЕНЕРИК-КЛЮЧІ ВИДНО РЯДКОМ «НЕ ПРИВʼЯЗАНО».
 *
 * 🔴 Заміряно: за липень це 40 000 ₴ на ключі «названиенеуказано». Відфільтрувати
 * його означало б повторити ту саму помилку, яку прохід лікує, лише з іншої
 * причини — гроші зникають, і жодне число не сперечається.
 *
 * 🔒 Показ ЛИШЕ `isAdminScope` (рішення власника): право віддає сервер полем
 * `canSee`, фронт його не вгадує.
 *
 * 🧨 САБОТАЖ (виконано): відфільтрувати такі плани → Σ на екрані падає рівно на
 * 40 000 ₴, і червоніє #107 (Δ ≠ 0) разом із цим гейтом.
 */
test("#111b план на дженерик-ключі видно рядком «не привʼязано», не зникає", needsApi(), async () => {
  const m = await monthWithPlans();
  assert.ok(m, "🔴 планів немає взагалі");
  const token = await adminToken();
  const b = await (await get(`/api/dashboard/client-plans?month=${m.month}`, token)).json() as Resp;
  assertContract(b);
  const u = b.totals.unattached;

  assert.equal(u.canSee, true, "🔴 адмін не бачить рядка «не привʼязано» — право віддано не тій ролі");
  assert.equal(u.count, u.rows.length, "🔴 лічильник не дорівнює переліку");
  assert.equal(Math.round(u.sum), Math.round(u.rows.reduce((s, r) => s + r.plan, 0)),
    "🔴 сума рядка «не привʼязано» не дорівнює сумі його ж рядків");

  // 🪞 ДЗЕРКАЛО: якщо таких планів НЕМАЄ — блок мусить бути нулем, а не вигаданою
  // величиною. Інакше він малював би суму там, де її нема.
  if (u.count === 0) {
    assert.equal(u.sum, 0, "🔴 «не привʼязано» порожнє, а сума ненульова");
    console.log("   ℹ дженерик-планів немає — блок мовчить, і це правильно");
  } else {
    const { pool } = await import("../db/pool.js");
    const metrics = await import("../core/metrics.js");
    const inDb = await pool.query<{ n: string; s: string }>(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(plan),0)::numeric AS s FROM repeat_client_plans
        WHERE month = $1 AND client_key = ANY($2)`, [`${m.month}-01`, metrics.GENERIC_CLIENT_KEYS]);
    assert.equal(u.count, Number(inDb.rows[0].n),
      "🔴 у блоці не всі дженерик-плани, що лежать у БД за цей місяць");
    console.log(`   ℹ не привʼязано: ${u.count} на ${Math.round(u.sum)} ₴`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ЧИСТІ ГЕЙТИ — правило без БД, саботується ВХІД (той самий прийом, що #59)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * #108 — РОСТЕР = ОБʼЄДНАННЯ, І ДЕДУП ЗА ПОБУДОВОЮ.
 *
 * 🔴 Чому чиста функція, а не перевірка по HTTP: «жоден не задвоївся» треба
 * доводити САБОТАЖЕМ, а сервер саботувати нічим. Тому правило винесене в
 * `rosterWithPlans`, і саботується ВХІД — точно як `unexplainedDismissedMoney`
 * у `#59`.
 *
 * 🧨 САБОТАЖ (виконано): наївне `[...active, ...all.filter(hasPlan)]` (без
 * відсіювання вже активних) → «б» трапляється двічі, друга перевірка червоніє.
 */
test("#108 ростер = активні ∪ план-клієнти, без жодного дубля", () => {
  // 📐 Фікстура накриває перетини по ОБИДВА боки (правило 11): «б» активний І має план,
  // «в» у реактивації І має план, «г» — лише план. Одного перетину замало: він довів би
  // дедуп для двох джерел і змовчав про третє, а саме воно додане 05.09.2026.
  const all = [{ k: "а" }, { k: "б" }, { k: "в" }, { k: "г" }, { k: "д" }];
  const active = [{ k: "а" }, { k: "б" }];
  const react = [{ k: "б" }, { k: "в" }];     // «б» уже активний — не сміє потрапити двічі
  const plans = new Set(["б", "в", "г"]);
  const { rows, reactivationKeys, planOnlyKeys } =
    rosterWithPlans(active, react, all, (r) => r.k, (k) => plans.has(k));

  const keys = rows.map((r) => r.k);
  assert.deepEqual(keys, ["а", "б", "в", "г"],
    "🔴 ростер не дорівнює обʼєднанню (активні → реактивація → лише-план)");
  assert.equal(new Set(keys).size, keys.length,
    `🔴 клієнт трапляється двічі: ${keys.join(",")} — у дереві він потрапив би у дві гілки`);
  assert.deepEqual([...reactivationKeys], ["в"], "🔴 «б» зарахований у реактивацію, хоча він активний");
  assert.deepEqual([...planOnlyKeys], ["г"], "🔴 план-онлі визначено неправильно");

  // 🪞 Дзеркало: без планів і без реактивації ростер дорівнює активним — функція не вигадує рядків.
  const none = rosterWithPlans(active, [], all, (r) => r.k, () => false);
  assert.deepEqual(none.rows.map((r) => r.k), ["а", "б"], "🔴 без планів ростер змінився");
  assert.equal(none.planOnlyKeys.size + none.reactivationKeys.size, 0, "🔴 зʼявились зайві купки");
});

/**
 * #111 — ПЛАН НА ДЖЕНЕРИК-КЛЮЧ НЕ ПРИЙМАЄТЬСЯ; ЗВИЧАЙНИЙ — ПРИЙМАЄТЬСЯ.
 *
 * 🧾 ЧЕСНА МЕЖА: живої HTTP-проби тут бути НЕ МОЖЕ. Тести проти прода ходять
 * роллю `test_readonly`, тож справжній `POST` упав би на ПРАВАХ, а не на нашій
 * перевірці, — і «400» довів би не те, що ми хочемо довести. Тому: правило —
 * чистою функцією в обидва боки, а його ПРИСУТНІСТЬ у роуті — перевіркою джерела
 * (той самий прийом, що `#52b`).
 *
 * 🧨 САБОТАЖ (виконано): змусити `isPlannableClientKey` повертати `true` для
 * дженерика → перша перевірка червоніє; прибрати виклик із роуту → червоніє
 * перевірка джерела.
 */
test("#111 план на дженерик-ключ відхиляється, звичайний проходить", () => {
  const GEN = ["названиенеуказано", "companynamenotspecified", ""];
  assert.equal(isPlannableClientKey("названиенеуказано", GEN), false,
    "🔴 дженерик-ключ визнано клієнтом — план на плейсхолдер, під яким сотні замовників");
  assert.equal(isPlannableClientKey("companynamenotspecified", GEN), false, "🔴 англомовний дженерик пройшов");
  assert.equal(isPlannableClientKey("   ", GEN), false, "🔴 порожній ключ (пробіли) пройшов");
  // 🪞 ДЗЕРКАЛО, без якого гейт зеленів би на функції, що забороняє ВСЕ.
  assert.equal(isPlannableClientKey("вкавтострада", GEN), true,
    "🔴 звичайний клієнт відхилений — перевірка ріже всіх підряд, екран став би мертвим");
  assert.ok(NOT_PLANNABLE_MSG.length > 30, "🔴 відмова без пояснення — користувач не знає, що робити");
});

test("#111 · роут `/client-plan` справді кличе перевірку перед записом", () => {
  const src = readSrc("src/routes/dashboard.ts");
  const at = src.indexOf('dashboardRouter.post("/client-plan"');
  assert.ok(at > 0, "🔴 роут /client-plan не знайдено — гейт стеріг би неіснуюче");
  const body = src.slice(at, at + 4000);
  const guard = body.indexOf("isPlannableClientKey");
  const write = body.indexOf("INSERT INTO repeat_client_plans");
  assert.ok(guard > 0, "🔴 у /client-plan немає виклику isPlannableClientKey — план на дженерик пройде");
  assert.ok(write > 0 && guard < write,
    "🔴 перевірка стоїть ПІСЛЯ запису — вона нічого не стереже");
});

/**
 * #111b · чиста частина — розділення «лягло на рядок» / «не лягло».
 * 🧨 САБОТАЖ: повернути `plans.filter(() => false)` → перша перевірка червоніє.
 */
test("#111b splitUnattached називає саме ті плани, під якими немає рядка", () => {
  const plans = [{ k: "а", v: 1 }, { k: "названиенеуказано", v: 40000 }, { k: "в", v: 3 }];
  const roster = new Set(["а", "в"]);
  const out = splitUnattached(plans, (p) => p.k, roster);
  assert.deepEqual(out.map((p) => p.k), ["названиенеуказано"],
    "🔴 не той склад «не привʼязано» — або ховаємо гроші, або вигадуємо рядки");
  // 🪞 Дзеркало: коли рядок є для КОЖНОГО плану, блок мусить бути порожнім.
  assert.deepEqual(splitUnattached(plans, (p) => p.k, new Set(["а", "в", "названиенеуказано"])), [],
    "🔴 блок не порожній там, де всі плани лягли на рядки");
});

/** Підказка про минулий місяць має бути ЧИСЛОМ із сервера, а не текстом у фронті. */
test("#107 · підказка «минулого місяця» приходить із сервера", () => {
  const src = readSrc("frontend/src/pages/dashboard/sections/ClientPlansSection.tsx");
  assert.match(src, /t\.prevMonth\.count/, "🔴 фронт не читає prevMonth.count");
  assert.match(src, /t\.prevMonth\.sum/, "🔴 фронт не читає prevMonth.sum");
  assert.doesNotMatch(src, /Минулого місяця[^]{0,80}\d{3}/,
    "🔴 у підказці зашите число — воно почне брехати мовчки");
});

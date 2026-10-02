import { test } from "node:test";
import assert from "node:assert/strict";
import { maySubmit, mayApprove, mayEverSubmit, submitRefusal } from "./planScope.js";

/**
 * ГЕЙТИ МЕЖІ ПОДАННЯ ПЛАНУ (#279…#279c).
 *
 * 🔴 ЧОМУ ЦІ ГЕЙТИ ВЗАГАЛІ Є. 03.09.2026 власник сказав: «менеджер подає, тім-лід
 * затверджує». Код казав протилежне, і кнопка чесно не малювалась. Правлячи це,
 * найлегше відкрити подання ЧУЖОГО плану: менеджер бачить УСЮ свою команду, тож
 * «дозволити менеджерам» одним прапорцем = дозволити подавати за колег.
 * Тому кожна заборона тут іде ПАРОЮ з дозволом: односторонній гейт зеленіє і тоді,
 * коли фіча зламана повністю — зріж усім, і «менеджер не подає за колегу» стане
 * зеленим, а подання мертвим.
 */

const MGR = (id: number, team: number | null) => ({ role: "manager", managerId: id, teamId: team });
const LEAD = (team: number | null) => ({ role: "team_lead", managerId: null, teamId: team });
const ADMIN = { role: "admin", managerId: null, teamId: null };

test("#279 МЕЖА: менеджер НЕ подає план колеги (навіть зі своєї команди)", () => {
  assert.equal(maySubmit(MGR(7, 3), { managerId: 8, teamId: 3 }), false,
    "менеджер подав за колегу по команді — саме це відкриває «Подати» на чужих рядках");
  assert.equal(maySubmit(MGR(7, 3), { managerId: 8, teamId: 9 }), false, "…і за чужу команду теж ні");
  assert.equal(submitRefusal(MGR(7, 3), { managerId: 8, teamId: 3 }), "Лише свій план",
    "відмова мусить НАЗИВАТИ причину: «не сталося нічого» — це той дефект, який ми щойно лікували боргом 15");
});

test("#279b ДЗЕРКАЛО: менеджер подає СВІЙ план", () => {
  assert.equal(maySubmit(MGR(7, 3), { managerId: 7, teamId: 3 }), true,
    "менеджер не може подати власний план — фіча мертва, а #279 при цьому зелений");
  assert.equal(submitRefusal(MGR(7, 3), { managerId: 7, teamId: 3 }), null, "свій план не має давати відмови");
});

test("#279c ТІМЛІД І АДМІН: обидва боки межі, і порожній скоуп НЕ збігається", () => {
  assert.equal(maySubmit(LEAD(3), { managerId: 8, teamId: 3 }), true, "тімлід мусить подавати за свою команду");
  assert.equal(maySubmit(LEAD(3), { managerId: 8, teamId: 9 }), false, "тімлід подав за ЧУЖУ команду");
  /**
   * 🔴 Порожній скоуп не можна виражати значенням. При простому `a.teamId === t.teamId`
   * тімлід без команди діставав би ВСІХ менеджерів без команди — дірка відтворюється
   * під іншим значенням, і гейт лишається зеленим із тієї самої причини.
   */
  assert.equal(maySubmit(LEAD(null), { managerId: 8, teamId: null }), false,
    "тімлід без команди дістав менеджера без команди — `null === null` знову відкрив скоуп");
  assert.equal(maySubmit(ADMIN, { managerId: 8, teamId: 9 }), true, "адмін подає за будь-кого");
  assert.equal(maySubmit({ role: "company", managerId: null, teamId: null }, { managerId: 8, teamId: 9 }), false,
    "company-роль дістала подання — це зрушення клітинки матриці, якого прохід не замовляв");
  assert.equal(mayApprove(LEAD(3)), false, "затвердження лишається адміну — прохід його не рухав");
  assert.equal(mayApprove(ADMIN), true, "адмін мусить затверджувати");
});

/**
 * #279h — ГРУБИЙ ФІЛЬТР РОЛІ, і він існує заради ЗЛІПКА, а не заради безпеки.
 *
 * Межу тримає `maySubmit`; цей фільтр лише не дає 403 перетворитись на 400 у ролей,
 * яких прохід не замовляв. Без нього дельта матриці була б у кількох клітинках
 * замість однієї — а зсув, якого ніхто не хотів, помічають найпізніше.
 */
test("#279h ГРУБИЙ ФІЛЬТР: подання взагалі недоступне ролям поза трійкою", () => {
  for (const r of ["admin", "team_lead", "manager"])
    assert.equal(mayEverSubmit(r), true, `${r} мусить доходити до перевірки цілі`);
  for (const r of ["company", "ceo", "hr", "financier", "opdir", ""])
    assert.equal(mayEverSubmit(r), false,
      `🔴 роль «${r}» пройшла грубий фільтр — її 403 стане 400, і клітинка зліпка зрушиться мовчки`);
});

import { readFileSync as readSrc } from "node:fs";
import pathMod from "node:path";
import { commercialPlanRefusal, NON_COMMERCIAL_PLAN_TEXT } from "./planScope.js";

/**
 * #1255 — ПЛАН ПРОДАЖІВ ЛИШЕ КОМЕРЦІЙНИМ КОМАНДАМ (рішення власника 02.10.2026): лідогенерація (стара 11,
 * нова 50011), фінанси (12) і людина без команди — відмова; продажна команда — так. Обидва боки межі.
 * 🧨 САБОТАЖ: у `commercialPlanRefusal` прибрати `teamId == null ||` → «без команди» проходить → червоніє.
 */
test("#1255 ПЛАН ПРОДАЖІВ: лідогенерація, фінанси й «без команди» — відмова; продажна команда — так", () => {
  const NC = [11, 12, 50011];
  for (const t of [50011, 11, 12, null]) {
    assert.equal(commercialPlanRefusal(t, NC), NON_COMMERCIAL_PLAN_TEXT, `🔴 команді ${t} можна поставити план продажів`);
  }
  for (const t of [5, 6, 13, 14, 15, 37283]) assert.equal(commercialPlanRefusal(t, NC), null, `🔴 продажній команді ${t} заборонено план`);
});

/**
 * #1256 — ПРАВИЛО ЗАСТОСОВАНЕ ВСЮДИ, ДЕ ПЛАН ПРОДАЖІВ ПИШЕТЬСЯ Й СУМУЄТЬСЯ: прямий запис адміна, подання,
 * затвердження (некомерційні рядки не переходять у `plans`), ростер екрана формування і «план компанії» Огляду.
 * Привід: 02.10.2026 140 000 ₴ планів лідгенів затвердили через формування, і Огляд з КВП показали інший
 * план компанії, ніж Звіт продажів.
 * 🧨 САБОТАЖ: прибрати `AND ${metrics.commercialManagerSql("m")}` із запиту затвердження → червоніє.
 */
test("#1256 ПЛАН ПРОДАЖІВ: запис, подання, затвердження, ростер формування й план Огляду — лише комерційні", () => {
  const SRC = pathMod.join(import.meta.dirname, "..", "..", "src");
  const plans = readSrc(pathMod.join(SRC, "routes", "plans.ts"), "utf8");
  const handler = (sig: string) => { const i = plans.indexOf(sig); assert.ok(i > 0, `🔴 ${sig} не знайдено`); return plans.slice(i, plans.indexOf("\n});", i)); };
  const direct = handler('plansRouter.post("/", requireRole("admin")');
  assert.ok(direct.indexOf("commercialPlanRefusal(") > 0 && direct.indexOf("commercialPlanRefusal(") < direct.indexOf("INSERT INTO plans"),
    "🔴 прямий запис у plans без перевірки «комерційний»");
  const submit = handler('plansRouter.post("/formation/submit"');
  assert.ok(submit.indexOf("commercialPlanRefusal(") > 0 && submit.indexOf("commercialPlanRefusal(") < submit.indexOf("INSERT INTO plan_formation"),
    "🔴 подання плану продажів без перевірки «комерційний»");
  const approve = handler('plansRouter.post("/formation/approve"');
  assert.match(approve, /pf\.status = 'submitted' \$\{scopeSql\}\s*\n\s*AND \$\{metrics\.commercialManagerSql\("m"\)\}/,
    "🔴 затвердження переносить у plans і некомерційні рядки");
  // Ростер формування живе в `core/plans.formationRoster` (#1300); комерційна умова їде в нього аргументом.
  assert.match(handler('plansRouter.get("/formation"'), /formationRoster\(pool, teamId \?\? null, metrics\.commercialManagerSql\("m"\)\)/,
    "🔴 екран формування показує некомерційні команди");
  const dash = readSrc(pathMod.join(SRC, "routes", "dashboard.ts"), "utf8");
  assert.match(dash, /WHERE p\.metric = 'payment_amount'\s*\n\s*AND \$\{metrics\.commercialManagerSql\("mp"\)\}/,
    "🔴 «план компанії» Огляду сумує й некомерційні команди");
});

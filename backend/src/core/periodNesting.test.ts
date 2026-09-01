import { test } from "node:test";
import assert from "node:assert/strict";
import { needsApi, needsBackendEnv, API_BASE } from "../testMode.js";
import { kyivMonthBounds } from "./dates.js";

/**
 * 🪆 #46c — ВКЛАДЕНИЙ ПЕРІОД: СКЛАД УГОД ТИЖНЯ ⊆ СКЛАД УГОД МІСЯЦЯ.
 *
 * 🔴 ЦЕ НОВИЙ НОМЕР, А НЕ ПЕРЕЙМЕНОВАНИЙ `#46`, І ТАК ТРЕБА. Твердження змінилось:
 * було «факт тижня ≤ факт місяця», стало «склад тижня входить у склад місяця».
 * Уточнювати назву старому номеру заборонено — реєстр звіряє ІМʼЯ, тож уточнення
 * читається як «гейт зник + зʼявився новий», лише без сліду про те, що це рішення.
 * `#46` **знято свідомо** (31.08.2026): його форма не витримала знакової величини.
 *
 * 🔴 ПРИВІД — ЖИВІ ДАНІ, А НЕ МІРКУВАННЯ. Возович Антон, серпень 2026:
 * тиждень `31.08..31.08` = **184 901**, місяць `01.08..31.08` = **179 581**.
 * Порушення рівно **5 320** — стільки ж, скільки дає єдиний інший ненульовий день
 * місяця, `24.08 = −5 320` (12 угод із `is_minus=true`). Тобто підмножина
 * перевищила ціле не через дефект, а тому що решта періоду відʼємна.
 * Заміряно тоді ж: `success` в обох вікнах збігався до копійки (194 401 / 71),
 * адитивність по днях точна (Δ = 0), `#46b` сходився. Ламався САМЕ гейт.
 *
 * 📊 5 менеджерів · 54 мінусові угоди · −181 339 ₴ за серпень — ось чому стара
 * форма червоніла ВИПАДКОВО: усе залежало від того, по який бік межі тижня лягло
 * сторно. Того дня порушник був один із 24.
 *
 * ⚠️ Гроші тут не перевіряються НАВМИСНО: тотожність `факт == успішно + оплачено`
 * тримає `#46b`. Два гейти на одне правило розходяться мовчки.
 */
/**
 * ⚠️ `needsBackendEnv`, а не `needsDb`: гейт імпортує `core/money.js` → `db/pool.js`
 * → `config.js`, який кидає `Missing required env var: JWT_SECRET` ще НА ІМПОРТІ.
 * У контейнері `DATABASE_URL` є, а `JWT_SECRET` немає, тож `needsDb()` пустив би
 * гейт до виконання, і він упав би на ОТОЧЕННІ, а не на дефекті — тобто додав би
 * падіння, яке наступний прохід списав би на свою зміну.
 */
test("#46c склад угод тижня ⊆ склад угод місяця", needsBackendEnv(), async () => {
  const [{ receivedDealIds }, { fixedWeekBlocks }, { subsetViolations }] = await Promise.all([
    import("./money.js"), import("./dates.js"), import("./periodNesting.js"),
  ]);
  // Київське «сьогодні» — те саме, від якого рахує `dynamicTarget`.
  const kyivToday = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
  const monthStart = `${kyivToday.slice(0, 7)}-01`;
  const blocks = fixedWeekBlocks(monthStart);
  const monthEnd = blocks[blocks.length - 1].to;
  const today = kyivToday > monthEnd ? monthEnd : kyivToday;
  const week = blocks.find((w) => today >= w.from && today <= w.to) ?? blocks[blocks.length - 1];

  const [inner, outer] = await Promise.all([
    receivedDealIds({ from: week.from, to: today, teamId: null, managerId: null }),
    receivedDealIds({ from: monthStart, to: monthEnd, teamId: null, managerId: null }),
  ]);

  /**
   * 🪞 ДЗЕРКАЛО ВСЕРЕДИНІ: включення ТРИВІАЛЬНО істинне на порожньому вікні.
   * Порожній результат — це ПРОВАЛ заміру, а не «все гаразд».
   */
  assert.ok(outer.length > 0, "🔴 у місяці нема ЖОДНОЇ отриманої угоди — перевіряти нічого");
  assert.ok(inner.length > 0,
    `🔴 у тижні ${week.from}..${today} нема ЖОДНОЇ угоди — включення зелене, але порожнє`);

  const bad = subsetViolations(inner, outer);
  assert.deepEqual(bad.map((d) => `менеджер ${d.managerId}, угода ${d.kommoId}`), [],
    "🔴 угода тижня ВІДСУТНЯ в місяці — тиждень і місяць рахують РІЗНИМИ метриками "
    + "під однаковими підписами (саме це і є предмет гейта)");
});

/**
 * 🧨 #46d — САБОТАЖ: угода, якої немає в місяці, мусить червоніти.
 * Фікстура, а не живі дані: живі не дають підкинути угоду, а перевірка на живому
 * стані була б привʼязана до наявності стану — третій випадок цього класу за тиждень.
 */
test("#46d САБОТАЖ: угода в тижні, якої немає в місяці — ЧЕРВОНЕ", async () => {
  const { subsetViolations } = await import("./periodNesting.js");
  const month = [{ managerId: 41, kommoId: 1 }, { managerId: 41, kommoId: 2 }];
  const week = [{ managerId: 41, kommoId: 2 }, { managerId: 41, kommoId: 999 }];
  assert.deepEqual(subsetViolations(week, month), [{ managerId: 41, kommoId: 999 }],
    "🔴 підкинута угода не спіймана — гейт беззубий");
  // Та сама угода в ІНШОГО менеджера — теж порушення: пара (менеджер, угода), не угода.
  assert.equal(subsetViolations([{ managerId: 7, kommoId: 1 }], month).length, 1,
    "🔴 угоду зараховано чужому менеджеру й це пройшло — ключ загубив менеджера");
});

/**
 * 🪞 #46e — ДЗЕРКАЛО, ГОЛОВНІШЕ ЗА ПРЯМУ ПРОБУ: законне сторно поза тижнем — ЗЕЛЕНЕ.
 *
 * Фікстура відтворює ВИПАДОК, який зняв `#46`: місяць = {+184 901 (31.08), −5 320
 * (24.08)}, тиждень = {+184 901}. Нова форма мовчить, і тут-таки доводиться, що
 * СТАРА на цих самих даних була б червоною — інакше «зелено» не відрізнити від
 * «перевірка нічого не перевіряє».
 */
test("#46e ДЗЕРКАЛО: сторно поза тижнем — ЗЕЛЕНЕ, а стара форма була б червоною", async () => {
  const { subsetViolations, sumFormWouldFail } = await import("./periodNesting.js");
  const plus = { managerId: 41, kommoId: 184901 };   // 31.08 · +184 901
  const minus = { managerId: 41, kommoId: 5320 };    // 24.08 · −5 320 (is_minus)
  const month = [plus, minus], week = [plus];

  assert.deepEqual(subsetViolations(week, month), [],
    "🔴 нова форма червоніє на законному сторно — вона успадкувала хворобу старої");
  /**
   * 🔴 ПО ОБИДВА БОКИ МЕЖІ, І ЦЕ НЕ ПЕДАНТИЗМ — СПІЙМАНО САБОТАЖЕМ 31.08.2026.
   * Перша редакція стверджувала лише `sumFormWouldFail(...) === true`, і підміна
   * тіла функції на `return true` лишала гейт ЗЕЛЕНИМ: твердження задовольняла
   * вироджена реалізація. Фікстура з одного значення не перевіряє властивості —
   * потрібен приклад по обидва боки тієї межі, яку гейт стереже.
   */
  assert.equal(sumFormWouldFail(184_901, 184_901 - 5_320), true,
    "🔴 стара форма на ЦИХ даних НЕ падає — тоді фікстура не відтворює випадок, "
    + "і зелене вище нічого не доводить");
  assert.equal(sumFormWouldFail(184_901, 184_901 + 5_320), false,
    "🔴 стара форма падає ЗАВЖДИ — тобто вона вироджена, і перша половина цього "
    + "дзеркала задовольняється чим завгодно");
});

/**
 * #46b — РОЗКЛАД ФАКТУ СХОДИТЬСЯ: факт = успішно(142) + оплачено(етап 9).
 * Без цього #46 зеленів би й тоді, коли `fact` віддає щось третє: нерівність
 * «тиждень ≤ місяць» тримається для будь-якої достатньо великої величини.
 * Саме ця рівність і є твердженням «місяць рахує ② », а не просто «щось велике».
 */
test("#46b факт місяця == успішно + оплачено (розклад ②)", needsApi(), async () => {
  const { signToken } = await import("../auth/auth.js");
  const token = signToken({ userId: 0, role: "admin", roleKey: "admin", managerId: null, teamId: null });
  const ym = kyivMonthBounds().ym;
  const from = `${ym}-01`;
  const to = kyivMonthBounds().to;
  const r = await fetch(`${API_BASE}/api/dashboard/report-plan?from=${from}&to=${to}`,
    { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200, `🔴 /report-plan віддав ${r.status}`);
  const body = await r.json() as { managers: { name: string; fact: number; factSuccess: number; factPaid: number }[] };
  const mgrs = body.managers ?? [];
  assert.ok(mgrs.length > 0, "🔴 у звіті нема жодного менеджера — перевіряти нічого");
  assert.ok(mgrs.some((m) => m.factPaid !== 0),
    "🔴 у ЖОДНОГО менеджера немає оплачених (етап 9) — рівність зійшлась би й на ①, "
    + "тобто саме той випадок, який ми ловимо, лишився б непоміченим");
  const off = mgrs
    .filter((m) => Math.abs(m.fact - (m.factSuccess + m.factPaid)) > 1)
    .map((m) => `${m.name}: ${m.fact} ≠ ${m.factSuccess} + ${m.factPaid}`);
  assert.deepEqual(off, [], "🔴 факт не дорівнює розкладу — місяць рахує НЕ ②");
});

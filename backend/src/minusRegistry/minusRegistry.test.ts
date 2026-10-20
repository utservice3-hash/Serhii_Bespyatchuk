import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";
import {
  ACTIONS, FROM, TO, allowedActions, canSee, canSubmit, changesBetween, checkComment, checkDealId, checkNote, defaultFilter,
  describeChange, minusGrew, needsMe, revokeNote, seesAll, type CrmDeal, type Line, type RegUser, type Status,
} from "./shared/minusRegistry.js";
import { esc, fmtType, fmtWhen, grn, nf, plural, sgn } from "./shared/minusFormat.js";
import { KOMMO_FIELDS, KOMMO_FIELD_NAMES, leadLines, leadToCrmDeal, num, pickClient, stageName, type KommoContact, type KommoLead, type KommoPipeline } from "./shared/kommoMapping.js";
import { KommoError, kommoDealSource, type DealSource } from "./kommoSource.js";
import { ACCOUNTING_ROLE_KEY, approverIds, registryRoleOf } from "./roles.js";

/**
 * 📒 РЕЄСТР МІНУСОВИХ УГОД (пакет Сергія, 20.10.2026). Тести пакета (vitest, 30 шт.) перенесено в наш набір групами —
 * ті самі твердження й тексти; інтеграційні (60 перевірок) — у `#1843` через НАШ вхід, вкладку й ролі, а не через
 * підставного `req.user`, як у пакеті. Макетні e2e (Playwright) у набір не входять — їх замінює скріншот приймання.
 */
const SRC = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "src", p), "utf8");
const FRONT = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", p), "utf8");

const U = {
  marina: { id: "u-marina", name: "Марина", role: "manager" } as RegUser,
  iryna: { id: "u-iryna", name: "Ірина", role: "lead" } as RegUser,
  serhii: { id: "u-serhii", name: "Сергій", role: "approver" } as RegUser,
  buh: { id: "u-buh", name: "Бухгалтерія", role: "accounting" } as RegUser,
  admin: { id: "u-admin", name: "Адмін", role: "viewer" } as RegUser,
};
const STATUSES: Status[] = ["pending", "returned", "approved", "paid", "rejected"];
const q = (status: Status, createdBy = "u-marina") => ({ status, createdBy });
const L = (sum: number, type: string, net: number): Line => ({ sum, type, net });
const deal = (inc: Line[], exp: Line[]): CrmDeal => {
  const incTotal = inc.reduce((s, x) => s + x.net, 0), expTotal = exp.reduce((s, x) => s + x.net, 0);
  return { dealId: "1", name: "Київ – Одеса", stage: "Перевезення завершено", client: "К", carrier: "П", inc, exp, incTotal, expTotal, budget: incTotal - expTotal };
};

/**
 * #1840 — ПРАВА Й ПЕРЕХОДИ (пакет: «права (рішення 20.10)», «перевірки — тексти як у макеті»).
 * Усе бачать Сергій, бухгалтерія й адміни; менеджер і тім-лід — лише свої; подають лише вони; матриця дій за статусом;
 * лічильник; фільтр за замовчуванням; тексти перевірок дослівно як у макеті. Червоніє, якщо дати адміну дію, менеджеру —
 * чужий запит або змінити текст, який бачить людина.
 */
test("#1840 РЕЄСТР МІНУСОВИХ: права, матриця дій, лічильник, тексти перевірок — як у пакеті", () => {
  assert.ok([U.serhii, U.buh, U.admin].every((u) => seesAll(u.role)));
  assert.equal(seesAll("manager") || seesAll("lead"), false);
  assert.equal(canSee(U.marina, q("pending", "u-marina")), true);
  assert.equal(canSee(U.marina, q("pending", "u-oleh")), false, "менеджер бачить чужий запит");
  assert.equal(canSee(U.iryna, q("pending", "u-marina")), false, "тім-лід бачить чужий запит");
  assert.equal(canSee(U.buh, q("paid", "u-oleh")), true);
  assert.equal(canSubmit("manager") && canSubmit("lead"), true);
  assert.equal(canSubmit("approver") || canSubmit("accounting") || canSubmit("viewer"), false, "подає хтось, крім менеджера й тім-ліда");
  const m = (u: RegUser, createdBy = "u-marina") => Object.fromEntries(STATUSES.map((s) => [s, allowedActions(u, q(s, createdBy)).join(",")]));
  assert.deepEqual(m(U.serhii), { pending: "approve,return,reject", returned: "", approved: "", paid: "", rejected: "" });
  assert.deepEqual(m(U.buh), { pending: "", returned: "", approved: "paid", paid: "", rejected: "" });
  assert.deepEqual(m(U.marina), { pending: "", returned: "resubmit", approved: "", paid: "", rejected: "" });
  assert.deepEqual(m(U.marina, "u-oleh"), { pending: "", returned: "", approved: "", paid: "", rejected: "" });
  assert.equal(m(U.iryna, "u-iryna").returned, "resubmit");
  assert.equal(Object.values(m(U.admin)).join(""), "", "у «інших адмінів» зʼявилась дія");
  for (const a of ACTIONS) assert.ok(allowedActions(a === "paid" ? U.buh : a === "resubmit" ? U.marina : U.serhii, q(FROM[a])).includes(a));
  assert.deepEqual(TO, { approve: "approved", return: "returned", reject: "rejected", paid: "paid", resubmit: "pending" });
  assert.deepEqual(STATUSES.filter((s) => needsMe(U.serhii, q(s))), ["pending"]);
  assert.deepEqual(STATUSES.filter((s) => needsMe(U.buh, q(s))), ["approved"]);
  assert.deepEqual(STATUSES.filter((s) => needsMe(U.marina, q(s))), ["returned"]);
  assert.deepEqual(STATUSES.filter((s) => needsMe(U.marina, q(s, "u-oleh"))), []);
  assert.deepEqual(STATUSES.filter((s) => needsMe(U.admin, q(s))), []);
  assert.deepEqual([defaultFilter("approver"), defaultFilter("accounting"), defaultFilter("manager"), defaultFilter("lead"), defaultFilter("viewer")],
    ["pending", "approved", "all", "all", "all"]);
  assert.equal(checkDealId("62850311"), null);
  assert.equal(checkDealId(" 62850311 "), null);
  for (const bad of ["12", "abc", "6285-0311", "", "1234567890123", 62850311]) assert.equal(checkDealId(bad), "Введіть ID угоди з CRM — лише цифри.");
  assert.equal(checkComment("   "), "Напишіть, чому угода мінусова.");
  assert.equal(checkComment(undefined), "Напишіть, чому угода мінусова.");
  assert.equal(checkComment("x".repeat(2001)), "Коментар — до 2000 символів.");
  assert.equal(checkComment(" Клієнт не погодився "), null);
  assert.equal(checkNote("return", ""), "Напишіть, що доопрацювати.");
  assert.equal(checkNote("reject", " "), "Напишіть причину відмови.");
  assert.equal(checkNote("return", "Додай рахунок"), null);
  assert.equal(checkNote("approve", undefined), null);
  assert.equal(checkNote("paid", undefined), null);
});

/**
 * #1840b — «МІНУС ЗРІС» І ФОРМАТ (пакет: «мінус зріс», «формат»). Бюджет зменшився — погодження знімається, доплата
 * клієнта — ні; підписи й числа дослівно як у макеті v5. Червоніє, якщо порівняння стане «≤» або зміниться підпис.
 */
test("#1840b РЕЄСТР МІНУСОВИХ: «мінус зріс» по обидва боки, підписи й формат як у макеті v5", () => {
  const approved = deal([L(34000, "Безнал без НДС", 31960)], [L(35000, "Безнал без НДС", 32900)]);
  const added = deal([L(34000, "Безнал без НДС", 31960)], [L(35000, "Безнал без НДС", 32900), L(3000, "Безнал без НДС", 2820)]);
  assert.equal(approved.budget, -940);
  assert.equal(minusGrew(approved.budget, added), true, "мінус зріс, а погодження не знімається");
  assert.equal(minusGrew(-940, { budget: -940 }), false, "той самий мінус знімає погодження");
  assert.equal(minusGrew(-940, { budget: -100 }), false, "доплата клієнта знімає погодження");
  assert.equal(describeChange(approved, added), "У CRM додано розхід 2 — 3 000 грн.");
  assert.equal(revokeNote(approved.budget, approved, added), "Маржа в CRM: −940 → −3 760 грн. Додано розхід 2 — 3 000 грн.");
  const a = deal([L(20000, "Безнал без НДС", 18800), L(2000, "Наличные", 2000)], [L(19000, "Безнал без НДС", 17860)]);
  const b = deal([L(18000, "Безнал без НДС", 16920)], [L(19000, "Безнал с НДС", 14440)]);
  assert.deepEqual(changesBetween(a, b), ["прихід 1: 20 000 → 18 000 грн", "прибрано прихід 2 — 2 000 грн", "розхід 1: Безнал без НДС → Безнал с НДС"]);
  assert.equal(describeChange(a, b), "У CRM: прихід 1: 20 000 → 18 000 грн; прибрано прихід 2 — 2 000 грн; розхід 1: Безнал без НДС → Безнал с НДС.");
  const c = deal([L(20000, "Безнал без НДС", 18400)], []);
  const d = deal([L(20000, "Безнал без НДС", 18800)], []);
  assert.deepEqual(changesBetween(d, c), ["прихід 1: розрахунок 18 800 → 18 400 грн"]);
  assert.equal(describeChange(d, { ...d, budget: d.budget - 5 }), "У CRM змінився бюджет угоди.");
  assert.equal(nf(19000), "19 000");
  assert.equal(nf(1234567.5), "1 234 567,5");
  assert.equal(grn(-1520), "−1 520 грн");
  assert.equal(grn(27360), "27 360 грн");
  assert.equal(sgn(-600), "−600 грн");
  assert.equal(sgn(1880), "+1 880 грн");
  assert.equal(sgn(0), "0 грн");
  assert.equal(fmtType({ type: "Безнал без НДС" }), "Безнал без НДС");
  assert.equal(fmtType({ type: "ВАЛЮТА", cur: "$" }), "ВАЛЮТА $");
  assert.equal(fmtType({ type: "" }), "—");
  assert.equal(fmtWhen("2026-10-20T09:12:00"), "20.10 09:12");
  assert.equal(fmtWhen("погано"), "");
  assert.deepEqual([1, 2, 5, 11, 21, 22, 25].map((n) => `${n} ${plural(n, "угода", "угоди", "угод")}`), ["1 угода", "2 угоди", "5 угод", "11 угод", "21 угода", "22 угоди", "25 угод"]);
  assert.equal(esc("<b>\"ТОВ «Х»\" & 'Y'</b>"), "&lt;b&gt;&quot;ТОВ «Х»&quot; &amp; &#39;Y&#39;&lt;/b&gt;");
});

const lead = JSON.parse(SRC("minusRegistry/fixtures/kommo-lead.json")) as KommoLead;
const CARRIER = KOMMO_FIELDS.contactTypeCarrier;
const contact = (id: number, name: string, typeEnum?: number): KommoContact => ({ id, name, custom_fields_values: typeEnum ? [{ field_id: KOMMO_FIELDS.contactType, values: [{ value: "x", enum_id: typeEnum }] }] : null });
const PIPES: KommoPipeline[] = [
  { id: 8921932, name: "Перевозки (Продажі повний цикл) (New)", _embedded: { statuses: [{ id: 98470988, name: "Первезення завершено" }, { id: 142, name: "УСПІШНА УГОДА " }] } },
  { id: 7341740, name: "Оплата перевозчикам", _embedded: { statuses: [{ id: 142, name: "Оплачено" }] } },
];

/**
 * #1841 — МАПІНГ KOMMO → РЕЄСТР (пакет: «ID полів Kommo», «угода Kommo → реєстр»). 35 полів (звірено 20.10 і нашим
 * токеном), числа рядком і числом, порожні слоти пропущено, валюта лише для ВАЛЮТА, клієнт — не контакт-перевізник, етап у
 * воронці угоди, повна угода з підсумками й бюджетом з CRM як є. Червоніє на зсуві ID чи перерахунку замість CRM.
 */
test("#1841 РЕЄСТР МІНУСОВИХ: мапінг Kommo — 35 полів, рядки, клієнт, етап, бюджет з CRM як є", () => {
  assert.equal(Object.keys(KOMMO_FIELD_NAMES).length, 35);
  assert.equal(KOMMO_FIELD_NAMES[2097649], "Расчет приходов");
  assert.equal(KOMMO_FIELD_NAMES[2097665], "Расход 3");
  assert.equal(KOMMO_FIELD_NAMES[2099903], "Валюта прихода 1");
  assert.equal(KOMMO_FIELD_NAMES[2097493], "Назва перевізника");
  assert.deepEqual([num({ value: "19000" }), num({ value: 27360 }), num({ value: "2528,5" }), num({ value: "" }), num(null), num({ value: "н/д" })], [19000, 27360, 2528.5, null, null, null]);
  assert.deepEqual(leadLines(lead, "inc"), [{ sum: 36000, type: "Безнал с НДС", net: 27360 }, { sum: 2000, type: "Наличные", net: 2000 }]);
  assert.deepEqual(leadLines(lead, "exp"), [{ sum: 38000, type: "Безнал с НДС", net: 28880 }, { sum: 2690, type: "Безнал без НДС", net: 2528.5 }]);
  const v = (type: string) => leadLines({ custom_fields_values: [
    { field_id: 2097627, values: [{ value: "500" }] }, { field_id: 2097629, values: [{ value: type }] }, { field_id: 2097639, values: [{ value: "20500" }] }, { field_id: 2099903, values: [{ value: "$" }] },
  ] }, "inc");
  assert.deepEqual(v("ВАЛЮТА"), [{ sum: 500, type: "ВАЛЮТА", net: 20500, cur: "$" }]);
  assert.deepEqual(v("Наличные"), [{ sum: 500, type: "Наличные", net: 20500 }]);
  assert.equal(pickClient(lead, [contact(501, "ТОВ «Галицька Кераміка»", 1042469), contact(502, "Андрій Перевізник", CARRIER)]), "ТОВ «Галицька Кераміка»");
  assert.equal(pickClient(lead, [contact(501, "Водій Іван", CARRIER), contact(502, "Олена")]), "Олена");
  assert.equal(pickClient(lead, []), "");
  assert.equal(stageName(PIPES, { pipeline_id: 8921932, status_id: 98470988 }), "Первезення завершено");
  assert.equal(stageName(PIPES, { pipeline_id: 7341740, status_id: 142 }), "Оплачено");
  assert.equal(stageName(PIPES, { pipeline_id: 1, status_id: 5 }), "Етап 5");
  assert.deepEqual(leadToCrmDeal(lead, [contact(501, "ТОВ «Галицька Кераміка»")], "Первезення завершено"), {
    dealId: "62000001", name: "Київ – Львів 18.10.2026", stage: "Первезення завершено", client: "ТОВ «Галицька Кераміка»", carrier: "ФОП Кравець О. П.",
    inc: [{ sum: 36000, type: "Безнал с НДС", net: 27360 }, { sum: 2000, type: "Наличные", net: 2000 }],
    exp: [{ sum: 38000, type: "Безнал с НДС", net: 28880 }, { sum: 2690, type: "Безнал без НДС", net: 2528.5 }],
    incTotal: 29360, expTotal: 31408.5, budget: -2048,
  });
  const bare: KommoLead = { ...lead, price: null, custom_fields_values: (lead.custom_fields_values || []).filter((f) => ![KOMMO_FIELDS.carrier, KOMMO_FIELDS.incTotal, KOMMO_FIELDS.expTotal].includes(f.field_id as never)) };
  const bd = leadToCrmDeal(bare, [], "X");
  assert.deepEqual([bd.carrier, bd.client, bd.incTotal, bd.expTotal, bd.budget], ["", "", 29360, 31408.5, -2048.5]);
  assert.equal(leadToCrmDeal({ ...bare, name: null }, [], "X").name, "Угода 62000001");
});

/**
 * #1841b — НАШ АДАПТЕР KOMMO (замість клієнта пакета): угода + контакти + воронки через наш `kommoGet` (фейк тут),
 * воронки кешуються; 404 і порожня відповідь — «угоди немає»; не цифри — навіть не питаємо; 401/403 — 502 «перевірте
 * токен», серія 403 («circuit open») і 429 — 503, мережа — 504; текст помилки без токена. Червоніє, якщо адаптер почне
 * ковтати відмову доступу як «угоди немає» або проситиме Kommo на кривий ID.
 */
test("#1841b РЕЄСТР МІНУСОВИХ: адаптер на нашому клієнті Kommo — угода, кеш воронок, 404 → немає, помилки → 502/503/504", async () => {
  const calls: string[] = [];
  const fake = (routes: Record<string, () => unknown>) => (async <T>(p: string): Promise<T> => {
    calls.push(p);
    const key = Object.keys(routes).find((k) => p.includes(k));
    if (!key) return {} as T;                                      // наш клієнт на 204 віддає `{}`
    return routes[key]() as T;
  });
  const src = kommoDealSource(fake({
    "/api/v4/leads/62000001?with=contacts": () => lead,
    "/api/v4/contacts?filter[id][]=": () => ({ _embedded: { contacts: [contact(501, "ТОВ «Галицька Кераміка»"), contact(502, "Водій", CARRIER)] } }),
    "/api/v4/leads/pipelines": () => ({ _embedded: { pipelines: PIPES } }),
  }));
  const d = await src.fetchDeal("62000001");
  assert.deepEqual(d && [d.client, d.stage, d.carrier, d.budget], ["ТОВ «Галицька Кераміка»", "Первезення завершено", "ФОП Кравець О. П.", -2048]);
  await src.fetchDeal("62000001");
  assert.equal(calls.filter((c) => c === "/api/v4/leads/pipelines").length, 1, "воронки не кешуються");
  calls.length = 0;
  const thrower = (msg: string) => kommoDealSource((async () => { throw new Error(msg); }) as never);
  assert.equal(await thrower("Kommo API error 404: {}").fetchDeal("404"), null, "404 — це «угоди немає», а не помилка");
  assert.equal(await src.fetchDeal("1;drop"), null);
  assert.equal(calls.length, 0, "на кривий ID пішов запит у Kommo");
  for (const [msg, status] of [["Kommo API error 401: x", 502], ["Kommo API error 403: x", 502], ["Kommo circuit open: пауза ще ~5 хв", 503], ["Kommo API error 429: x", 503], ["fetch failed", 504]] as const) {
    const e = await thrower(msg).fetchDeal("7").catch((x: unknown) => x);
    assert.ok(e instanceof KommoError, `«${msg}» не став KommoError`);
    assert.equal((e as KommoError).status, status, `«${msg}» → не ${String(status)}`);
  }
  const e401 = await thrower("Kommo API error 401: Bearer секрет-для-тесту").fetchDeal("7").catch((x: unknown) => x) as KommoError;
  assert.match(e401.message, /токен/);
  assert.doesNotMatch(e401.message, /секрет/, "токен потрапив у текст помилки");
});

/**
 * #1842 — РОЛІ ДАШБОРДА → РОЛІ РЕЄСТРУ (ТЗ §0, §3 п.3–4, §13; рішення 20.10). Сергій (`users.id 1`) погоджує, хоч у
 * дашборді він ОД з адмінським рівнем; «Бухгалтерія» — `accounting`; менеджер і тімлід — подають; адмін / СЕО / ОД / КВП /
 * фінансист — лише перегляд; HR, кандидат — немає доступу. `MINUS_APPROVER_IDS` замінює Сергія, порожнє — Сергій.
 * Червоніє, якщо погодження віддати ролі «адмін» або загубити бухгалтерію.
 */
test("#1842 РЕЄСТР МІНУСОВИХ: ролі — погоджує лише Сергій, бухгалтерія «Оплачено», адмін-рівень дивиться, HR — ні", () => {
  const A = approverIds(undefined);
  assert.deepEqual(A, ["1"]);
  assert.deepEqual(approverIds(" 7, 9 "), ["7", "9"]);
  assert.deepEqual(approverIds(""), ["1"]);
  const r = (userId: number, roleKey: string, adminScope: boolean) => registryRoleOf({ userId, roleKey, adminScope }, A);
  assert.equal(r(1, "opdir", true), "approver", "Сергій не погоджує");
  assert.equal(r(2, "opdir", true), "viewer", "інший ОД погоджує");
  assert.equal(r(50, "admin", true), "viewer", "адмін погоджує — погоджує ЛИШЕ Сергій");
  for (const k of ["ceo", "kvp", "financier"]) assert.equal(r(60, k, true), "viewer", `${k} — не лише перегляд`);
  assert.equal(r(9, ACCOUNTING_ROLE_KEY, false), "accounting", "бухгалтерія не ставить «Оплачено»");
  assert.equal(r(10, "manager", false), "manager");
  assert.equal(r(11, "team_lead", false), "lead");
  for (const k of ["hr", "candidate", "business_assistant"]) assert.equal(r(12, k, false), null, `${k} має доступ до реєстру`);
});

/**
 * #1843 🪞 — НАСКРІЗНО НА ПОРОЖНЬОМУ КЛАСТЕРІ, ЧЕРЕЗ НАШ ВХІД (перенесено з `tests/integration/routes.integration.ts`
 * пакета): справжні токени, вкладка `registries` з ролей схеми, наша відповідність ролей і NAME_SQL; Kommo — фейк у памʼяті.
 * Покрито: вхід/HR без вкладки, ролі, «нова угода», подання зі знімком із CRM (не з браузера), дубль 409, хто що бачить,
 * права на дії 403/404/409, повернути → повторно, «мінус зріс» до погодження і після (звірка), доплата не знімає,
 * перевізник підтягується, «Оплачено» не звіряється, відхилити — остаточно, Kommo лежить, дві одночасні дії, кривий запит.
 * Червоніє на будь-якій зміні прав, переходу чи тексту.
 */
test("#1843 🪞 РЕЄСТР МІНУСОВИХ НАСКРІЗНО: наш вхід і ролі, повний цикл, «мінус зріс», звірка, одночасні дії", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET ??= "test";
  process.env.KOMMO_BASE_URL ??= "https://x.invalid";
  process.env.KOMMO_API_TOKEN ??= "test";
  delete process.env.MINUS_APPROVER_IDS;
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  let server: import("node:http").Server | null = null;
  try {
    await c.query(SRC("db/schema.sql"));
    // «Бухгалтерія» на проді створена в Налаштуваннях (у схемі з нуля її немає) — засіваємо, як вона є, і проганяємо
    // ТОЙ САМИЙ UPDATE зі схеми, що видає вкладку `registries`.
    await c.query(`INSERT INTO roles (key, name, built_in, data_scope, screen_access, permissions) VALUES ('${ACCOUNTING_ROLE_KEY}', 'Бухгалтерія', false, 'company', '{}'::jsonb, '{}'::jsonb) ON CONFLICT (key) DO NOTHING`);
    await c.query(SRC("db/schema.sql").slice(SRC("db/schema.sql").indexOf("UPDATE roles SET screen_access = screen_access || '{\"registries\":true}'")));
    await c.query(`INSERT INTO users (id, email, password_hash, role, role_override, full_name, is_active) VALUES
      (1, 'utservice3@gmail.com', 'x', 'admin', 'opdir', 'Сергій', true),
      (2, 'marina@t', 'x', 'manager', NULL, 'Марина Коваль', true), (3, 'oleh@t', 'x', 'manager', NULL, 'Олег Ткачук', true),
      (4, 'iryna@t', 'x', 'team_lead', NULL, 'Ірина Савчук', true), (5, 'admin2@t', 'x', 'admin', NULL, 'Інший адмін', true),
      (6, 'buh@t', 'x', 'manager', '${ACCOUNTING_ROLE_KEY}', 'Бухгалтерія', true), (7, 'hr@t', 'x', 'manager', 'hr', 'HR', true)`);

    const K: Record<string, number> = { "Наличные": 1, "Безнал без НДС": 0.94, "Безнал с НДС": 0.76 };
    const Lk = (sum: number, type: string): Line => ({ sum, type, net: Math.round(sum * K[type]) });
    const mk = (dealId: string, inc: Line[], exp: Line[], carrier = "ФОП Гнатюк І. М."): CrmDeal => {
      const incTotal = inc.reduce((s, x) => s + x.net, 0), expTotal = exp.reduce((s, x) => s + x.net, 0);
      return { dealId, name: `Київ – Львів ${dealId.slice(-2)}.10.2026`, stage: "Первезення завершено", client: "ТОВ «Подільський Млин»", carrier, inc, exp, incTotal, expTotal, budget: incTotal - expTotal };
    };
    const CRM = new Map<string, CrmDeal>();
    let kommoDown = false, kommoCalls = 0;
    const deals: DealSource = {
      async fetchDeal(id) {
        kommoCalls++;
        if (kommoDown) throw new KommoError("Kommo не відповідає — спробуйте за хвилину.", 504);
        const d = CRM.get(id); return d ? JSON.parse(JSON.stringify(d)) as CrmDeal : null;
      },
    };

    await import("../lib/asyncRoutes.js");   // як у проді: index.ts імпортує патч ПЕРШИМ — без нього async-throw роутера не дійде до його обробника
    const { default: express } = await import("express");
    const { buildMinusDealsRouter } = await import("./mount.js");
    const { syncStale } = await import("./sync.js");
    const { refreshRoles } = await import("../auth/rbac.js");
    const { signToken } = await import("../auth/auth.js");
    const { pool } = await import("../db/pool.js");
    await refreshRoles();
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use("/api/minus-deals", buildMinusDealsRouter(deals));
    server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const base = `http://127.0.0.1:${(server!.address() as import("node:net").AddressInfo).port}/api/minus-deals`;
    const TOK: Record<string, string> = {
      serhii: signToken({ userId: 1, role: "admin", roleKey: "opdir", managerId: null, teamId: null } as never),
      marina: signToken({ userId: 2, role: "manager", roleKey: "manager", managerId: null, teamId: null } as never),
      oleh: signToken({ userId: 3, role: "manager", roleKey: "manager", managerId: null, teamId: null } as never),
      iryna: signToken({ userId: 4, role: "team_lead", roleKey: "team_lead", managerId: null, teamId: null } as never),
      admin2: signToken({ userId: 5, role: "admin", roleKey: "admin", managerId: null, teamId: null } as never),
      buh: signToken({ userId: 6, role: "company", roleKey: ACCOUNTING_ROLE_KEY, managerId: null, teamId: null } as never),
      hr: signToken({ userId: 7, role: "company", roleKey: "hr", managerId: null, teamId: null } as never),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = async (who: string | null, method: string, p: string, body?: unknown, raw?: string): Promise<{ s: number; j: any }> => {
      const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...(who ? { authorization: `Bearer ${TOK[who]}` } : {}) }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
      let j: unknown = null; try { j = await r.json(); } catch { /* порожньо */ }
      return { s: r.status, j };
    };
    const status = async (id: string) => (await c.query("SELECT status FROM minus_deal_requests WHERE id = $1", [id])).rows[0].status as string;
    const counter = async (who: string) => (await call(who, "GET", "/counter")).j.count as number;

    CRM.set("62850311", mk("62850311", [Lk(19000, "Безнал с НДС")], [Lk(16000, "Безнал без НДС")]));            // −600
    CRM.set("62850312", mk("62850312", [Lk(30000, "Безнал без НДС")], [Lk(31000, "Безнал без НДС")], ""));      // −940, без перевізника
    CRM.set("62850313", mk("62850313", [Lk(12000, "Безнал с НДС")], [Lk(13000, "Безнал с НДС")]));            // −760
    CRM.set("62850314", mk("62850314", [Lk(10000, "Наличные")], [Lk(11000, "Безнал без НДС")]));              // −340

    // ---------- вхід, вкладка, ролі ----------
    let r = await call(null, "GET", ""); assert.equal(r.s, 401, "без входу пускає");
    r = await call("hr", "GET", ""); assert.equal(r.s, 403, "HR бачить реєстр — вкладку їй не видано");
    r = await call("marina", "GET", "");
    assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(r.j.me.role, "manager"); assert.equal(r.j.me.name, "Марина Коваль"); assert.equal(r.j.requests.length, 0);
    assert.equal((await call("serhii", "GET", "")).j.me.role, "approver", "Сергій (у дашборді ОД) не погоджує");
    assert.equal((await call("admin2", "GET", "")).j.me.role, "viewer");
    assert.equal((await call("buh", "GET", "")).j.me.role, "accounting");

    // ---------- нова угода ----------
    r = await call("marina", "GET", "/deal/12"); assert.equal(r.s, 400); assert.equal(r.j.error, "Введіть ID угоди з CRM — лише цифри.");
    r = await call("marina", "GET", "/deal/99999"); assert.equal(r.s, 404); assert.equal(r.j.error, "У CRM немає угоди 99999.");
    r = await call("marina", "GET", "/deal/62850311"); assert.equal(r.s, 200); assert.equal(r.j.budget, -600); assert.equal(r.j.inc[0].type, "Безнал с НДС");
    assert.equal((await call("serhii", "GET", "/deal/62850311")).s, 403, "Сергій подає угоди");
    assert.equal((await call("admin2", "POST", "", { dealId: "62850311", comment: "x" })).s, 403, "адмін подає угоди");
    r = await call("marina", "POST", "", { dealId: "62850311", comment: "   " }); assert.equal(r.s, 400); assert.equal(r.j.error, "Напишіть, чому угода мінусова.");
    r = await call("marina", "POST", "", { dealId: "62850311", comment: " Клієнт платить з ПДВ, перевізник без ПДВ. ", crm: { budget: 999999 } });
    const A = r.j?.id as string;
    assert.equal(r.s, 201, JSON.stringify(r.j)); assert.equal(r.j.status, "pending");
    assert.equal(r.j.crm.budget, -600, "знімок узято з браузера, а не з CRM");
    assert.equal(r.j.comment, "Клієнт платить з ПДВ, перевізник без ПДВ.");
    assert.equal(r.j.createdByName, "Марина Коваль"); assert.equal(r.j.hist.length, 1); assert.equal(r.j.hist[0].type, "submitted");
    r = await call("oleh", "POST", "", { dealId: "62850311", comment: "теж хочу" });
    assert.equal(r.s, 409); assert.equal(r.j.error, "Угода 62850311 уже в реєстрі — на погодженні."); assert.equal(r.j.requestId, A);
    assert.equal((await call("oleh", "GET", "/deal/62850311")).s, 409);
    r = await call("iryna", "POST", "", { dealId: "62850312", comment: "Термінове завантаження" }); const B = r.j.id as string;
    assert.equal(r.s, 201); assert.equal(r.j.crm.carrier, "");

    // ---------- хто що бачить ----------
    assert.equal((await call("oleh", "GET", "")).j.requests.length, 0, "менеджер бачить чужі запити");
    r = await call("iryna", "GET", ""); assert.deepEqual(r.j.requests.map((x: { id: string }) => x.id), [B], "тім-лід бачить не лише свої");
    r = await call("serhii", "GET", ""); assert.deepEqual(r.j.requests.map((x: { id: string }) => x.id), [B, A]);
    assert.equal((await call("admin2", "GET", "")).j.requests.length, 2);
    assert.deepEqual([await counter("serhii"), await counter("buh"), await counter("marina")], [2, 0, 0]);

    // ---------- права на дії ----------
    r = await call("marina", "POST", `/${A}/approve`, {}); assert.equal(r.s, 403); assert.equal(r.j.error, "Немає прав на цю дію.");
    assert.equal((await call("buh", "POST", `/${A}/approve`, {})).s, 403, "бухгалтерія погоджує");
    assert.equal((await call("admin2", "POST", `/${A}/approve`, {})).s, 403, "інший адмін погоджує");
    r = await call("oleh", "POST", `/${A}/resubmit`, {}); assert.equal(r.s, 404); assert.equal(r.j.error, "Запит не знайдено.");
    assert.equal((await call("serhii", "POST", `/${A}/paid`, {})).s, 403, "Сергій ставить «Оплачено»");
    assert.equal((await call("serhii", "POST", `/${A}/nonsense`, {})).s, 404);
    r = await call("buh", "POST", `/${A}/paid`, {}); assert.equal(r.s, 409); assert.equal(r.j.error, "Запит уже «На погодженні» — оновіть сторінку.");

    // ---------- повернути → виправити ----------
    r = await call("serhii", "POST", `/${A}/return`, { note: " " }); assert.equal(r.s, 400); assert.equal(r.j.error, "Напишіть, що доопрацювати.");
    r = await call("serhii", "POST", `/${A}/return`, { note: "Чи є перевізник з ПДВ?" });
    assert.equal(r.j.status, "returned"); assert.equal(r.j.hist.at(-1).note, "Чи є перевізник з ПДВ?"); assert.equal(r.j.hist.at(-1).byName, "Сергій");
    assert.deepEqual([await counter("marina"), await counter("serhii")], [1, 1]);
    r = await call("marina", "POST", `/${A}/resubmit`, { comment: "Перевізника з ПДВ немає, клієнт ставку не піднімає." });
    const ev = (await c.query("SELECT data FROM minus_deal_events WHERE request_id = $1 AND type = 'resubmitted'", [A])).rows[0];
    assert.equal(r.j.status, "pending"); assert.equal(ev.data.comment_before, "Клієнт платить з ПДВ, перевізник без ПДВ.");

    // ---------- погодити: мінус зріс, поки Сергій дивився ----------
    CRM.set("62850311", mk("62850311", [Lk(19000, "Безнал с НДС")], [Lk(16500, "Безнал без НДС")]));            // −1 070
    r = await call("serhii", "POST", `/${A}/approve`, { seenBudget: -600 });
    assert.equal(r.s, 409); assert.match(r.j.error, /збільшився/); assert.equal(r.j.request.crm.budget, -1070); assert.equal(await status(A), "pending");
    r = await call("serhii", "POST", `/${A}/approve`, { seenBudget: -1070 }); assert.equal(r.j.status, "approved"); assert.equal(r.j.grew, null);
    assert.equal(await counter("buh"), 1);
    r = await call("serhii", "POST", `/${A}/approve`, {}); assert.equal(r.s, 409); assert.equal(r.j.error, "Запит уже «Погоджено» — оновіть сторінку.");

    // ---------- звірка: «мінус зріс» після погодження; доплата не знімає; перевізник ----------
    CRM.set("62850311", mk("62850311", [Lk(19000, "Безнал с НДС")], [Lk(16500, "Безнал без НДС"), Lk(3000, "Безнал без НДС")]));
    let s = await syncStale(pool, deals, {});
    r = await call("serhii", "GET", ""); let a = r.j.requests.find((x: { id: string }) => x.id === A);
    assert.equal(s.revoked, 1, "мінус зріс, а погодження не знято"); assert.equal(a.status, "pending");
    assert.equal(a.grew.budget, -1070); assert.equal(a.grew.what, "У CRM додано розхід 2 — 3 000 грн."); assert.equal(a.crm.budget, -3890);
    const rv = a.hist.at(-1);
    assert.equal(rv.type, "revoked"); assert.equal(rv.by, null); assert.equal(rv.note, "Маржа в CRM: −1 070 → −3 890 грн. Додано розхід 2 — 3 000 грн.");
    assert.deepEqual([await counter("serhii"), await counter("buh")], [2, 0]);
    r = await call("serhii", "POST", `/${A}/approve`, { seenBudget: -3890 }); assert.equal(r.j.status, "approved");
    CRM.set("62850311", mk("62850311", [Lk(19000, "Безнал с НДС"), Lk(2000, "Наличные")], [Lk(16500, "Безнал без НДС"), Lk(3000, "Безнал без НДС")]));
    s = await syncStale(pool, deals, {});
    a = (await call("serhii", "GET", "")).j.requests.find((x: { id: string }) => x.id === A);
    assert.equal(s.revoked, 0, "доплата клієнта зняла погодження"); assert.equal(a.status, "approved"); assert.equal(a.crm.budget, -1890);
    CRM.set("62850312", mk("62850312", [Lk(30000, "Безнал без НДС")], [Lk(31000, "Безнал без НДС")], "ТОВ «Степ-Логістик»"));
    await syncStale(pool, deals, {});
    assert.equal((await call("iryna", "GET", "")).j.requests[0].crm.carrier, "ТОВ «Степ-Логістик»", "перевізник не підтягнувся");

    // ---------- бухгалтерія відкриває реєстр → свіжа звірка «Погоджено» ----------
    CRM.set("62850311", mk("62850311", [Lk(19000, "Безнал с НДС")], [Lk(16500, "Безнал без НДС"), Lk(3000, "Безнал без НДС"), Lk(1000, "Безнал без НДС")]));   // −4 830
    await c.query("UPDATE minus_deal_requests SET synced_at = now() - interval '10 minutes' WHERE id = $1", [A]);
    a = (await call("buh", "GET", "")).j.requests.find((x: { id: string }) => x.id === A);
    assert.equal(a.status, "pending", "бухгалтерія бачить «Погоджено», хоча мінус уже зріс"); assert.equal(a.crm.budget, -4830);
    await c.query("UPDATE minus_deal_requests SET synced_at = now() WHERE id = $1", [A]);
    kommoCalls = 0;
    await call("buh", "GET", ""); assert.equal(kommoCalls, 0, "свіжі запити звіряються повторно");
    r = await call("serhii", "POST", `/${A}/approve`, { seenBudget: -4830 }); assert.equal(r.j.status, "approved");

    // ---------- оплачено; відхилити — остаточно ----------
    r = await call("buh", "POST", `/${A}/paid`, {}); assert.equal(r.j.status, "paid"); assert.equal(r.j.hist.at(-1).byName, "Бухгалтерія");
    CRM.set("62850311", mk("62850311", [Lk(1000, "Наличные")], [Lk(50000, "Наличные")]));
    s = await syncStale(pool, deals, {});
    a = (await call("serhii", "GET", "")).j.requests.find((x: { id: string }) => x.id === A);
    assert.equal(a.status, "paid"); assert.equal(a.crm.budget, -4830, "«Оплачено» звіряється з CRM");
    r = await call("serhii", "POST", `/${B}/reject`, {}); assert.equal(r.s, 400); assert.equal(r.j.error, "Напишіть причину відмови.");
    r = await call("serhii", "POST", `/${B}/reject`, { note: "Ставка перевізника вища за ринок." }); assert.equal(r.j.status, "rejected");
    assert.equal((await call("iryna", "POST", `/${B}/resubmit`, { comment: "ще раз" })).s, 409);
    r = await call("iryna", "POST", "", { dealId: "62850312", comment: "нова спроба" }); assert.equal(r.s, 409); assert.equal(r.j.error, "Угода 62850312 уже в реєстрі — відхилено.");

    // ---------- Kommo недоступна ----------
    kommoDown = true;
    r = await call("oleh", "GET", "/deal/62850313"); assert.equal(r.s, 504); assert.match(r.j.error, /Kommo/);
    kommoDown = false;
    r = await call("oleh", "POST", "", { dealId: "62850313", comment: "Перша поїздка" }); const C = r.j.id as string;
    kommoDown = true;
    r = await call("serhii", "POST", `/${C}/approve`, { seenBudget: -760 }); assert.equal(r.s, 200); assert.equal(r.j.status, "approved");
    r = await call("buh", "GET", ""); assert.equal(r.s, 200); assert.equal(r.j.requests.length, 3);
    kommoDown = false;

    // ---------- дві дії одночасно ----------
    r = await call("marina", "POST", "", { dealId: "62850314", comment: "Догрузка" }); const D = r.j.id as string;
    const [x1, x2] = await Promise.all([call("serhii", "POST", `/${D}/approve`, {}), call("serhii", "POST", `/${D}/reject`, { note: "ні" })]);
    assert.equal([x1.s, x2.s].sort().join(), "200,409", "дві одночасні дії пройшли обидві");
    assert.equal(Number((await c.query("SELECT count(*) FROM minus_deal_events WHERE request_id = $1 AND type IN ('approved','rejected')", [D])).rows[0].count), 1);

    // ---------- кривий запит ----------
    r = await call("marina", "POST", "", undefined, "{\"dealId\":"); assert.equal(r.s, 400);
    r = await call("marina", "POST", "", { dealId: "62850315", comment: "x".repeat(2001) }); assert.equal(r.s, 400); assert.equal(r.j.error, "Коментар — до 2000 символів.");
  } finally {
    if (server) await new Promise((res) => server!.close(res));
    await c.end();
    const { pool } = await import("../db/pool.js");
    await pool.end().catch(() => undefined);
    scratch.dispose();
  }
});

/**
 * #1844 — ФРОНТ РЕЄСТРУ: спільний код (модель, формат) у фронті БАЙТ У БАЙТ бекендівський — права й тексти доведено на
 * бекенд-копії; пункт меню «Реєстри» з лічильником і маршрут сторінки; жодного `lazy(`/`import(` (#225 — один чанк);
 * запити — через наш `api` з токеном, не `fetch` з cookie; стилі — лише під `.mreg` / `.registries-page`.
 * Червоніє, якщо розвести копію, повернути lazy, cookie-клієнт чи глобальний селектор.
 */
test("#1844 ФРОНТ РЕЄСТРУ: модель = бекенд байт у байт, пункт «Реєстри», один чанк, наш api, CSS ізольовано", () => {
  for (const f of ["minusRegistry", "minusFormat"]) assert.equal(FRONT(`minusRegistry/shared/${f}.ts`), SRC(`minusRegistry/shared/${f}.ts`), `${f}.ts у фронті розійшовся з бекендом`);
  const layout = FRONT("components/Layout.tsx"), dash = FRONT("pages/Dashboard.tsx");
  assert.match(layout, /\{ key: "registries", label: "Реєстри", icon: "📒" \}/, "пункту меню «Реєстри» немає");
  assert.match(layout, /item\.key === "registries" \? registriesCount/, "у пункту меню немає лічильника");
  assert.match(dash, /\{section === "registries" && <RegistriesPage \/>\}/, "маршрут не рендерить сторінку «Реєстри»");
  const dir = path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", "minusRegistry", "client");
  const files = [...readdirSync(dir).map((f) => `minusRegistry/client/${f}`), ...readdirSync(path.join(dir, "minusRegistry")).map((f) => `minusRegistry/client/minusRegistry/${f}`)].filter((f) => /\.(ts|tsx|css)$/.test(f));
  assert.ok(files.length >= 7, `файлів фронту реєстру ${String(files.length)} — гейт нічого не перевіряє`);
  for (const f of files.filter((x) => /\.tsx?$/.test(x))) {
    const s = FRONT(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
    assert.ok(!/\blazy\(|\bimport\(/.test(s), `${f}: динамічний імпорт — другий чанк (#225)`);
    assert.ok(!/credentials:\s*['"]same-origin/.test(s), `${f}: cookie-клієнт пакета замість нашого api`);
  }
  assert.match(FRONT("minusRegistry/client/minusRegistry/api.ts"), /from '\.\.\/\.\.\/\.\.\/api'/, "клієнт реєстру не через наш api");
  for (const f of files.filter((x) => x.endsWith(".css"))) {
    // кадри анімації (`from{…}`) — не селектори; вирізаємо блоки @keyframes цілком
    const css = FRONT(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/@keyframes[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, "");
    const sel = css.match(/[^{}]+(?=\{)/g) ?? [];
    for (const raw of sel) {
      const x = raw.trim();
      if (!x || x.startsWith("@")) continue;
      assert.ok(/\.mreg|\.registries-page/.test(x), `${f}: глобальний селектор «${x}» — стилі мусять бути під .mreg`);
    }
  }
});

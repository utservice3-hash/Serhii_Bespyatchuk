import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { adClientKommoTarget, AD_CLIENT_LINKS_SQL } from "../core/adClientLinks.js";

/**
 * 🔎 #3318–#3318b — ТАБЛИЦЯ «КЛІЄНТИ З РЕКЛАМИ · ЗА LTV»: ПОСИЛАННЯ НА KOMMO І ФІЛЬТРИ (TOP Weekly 16.11.2026, Сергій:
 * «фільтр по кількості угод»; Роман 19.11: «додаємо фільтри і щоб назва клієнта відкривала його Kommo», дизайн А).
 *
 * Правила фільтра живуть у чистому модулі фронта `adsClientFilter.ts`, і гейт їх ВИКОНУЄ (транспіляція, як `#2447`),
 * а не читає очима. Друга половина — звірка джерела: правило в модулі нічого не варте, якщо екран його не кличе.
 * Живу повноту посилань тримає `#3318c` (`core/adsCohort.test.ts`, там уже є пул).
 */
const FE_DIR = "../../../frontend/src/pages/dashboard/sections/";
const FE_FILTER = fileURLToPath(new URL(`${FE_DIR}adsClientFilter.ts`, import.meta.url));
const FE_LIST = fileURLToPath(new URL(`${FE_DIR}AdsClientsList.tsx`, import.meta.url));
const FE_REGULARS = fileURLToPath(new URL(`${FE_DIR}AdsRegulars.tsx`, import.meta.url));
const ROUTE = fileURLToPath(new URL("../../src/routes/dashboard.ts", import.meta.url));

type Row = {
  name: string; campaign: string | null; qualified: boolean; segment: "vip" | "regular" | "episodic" | "unknown";
  state: "active" | "sleeping" | "lost" | null; deals: number; margin: number; repeatMargin: number;
};
type Filter = { minDeals: number; type: string | null; camp: null | "tagged" | "untagged" | { name: string }; state: string | null; q: string };
async function loadFilter(): Promise<{
  EMPTY_FILTER: Filter; DEAL_STEPS: readonly number[];
  filterAdsClients: (l: Row[], f: Filter) => Row[];
  summarizeAdsClients: (l: Row[]) => { clients: number; margin: number; repeat: number; active: number };
  activeFilterCount: (f: Filter) => number;
}> {
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(readFileSync(FE_FILTER, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return await import(`data:text/javascript,${encodeURIComponent(js)}`);
}
const row = (p: Partial<Row>): Row => ({
  name: "ТОВ \"Тест\"", campaign: "Camp_A", qualified: false, segment: "unknown", state: null, deals: 1, margin: 1000, repeatMargin: 0, ...p,
});

/**
 * #3318 — КУДИ ВЕДЕ НАЗВА КЛІЄНТА. Компанія → контакт → угода; кожен крок лише коли попереднього немає. У SQL — найсвіжіша
 * угода (`DESC`), бо компаній буває кілька (дублі в Kommo). Роут будує URL саме з цієї функції.
 * 🧨 Червоніє, якщо переставити порядок, забути запасну угоду, взяти найстарішу угоду чи роут перестане кликати модуль.
 */
test("#3318 ПОСИЛАННЯ НА KOMMO: компанія → контакт → угода, найсвіжіша угода, роут кличе модуль", () => {
  assert.deepEqual(adClientKommoTarget({ companyId: 11, contactId: 22, dealId: 33 }), { kind: "company", id: 11 }, "🔴 є компанія — а веде не на неї");
  assert.deepEqual(adClientKommoTarget({ companyId: null, contactId: 22, dealId: 33 }), { kind: "contact", id: 22 }, "🔴 фізособа без компанії — не на контакт");
  assert.deepEqual(adClientKommoTarget({ companyId: null, contactId: null, dealId: 33 }), { kind: "deal", id: 33 }, "🔴 нема ні компанії, ні контакту — клік мертвий");
  assert.equal(adClientKommoTarget({ companyId: null, contactId: null, dealId: null }), null, "🔴 вигадано посилання, якого в CRM немає");
  const orders = AD_CLIENT_LINKS_SQL.match(/ORDER BY x\.created_at_kommo (\w+)/g) ?? [];
  assert.equal(orders.length, 3, "🔴 у запиті посилань не три підзапити з порядком за датою угоди");
  assert.ok(orders.every((o) => o.endsWith("DESC")), "🔴 посилання береться не з найсвіжішої угоди клієнта");
  const route = readFileSync(ROUTE, "utf8");
  const at = route.indexOf('dashboardRouter.get("/ads/clients"');
  const body = route.slice(at, route.indexOf("dashboardRouter.", at + 10));
  assert.ok(at > 0, "🔴 роут /ads/clients не знайдено");
  assert.match(body, /\badClientLinks\(/, "🔴 роут не кличе adClientLinks");
  assert.match(body, /\bkommoCompanyUrl\(/, "🔴 роут не будує посилання на компанію");
  assert.match(body, /\bkommoContactUrl\(/, "🔴 роут не будує посилання на контакт");
  assert.match(body, /\bkommoUrl:/, "🔴 роут не віддає kommoUrl клієнту");
});

/**
 * #3318b — ФІЛЬТРИ СПИСКУ. Обидва боки кожної межі: «від 3» пропускає 3 і відсікає 2; «з міткою» ∪ «без мітки» = усі й
 * не перетинаються; тип «разовий» = не постійні, хоч би який сегмент; стан «невідомий» = null; пошук без регістру й лапок;
 * підсумок — рівно по показаних. Екран кличе ці функції і не рахує кількість угод сам.
 * 🧨 Червоніє, якщо `<` у межі угод замінити на `<=`, «без мітки» почне пропускати мічених, або список чи лічильники
 * меню фільтруватимуть своїм кодом.
 */
test("#3318b ФІЛЬТРИ КЛІЄНТІВ З РЕКЛАМИ: межа угод з обох боків, мітка ділить навпіл, разовий = не постійний, екран кличе модуль", async () => {
  const { EMPTY_FILTER, DEAL_STEPS, filterAdsClients, summarizeAdsClients, activeFilterCount } = await loadFilter();
  assert.deepEqual([...DEAL_STEPS], [1, 2, 3, 5, 10], "🔴 кроки «Угод від» не ті, що в плані (1·2·3·5·10)");
  const two = row({ name: "Два", deals: 2 }), three = row({ name: "Три", deals: 3 });
  const f3 = { ...EMPTY_FILTER, minDeals: 3 };
  assert.deepEqual(filterAdsClients([two, three], f3).map((r) => r.name), ["Три"], "🔴 «від 3» не пропустив 3 або пропустив 2");
  assert.equal(filterAdsClients([two, three], EMPTY_FILTER).length, 2, "🔴 порожній фільтр когось відсік");

  const tagged = row({ name: "Мічений", campaign: "S_Poputniy" }), bare = row({ name: "Без мітки", campaign: null });
  const all = [tagged, bare];
  const t = filterAdsClients(all, { ...EMPTY_FILTER, camp: "tagged" }), u = filterAdsClients(all, { ...EMPTY_FILTER, camp: "untagged" });
  assert.deepEqual([t.map((r) => r.name), u.map((r) => r.name)], [["Мічений"], ["Без мітки"]], "🔴 «з міткою»/«без мітки» ділять неправильно");
  assert.deepEqual(filterAdsClients(all, { ...EMPTY_FILTER, camp: { name: "S_Poputniy" } }).map((r) => r.name), ["Мічений"], "🔴 конкретна кампанія");

  const vipOnce = row({ name: "Разовий з сегментом", qualified: false, segment: "vip" });
  const vip = row({ name: "ВІП", qualified: true, segment: "vip" });
  assert.deepEqual(filterAdsClients([vipOnce, vip], { ...EMPTY_FILTER, type: "once" }).map((r) => r.name), ["Разовий з сегментом"],
    "🔴 «разовий» має бути «не постійний», а не сегмент");
  assert.deepEqual(filterAdsClients([vipOnce, vip], { ...EMPTY_FILTER, type: "vip" }).map((r) => r.name), ["ВІП"], "🔴 ВІП-фільтр пустив непостійного");

  const noState = row({ name: "Без стану", state: null }), active = row({ name: "Працює", state: "active", margin: 500, repeatMargin: 200 });
  assert.deepEqual(filterAdsClients([noState, active], { ...EMPTY_FILTER, state: "none" }).map((r) => r.name), ["Без стану"], "🔴 стан «невідомий»");
  assert.deepEqual(filterAdsClients([row({ name: 'ТОВ "БІНАРТ"' }), row({ name: "Інший" })], { ...EMPTY_FILTER, q: "  бінарт " }).map((r) => r.name),
    ['ТОВ "БІНАРТ"'], "🔴 пошук чутливий до регістру/лапок/пробілів");

  assert.deepEqual(summarizeAdsClients([noState, active]), { clients: 2, margin: 1500, repeat: 200, active: 1 }, "🔴 підсумок не по показаних");
  assert.equal(activeFilterCount({ ...EMPTY_FILTER, minDeals: 3, camp: "tagged" }), 2, "🔴 лічильник увімкнених фільтрів");

  const list = readFileSync(FE_LIST, "utf8");
  assert.match(list, /\bfilterAdsClients\(base, f\)/, "🔴 список фільтрує не модулем");
  assert.match(list, /\bsummarizeAdsClients\(list\)/, "🔴 підсумок рахується не модулем і не по показаних");
  assert.match(list, /countWith = \(p: Partial<AdsClientFilter>\) => filterAdsClients\(/, "🔴 лічильники меню рахуються не тим самим фільтром");
  assert.doesNotMatch(list, /\.deals\s*>=?\s*\w/, "🔴 екран сам порівнює кількість угод — друге правило поруч із модулем");
  assert.match(list, /href=\{c\.kommoUrl\}/, "🔴 назва клієнта не веде в Kommo");
  assert.match(readFileSync(FE_REGULARS, "utf8"), /<AdsClientsList\b/, "🔴 вкладка не показує новий список");
});

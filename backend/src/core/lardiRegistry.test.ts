import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { firmCode, parseLardiProfile, parseLardiUsers, parseRegistry, transportDivision } from "./lardiCheckRules.js";
import { REGISTRY_CACHE_DAYS, registryByCode, type Db } from "./lardiRegistry.js";

/**
 * 🏛 ВИД ДІЯЛЬНОСТІ З ЄДР ДЛЯ ЗНАЙДЕНОГО НА ЛАРДІ (24.11.2026). Гейти стережуть: код фірми — лише справжній код;
 * основний КВЕД — рівно один і першим; кожен запит до YouControl — гроші, тож повтор того самого коду йде з кешу,
 * а «оновлюється» не кешується; вердикт 8136 від реєстру не залежить. Фікстури — ВИГАДАНІ компанії.
 */
const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const src = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const LEGAL = {
  code: "12345678", contractorType: "Юридична особа (ЮО)", name: { fullName: "ТОВАРИСТВО «ПРИКЛАД ТРАНС»", shortName: "ТОВ «ПРИКЛАД ТРАНС»" },
  status: "Не перебуває в процесі припинення", registrationAfterLaw: { entryDate: "2017-03-14T00:00:00+02:00" },
  mainEconomicActivity: { code: "52.29", description: "Інша допоміжна діяльність у сфері транспорту" },
  economicActivities: [
    { isMain: false, code: "49.41", description: "Вантажний автомобільний транспорт" },
    { isMain: true, code: "52.29", description: "Інша допоміжна діяльність у сфері транспорту" },
    { isMain: false, code: "46.90", description: "Неспеціалізована оптова торгівля" },
    { isMain: false, code: "не код", description: "сміття" },
  ],
};

test("#11010 🪞 КОД ФІРМИ З ЛАРДІ: лише 8 або 10 цифр; решта — «немає», а не код", () => {
  assert.equal(firmCode("12345678"), "12345678");
  assert.equal(firmCode("1954701600"), "1954701600", "🔴 ІПН ФОП (10 цифр) не прийнято за код");
  assert.equal(firmCode(" 1234 5678 "), "12345678");
  assert.equal(firmCode(12345678), "12345678");
  for (const bad of ["", "1234567", "123456789", "12345678901", "АА123456", "00000000", null, undefined, {}, "12-34"]) {
    assert.equal(firmCode(bad), null, `🔴 «${String(bad)}» прийнято за код фірми — реєстр шукав би чужу компанію`);
  }
  assert.deepEqual(parseLardiProfile({ refId: 7, firmCode: "1954701600" }), { firmCode: "1954701600" });
  assert.deepEqual(parseLardiProfile({ refId: 7, firmCode: "0" }), { firmCode: null }, "🔴 сентинел «0» дійшов до реєстру");
  assert.equal(parseLardiProfile([{ firmCode: "12345678" }]), null, "🔴 масив розібрано як профіль");
  // Пошук за документацією теж може віддати код — тоді профіль не питаємо.
  assert.deepEqual(parseLardiUsers([{ refId: 1, name: "А", firmCode: "12345678" }]).map((u) => u.firmCode), ["12345678"]);
});

test("#11011 🪞 ЄДР → ВИДИ ДІЯЛЬНОСТІ: основний рівно один і першим, без повторів; невпізнане — порожньо, не вигадано", () => {
  const r = parseRegistry("12345678", LEGAL)!;
  assert.deepEqual(r.activities.map((a) => [a.code, a.main]), [["52.29", true], ["49.41", false], ["46.90", false]],
    "🔴 основний не першим, повтор основного або сміття в списку");
  assert.equal(r.activities.filter((a) => a.main).length, 1, "🔴 основних видів діяльності не рівно один");
  assert.deepEqual([r.name, r.fop, r.registered, r.closing], ["ТОВ «ПРИКЛАД ТРАНС»", false, "2017-03-14", false]);
  assert.deepEqual(r.activities.map((a) => a.transport !== null), [true, true, false], "🔴 транспортний розділ позначено не тим кодам");

  // Основний позначений лише `isMain` і стоїть у масиві НЕ першим — однаково першим у відповіді.
  const noMain = { ...LEGAL, mainEconomicActivity: undefined };
  assert.deepEqual(parseRegistry("12345678", noMain)!.activities.map((a) => [a.code, a.main]), [["52.29", true], ["49.41", false], ["46.90", false]],
    "🔴 основний вид діяльності не першим, коли реєстр поставив його в середину списку");
  // Дзеркало: основного немає в масиві, лише в mainEconomicActivity — він усе одно є й першим.
  const only = parseRegistry("12345678", { ...LEGAL, economicActivities: [{ isMain: false, code: "46.90", description: "Опт" }] })!;
  assert.deepEqual(only.activities.map((a) => [a.code, a.main]), [["52.29", true], ["46.90", false]]);
  // ФОП: імʼя рядком; без жодного виду діяльності — порожній список, а не вигаданий.
  const fop = parseRegistry("1234567890", { name: "ІВАНЕНКО ІВАН", contractorType: "Фізична особа-підприємець (ФОП)" })!;
  assert.deepEqual([fop.fop, fop.name, fop.activities], [true, "ІВАНЕНКО ІВАН", []]);
  assert.equal(parseRegistry("12345678", null), null, "🔴 порожня відповідь розібрана як компанія без діяльності");
  assert.equal(parseRegistry("12345678", { ...LEGAL, status: "припинено" })!.closing, true, "🔴 припинену компанію не позначено");
  assert.equal(transportDivision("49.41"), "Наземний і трубопровідний транспорт");
  assert.equal(transportDivision("46.90"), null);
  assert.equal(transportDivision("5229"), null, "🔴 не-КВЕД визнано транспортним");
});

/** База в памʼяті рівно на два запити `registryByCode`. */
function memDb(): Db & { rows: Map<string, { info: unknown; fetched_at: string }> } {
  const rows = new Map<string, { info: unknown; fetched_at: string }>();
  return {
    rows,
    async query(text: string, params: unknown[] = []) {
      if (/^\s*SELECT info, fetched_at FROM lardi_registry_cache WHERE code = \$1/.test(text)) {
        const r = rows.get(String(params[0]));
        return { rows: r ? [r] : [], rowCount: r ? 1 : 0 } as never;
      }
      if (/^\s*INSERT INTO lardi_registry_cache\b(?!_)/.test(text)) {
        rows.set(String(params[0]), { info: JSON.parse(String(params[1])), fetched_at: String(params[2]) });
        return { rows: [], rowCount: 1 } as never;
      }
      throw new Error(`несподіваний запит: ${text}`);
    },
  };
}
const fakeFetch = (status: number, body: unknown, calls: string[]) =>
  async (url: string) => { calls.push(url); return { status, json: async () => body }; };

test("#11012 🪞 YOUCONTROL — ГРОШІ: перший раз — один запит; повтор у межах 30 днів — з кешу; «оновлюється» не кешується; без ключа — не ходимо", async () => {
  const t0 = new Date("2026-11-24T10:00:00Z"), day = 86_400_000;
  const db = memDb(), calls: string[] = [];
  const a = await registryByCode(db, "12345678", { key: "k", doFetch: fakeFetch(200, LEGAL, calls), now: t0 });
  assert.equal(a.state, "ok"); assert.equal(a.state === "ok" && a.cached, false);
  assert.deepEqual(calls, ["https://api.youscore.com.ua/v1/usr/12345678"], "🔴 не рівно один запит /v1/usr (зайвий запит — зайва транзакція)");
  const b = await registryByCode(db, "12345678", { key: "k", doFetch: fakeFetch(200, LEGAL, calls), now: new Date(t0.getTime() + (REGISTRY_CACHE_DAYS - 1) * day) });
  assert.equal(b.state === "ok" && b.cached, true);
  assert.equal(calls.length, 1, "🔴 повтор того самого коду в межах кешу пішов у мережу — платимо двічі");
  await registryByCode(db, "12345678", { key: "k", doFetch: fakeFetch(200, LEGAL, calls), now: new Date(t0.getTime() + (REGISTRY_CACHE_DAYS + 1) * day) });
  assert.equal(calls.length, 2, "🔴 прострочений кеш не оновився");

  const upd = memDb(), c2: string[] = [];
  assert.equal((await registryByCode(upd, "1234567890", { key: "k", doFetch: fakeFetch(202, null, c2), now: t0 })).state, "updating");
  assert.equal(upd.rows.size, 0, "🔴 «ЄДР оновлюється» закешовано на 30 днів як відповідь");
  assert.equal((await registryByCode(upd, "11112222", { key: "k", doFetch: fakeFetch(404, null, c2), now: t0 })).state, "notFound");
  assert.equal(upd.rows.size, 0);
  const none: string[] = [];
  assert.equal((await registryByCode(memDb(), "12345678", { key: undefined, doFetch: fakeFetch(200, LEGAL, none), now: t0 })).state, "unconfigured");
  assert.equal(none.length, 0, "🔴 без ключа пішли в YouControl");
});

test("#11013 ПРОВОДКА: код — з профілю Ларді; ЄДР — для знайдених, не більше трьох кодів; вердикт рахується без реєстру; екран каже, що це факт, а не вердикт", () => {
  const core = src("backend/src/core/lardiCheck.ts");
  assert.match(core, /lardiGet\(`\/v2\/users\/user\/\$\{refId\}`/, "🔴 код фірми питаємо не з профілю «Пользователь»");
  assert.match(core, /\.slice\(0, REGISTRY_MAX_CODES\)/, "🔴 немає стелі кодів за одну перевірку");
  assert.match(core, /lardiVerdict\(\{ users: live\.users\.length, cargo: archive\.cargo, lorry: archive\.lorry, liveOk: live\.ok \}\)/,
    "🔴 вердикт почав залежати від чогось, крім Ларді й архіву");
  assert.match(core, /users = await withRegistry\(live\.users\)/, "🔴 реєстр не підключений до перевірки");
  assert.match(src("backend/src/db/schema.sql"), /CREATE TABLE IF NOT EXISTS lardi_registry_cache\b(?!_)/, "🔴 немає таблиці кешу");
  const ui = src("frontend/src/pages/dashboard/sections/LeadgenLardiCheck.tsx");
  assert.match(ui, /<LardiUserCard key=\{u\.refId\} u=\{u\} \/>/, "🔴 картка компанії не рендериться");
  assert.match(ui, /вердикт угорі від нього не змінюється/, "🔴 пояснення не каже, що КВЕД — не вердикт");
  assert.match(ui, /Ларді для цієї компанії не віддав/, "🔴 немає підпису, коли коду фірми немає (порожнеча читалась би як «перевірено»)");
});

test("#11014 🪞 202 «ОНОВЛЮЮ» → АРХІВ ОДРАЗУ: другий запит showCurrentData=true, картка позначена архівною й кешується; без 202 — архів не питаємо", async () => {
  const t0 = new Date("2026-11-24T15:00:00Z");
  const seq = (answers: Array<[number, unknown]>, calls: string[]) =>
    async (url: string) => { calls.push(url); const [status, body] = answers[Math.min(calls.length - 1, answers.length - 1)]; return { status, json: async () => body }; };
  const db = memDb(), calls: string[] = [];
  const a = await registryByCode(db, "39261965", { key: "k", doFetch: seq([[202, { status: "Update in progress" }], [200, LEGAL]], calls), now: t0 });
  assert.equal(a.state, "ok", "🔴 202 на першому запиті (заміряно на проді 24.11) лишив лідгена без виду діяльності");
  assert.deepEqual(calls, ["https://api.youscore.com.ua/v1/usr/39261965", "https://api.youscore.com.ua/v1/usr/39261965?showCurrentData=true"]);
  assert.equal(a.state === "ok" && a.info.archived, true, "🔴 архівні дані не позначені архівними");
  assert.equal(db.rows.size, 1, "🔴 картку з архіву не закешовано — наступна перевірка заплатить знову");
  // Дзеркало: свіжа відповідь — один запит, не архівна.
  const fresh: string[] = [];
  const b = await registryByCode(memDb(), "12345678", { key: "k", doFetch: seq([[200, LEGAL]], fresh), now: t0 });
  assert.equal(fresh.length, 1, "🔴 архів питали без 202 — зайва транзакція");
  assert.equal(b.state === "ok" && b.info.archived, false);
  // Архіву теж немає — «оновлюється», а не «немає в ЄДР».
  const none: string[] = [];
  assert.equal((await registryByCode(memDb(), "12345678", { key: "k", doFetch: seq([[202, null], [404, null]], none), now: t0 })).state, "updating");
});

/** Жива відповідь архіву YouControl 24.11.2026 (коди й назви — як прийшли; компанію не називаємо). */
const OLD_2005 = {
  contractorType: "Юридична особа (ЮО)", status: "Не перебуває в процесі припинення",
  mainEconomicActivity: { code: "51.47.9", description: "ОПТОВА ТОРГІВЛЯ ІНШИМИ НЕПРОДОВОЛЬЧИМИ ТОВАРАМИ СПОЖИВЧОГО ПРИЗНАЧЕННЯ, Н. В. І. Г." },
  economicActivities: [
    { isMain: false, code: "33.10.1", description: "ВИРОБНИЦТВО МЕДИЧНОЇ ТЕХНІКИ, ВКЛЮЧАЮЧИ ХІРУРГІЧНЕ УСТАТКОВАННЯ, ТА ОРТОПЕДИЧНИХ ПРИСТОСОВАНЬ" },
    { isMain: false, code: "74.40.0", description: "РЕКЛАМНА ДІЯЛЬНІСТЬ" },
    { isMain: false, code: "60.24.0", description: "ДІЯЛЬНІСТЬ АВТОМОБІЛЬНОГО ВАНТАЖНОГО ТРАНСПОРТУ" },
    { isMain: false, code: "45.45.0", description: "ІНШІ РОБОТИ З ЗАВЕРШЕННЯ БУДІВНИЦТВА" },
    { isMain: false, code: "52.48.9", description: "РОЗДРІБНА ТОРГІВЛЯ ІНШИМИ НЕПРОДОВОЛЬЧИМИ ТОВАРАМИ, Н. В. І. Г." },
    { isMain: false, code: "51.90.0", description: "ІНШІ ВИДИ ОПТОВОЇ ТОРГІВЛІ" },
    { isMain: false, code: "51.18.0", description: "ПОСЕРЕДНИЦТВО В СПЕЦІАЛІЗОВАНІЙ ТОРГІВЛІ ІНШИМИ ТОВАРАМИ" },
    { isMain: true, code: "51.47.9", description: "ОПТОВА ТОРГІВЛЯ ІНШИМИ НЕПРОДОВОЛЬЧИМИ ТОВАРАМИ СПОЖИВЧОГО ПРИЗНАЧЕННЯ, Н. В. І. Г." },
  ],
};

test("#11015 🪞 КВЕД-2005 (живий архів YouControl): коди «NN.NN.N» не губляться; транспорт — за розділами 60-63, а 51/52 там торгівля; назви не КАПСОМ", () => {
  const r = parseRegistry("31362680", OLD_2005)!;
  assert.equal(r.activities.length, 8, `🔴 зі старого класифікатора лишилось ${r.activities.length} з 8 — лідген побачив би «видів діяльності немає»`);
  assert.deepEqual([r.activities[0].code, r.activities[0].main, r.activities[0].old], ["51.47.9", true, true]);
  const byCode = new Map(r.activities.map((a) => [a.code, a]));
  assert.equal(byCode.get("60.24.0")!.transport, "Діяльність сухопутного транспорту", "🔴 вантажний автотранспорт за КВЕД-2005 не позначено транспортом");
  for (const c of ["51.47.9", "52.48.9", "51.90.0", "51.18.0"]) {
    assert.equal(byCode.get(c)!.transport, null, `🔴 «${c}» (торгівля за КВЕД-2005) названо транспортом за таблицею 2010`);
  }
  assert.equal(byCode.get("74.40.0")!.name, "Рекламна діяльність", "🔴 назва лишилась КАПСОМ");
  // Дзеркало: ті самі розділи за КВЕД-2010 — транспорт, і код не «старий».
  assert.equal(transportDivision("51.10"), "Авіаційний транспорт");
  assert.equal(transportDivision("52.29"), "Складське господарство та допоміжна діяльність у сфері транспорту");
  assert.equal(parseRegistry("12345678", LEGAL)!.activities.every((a) => a.old === false), true, "🔴 КВЕД-2010 позначено старим");
});

test("#11016 🪞 АРХІВНА КАРТКА ЖИВЕ ДОБУ, СВІЖА — 30 ДНІВ: завтра YouControl уже має актуальні КВЕД, і ми їх беремо", async () => {
  const t0 = new Date("2026-11-24T15:00:00Z"), later = new Date(t0.getTime() + 2 * 86_400_000);
  const seq = (answers: Array<[number, unknown]>, calls: string[]) =>
    async (url: string) => { calls.push(url); const [status, body] = answers[Math.min(calls.length - 1, answers.length - 1)]; return { status, json: async () => body }; };
  const db = memDb(), c1: string[] = [];
  await registryByCode(db, "31362680", { key: "k", doFetch: seq([[202, null], [200, OLD_2005]], c1), now: t0 });
  const c2: string[] = [];
  const again = await registryByCode(db, "31362680", { key: "k", doFetch: seq([[200, LEGAL]], c2), now: later });
  assert.equal(c2.length, 1, "🔴 архівна картка трималась у кеші понад добу — лідген 30 днів бачив би старі КВЕД-2005");
  assert.equal(again.state === "ok" && again.info.archived, false);
  // Дзеркало: свіжу картку через 2 дні з кешу (інакше платимо щоразу).
  const c3: string[] = [];
  assert.equal((await registryByCode(db, "31362680", { key: "k", doFetch: seq([[200, LEGAL]], c3), now: new Date(later.getTime() + 2 * 86_400_000) })).state, "ok");
  assert.equal(c3.length, 0, "🔴 свіжу картку не взято з кешу");
});

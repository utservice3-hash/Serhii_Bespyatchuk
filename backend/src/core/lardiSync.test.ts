import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseProposal, eventsFor, botLike, typicalHours, scanPlan, runLardiSync, lardiTime, type PageAnswer, type Proposal } from "./lardiSync.js";

/**
 * 🛰 ЖИВИЙ СКАН ЛАРДІ («Хантинг», прохід 3, 16.11.2026) — чисті гейти `#3965`, `#3966`, `#3968`. Правила — `core/lardiSync.ts`.
 * Фікстура — документована форма заявки Ларді (живої відповіді немає: пошук 403 з 12.11.2026).
 */
const item = (o: Record<string, unknown> = {}) => ({
  id: 101, dateCreate: Date.parse("2026-11-16T07:00:00Z"), dateRepeat: Date.parse("2026-11-16T09:30:00Z"),
  waypointListSource: [{ town: { id: 1, name: "Київ" }, area: { id: 1, name: "Київська" }, country: { sign: "ua" } }],
  waypointListTarget: [{ town: { id: 2, name: "Варшава" }, country: { sign: "PL" } }],
  payment: { value: 42000, currency: { name: "грн" } }, repeat: { auto: true, countToday: 3 },
  owner: { refId: 555, contactId: 777, name: "Альфа, ТОВ", face: "Оля", phones: [{ number: "+380501112233", messengers: [] }, { number: " " }] },
  ...o,
});

/**
 * #3965 — РОЗБІР І ПОДІЇ: документовані поля мапляться (країна у верхньому регістрі, порожній телефон відкинуто); без
 * `id` / `owner.refId` / `dateCreate` — null; секунди не стають 1970 роком; «повтор» не пізніший за створення — не
 * підняття. Події: нова — `new` (+`repeat`, якщо вже піднята); відома — `repeat` лише коли `dateRepeat` зрушив вперед.
 * Бот: `repeat.auto`, або >20 подій за 10 хв (21 — так, 20 — ні), або рівні інтервали (рівні — так, рвані — ні).
 * Години: ≥80% подій. План: Україна, ввіз від сусідів і окремий скан вантажовласників.
 * 🧨 Червоніє, якщо рахувати підняття на тій самій даті ще раз, взяти `>=` замість `>` у межі бота чи загубити ввіз.
 */
test("#3965 СКАН ЛАРДІ: розбір документованої заявки, події new/repeat, мітка бота, години, план сканів", () => {
  const p = parseProposal("cargo", item())!;
  assert.deepEqual([p.id, p.refId, p.contactId, p.fromTown, p.fromArea, p.fromCountry, p.toCountry, p.price, p.autoRepeat, p.repeatsToday],
    [101, 555, 777, "Київ", "Київська", "UA", "PL", 42000, true, 3]);
  assert.deepEqual(p.phones, [{ n: "+380501112233", m: [] }], "🔴 порожній телефон не відкинуто");
  assert.equal(p.createdAt, "2026-11-16T07:00:00.000Z");
  for (const bad of [{ id: undefined }, { owner: { name: "без refId" } }, { dateCreate: null }])
    assert.equal(parseProposal("cargo", item(bad)), null, `🔴 заявку без обовʼязкового поля прийнято: ${JSON.stringify(bad)}`);
  assert.equal(lardiTime(1763276400), "2025-11-16T07:00:00.000Z", "🔴 секунди прочитано як мілісекунди");
  assert.equal(parseProposal("cargo", item({ dateRepeat: Date.parse("2026-11-16T07:00:00Z") }))!.repeatedAt, null, "🔴 «повтор» у мить створення — це не підняття");

  assert.deepEqual(eventsFor(p, undefined).map((e) => e.type), ["new", "repeat"], "🔴 вже піднята нова заявка — без підняття");
  assert.deepEqual(eventsFor(p, null), [{ type: "repeat", at: "2026-11-16T09:30:00.000Z" }], "🔴 перше підняття відомої заявки не записано");
  assert.deepEqual(eventsFor(p, "2026-11-16T09:30:00.000Z"), [], "🔴 те саме підняття — друга подія");
  assert.deepEqual(eventsFor(p, "2026-11-16T10:00:00.000Z"), [], "🔴 старіше підняття за відоме — подія");

  const at = (min: number) => new Date(Date.parse("2026-11-16T08:00:00Z") + min * 60_000).toISOString();
  const burst = (n: number) => Array.from({ length: n }, (_, i) => at((i * 9.5) / n + ((i * 7) % 5) * 0.08));
  assert.equal(botLike(burst(21), false), true, "🔴 21 подія за 10 хв — не бот");
  assert.equal(botLike(burst(20), false), false, "🔴 20 подій за 10 хв — уже бот (межа «понад ~20»)");
  assert.equal(botLike([0, 30, 60, 90, 120, 150, 180].map(at), false), true, "🔴 рівні інтервали — не бот");
  assert.equal(botLike([0, 7, 60, 64, 150, 240, 241].map(at), false), false, "🔴 рвані інтервали людини — бот");
  assert.equal(botLike([], true), true, "🔴 repeat.auto від Ларді не враховано");

  const kyiv = (h: number) => new Date(Date.UTC(2026, 10, 16, h - 2, 15)).toISOString(); // Київ = UTC+2 у листопаді
  assert.deepEqual(typicalHours([9, 9, 10, 11, 12, 16, 17, 17, 17, 23].map(kyiv)), { from: 9, to: 18, n: 10 }, "🔴 години публікації");
  assert.equal(typicalHours([kyiv(9), kyiv(10)]), null, "🔴 дві події — уже «звичні години»");

  const plan = scanPlan();
  assert.ok(plan.some((s) => JSON.stringify(s.filter) === JSON.stringify({ directionFrom: { directionRows: [{ countrySign: "UA" }] } })), "🔴 немає скану «з України»");
  assert.ok(plan.some((s) => JSON.stringify(s.filter.directionTo) === JSON.stringify({ directionRows: [{ countrySign: "UA" }] })), "🔴 немає ввозу в Україну");
  assert.equal(plan.filter((s) => s.shippers && s.filter.onlyShippers === true).length, 1, "🔴 немає скану вантажовласників");
});

function fake(pages: PageAnswer[][]) {
  const calls: string[] = [], slept: number[] = [], recorded: Proposal[][] = [];
  let i = 0;
  return {
    calls, slept, recorded,
    deps: {
      search: async (kind: string, _f: unknown, page: number) => { calls.push(`${kind}:${String(page)}`); return pages[Math.min(i++, pages.length - 1)][0]; },
      record: async (items: Proposal[]) => { recorded.push(items); return { fresh: items.length, events: items.length }; },
      shippers: async () => undefined,
      sleep: async (ms: number) => { slept.push(ms); },
    },
  };
}
const ok = (items: unknown[], pages = 1): PageAnswer[] => [{ code: 200, items, pages, detail: "" }];
const one = [{ label: "з України", filter: {} }];

/**
 * #3966 — ВИРОК ПРОХОДУ: 403 — зупинка на ПЕРШОМУ запиті з текстом Ларді; 429 — паузи 30/60/120 с і повтор, після
 * третьої — падіння; сторінки йдуть, доки є нове, і не далі `pages`; непорожня сторінка без жодної розібраної заявки —
 * падіння з назвами полів; жодної 200 — падіння, а не «успіх із нулем».
 * 🧨 Червоніє, якщо ковтати 403 (як `collectLardi` до 13.10) або лічити нерозібрану форму успіхом.
 */
test("#3966 СКАН ЛАРДІ: 403 — стоп на першому, 429 — пауза й повтор, сторінки, нерозібрана форма й нуль 200 — падіння", async () => {
  const denied = fake([[{ code: 403, items: null, pages: null, detail: JSON.stringify({ message: "Метод доступний лише при підключенні пакета" }) }]]);
  await assert.rejects(runLardiSync(denied.deps), /Ларді 403: Метод доступний лише при підключенні пакета/);
  assert.equal(denied.calls.length, 1, "🔴 після 403 скан пішов далі");

  const busy = fake([[{ code: 429, items: null, pages: null, detail: "" }], [{ code: 429, items: null, pages: null, detail: "" }], ok([item()])]);
  const t = await runLardiSync(busy.deps, one);
  assert.deepEqual(busy.slept.slice(0, 2), [30_000, 60_000], "🔴 паузи на 429 не ті");
  assert.equal(t.retries, 2);
  const stuck = fake([[{ code: 429, items: null, pages: null, detail: "" }]]);
  await assert.rejects(runLardiSync(stuck.deps, one), /429/);
  assert.deepEqual(stuck.slept, [30_000, 60_000, 120_000], "🔴 після третьої паузи не впало");

  const paged = fake([ok([item({ id: 1 })], 2), ok([item({ id: 2 })], 2), ok([item({ id: 3 })], 2)]);
  await runLardiSync(paged.deps, one);
  assert.deepEqual(paged.calls, ["cargo:1", "cargo:2", "lorry:1", "lorry:2"], "🔴 сторінки пішли за `pages` або не пішли зовсім");

  await assert.rejects(runLardiSync(fake([ok([{ proposalId: 1, created: 1 }])]).deps, one), /жодної заявки не розібрано.*proposalId, created/);
  await assert.rejects(runLardiSync(fake([[{ code: 502, items: null, pages: null, detail: "" }]]).deps, one), /не відповів жодного разу/);
});

/**
 * #3968 — ПРОВОДКА: `syncLardi` у кроні кожні 15 хв і під наглядом із `everyMin: 15` (ТЗ: «понад 30 хв» = тривога на 2×).
 * 🧨 Червоніє, якщо джобу не поставити в розклад або забути нагляд — тоді 403 знову мовчатиме тижнями.
 */
test("#3968 СКАН ЛАРДІ: у кроні кожні 15 хв і під наглядом", async () => {
  const idx = readFileSync(path.join(import.meta.dirname, "..", "..", "src", "index.ts"), "utf8");
  assert.match(idx, /cron\.schedule\("4,19,34,49 \* \* \* \*", \(\) => \{\s*void runJob\("syncLardi", \(\) => syncLardi\(\)\);/, "🔴 syncLardi не в розкладі");
  const { MONITORED_JOBS } = await import("../jobs/monitoredJobs.js");
  assert.equal(MONITORED_JOBS.find((j) => j.name === "syncLardi")?.everyMin, 15, "🔴 syncLardi не під наглядом");
});

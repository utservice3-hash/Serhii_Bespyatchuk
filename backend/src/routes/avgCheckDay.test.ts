import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { needsApi, API_BASE } from "../testMode.js";
import { kyivMonthBounds } from "../core/dates.js";

/**
 * #58 — СЕР.ЧЕК ② = ГРОШІ ② ÷ УГОДИ ②. ЧИСЕЛЬНИК І ЗНАМЕННИК З ОДНОГО ДЖЕРЕЛА.
 *
 * 🔴 ЦЕ ДРУГИЙ РАЗ, КОЛИ ТА САМА ПОМИЛКА ВИПРАВЛЯЄТЬСЯ В ІНШОМУ МІСЦІ. У CLAUDE.md
 * вона вже записана як «НЕ 5313, що давала стара формула зі знімками ÷ машини» —
 * і рівно так само розгортка по днях ділила гроші на АВТО:
 *   `chk = received.revenue / dispatched`.
 *
 * 📐 Доказ із живого екрана 06.08 (Пехньо Ксенія): Σ отримано 2 850 ₴, «сер.чек 475»
 * → 2 850 ÷ 475 = **6**, і шість — це авто, а не угоди. Ще ясніше 04.08: гроші
 * 1 000 ₴, авто «—», чек «—» — знаменник обнулився РАЗОМ з авто, хоч гроші були.
 * Правильно: 2 850 ÷ 3 угоди = **950**.
 *
 * 🧨 САБОТАЖ: повернути знаменник на `dispatched` → цей гейт червоніє з текстом
 * «чисельник і знаменник з різних шкал».
 */
const FE = fileURLToPath(new URL(
  "../../../frontend/src/pages/dashboard/sections/ReportPlanSection.tsx", import.meta.url));

/**
 * 🔴 КОМЕНТАРІ ВИРІЗАЮТЬСЯ ПЕРЕД ПОШУКОМ — і це не дрібниця, а умова існування
 * гейта. Перша редакція червоніла на ЧИСТОМУ коді: у коментарі поруч із фіксом я
 * цитую саму хибну формулу («Було `received.revenue / dispatched`»), і гейт ловив
 * цитату. Тобто документування помилки робило неможливим її виправлення.
 * Той самий клас, що «шукати в тексті замість структури», лише зсередини.
 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

test("#58 сер.чек дня ділить гроші на УГОДИ, а не на авто", async () => {
  const raw = await readFile(FE, "utf8");
  const src = stripComments(raw);
  assert.ok(raw.includes("По днях періоду"), "🔴 таблиця по днях зникла — гейт перевіряє не те");

  // Заборонений вираз у будь-якому написанні пробілів.
  const bad = [...src.matchAll(/received\.revenue\s*\/\s*x?\.?dispatched/g)].map((m) => m[0]);
  assert.deepEqual(bad, [],
    "🔴 ЧИСЕЛЬНИК І ЗНАМЕННИК З РІЗНИХ ШКАЛ: сер.чек знову ділить гроші ② на АВТО. "
    + "Авто рахуються за датою відправлення, гроші — за датою входу в етап; "
    + "у день без авто чек обнуляється при живих грошах");
  const badTotals = [...src.matchAll(/monthTotals\.received\.revenue\s*\/\s*d\.monthTotals\.dispatched/g)].map((m) => m[0]);
  assert.deepEqual(badTotals, [], "🔴 те саме в рядку «Σ період» — підсумок за іншою формулою, ніж рядки");

  // Дзеркало: правильний вираз ПРИСУТНІЙ (інакше «немає забороненого» зійшлось би
  // і на екрані, з якого чек прибрали зовсім).
  assert.ok(/received\.revenue\s*\/\s*x\.received\.deals/.test(src),
    "🔴 нема поділу «гроші ② ÷ угоди ②» — чек або зник, або рахується ще якось");
  assert.ok(/received\.revenue\s*\/\s*d\.monthTotals\.received\.deals/.test(src),
    "🔴 у «Σ період» нема поділу на угоди ②");
});

/**
 * #58b — НА ЖИВИХ ДАНИХ: сер.чек, порахований із відповіді API, збігається з
 * «гроші ÷ угоди» і НЕ збігається з «гроші ÷ авто» там, де ці числа різні.
 *
 * Без другої половини гейт зеленів би на менеджері, у якого угод рівно стільки ж,
 * скільки авто — а таких вистачає, і саме там помилку не видно.
 */
test("#58b живі дані: чек == гроші÷угоди і ≠ гроші÷авто", needsApi(), async () => {
  const { signToken } = await import("../auth/auth.js");
  const token = signToken({ userId: 0, role: "admin", roleKey: "admin", managerId: null, teamId: null });
  const H = { Authorization: `Bearer ${token}` };
  const ym = kyivMonthBounds().ym;
  const from = `${ym}-01`;
  const to = kyivMonthBounds().to;

  const rp = await fetch(`${API_BASE}/api/dashboard/report-plan?from=${from}&to=${to}`, { headers: H });
  const body = await rp.json() as { managers: { managerId: number; name: string }[] };

  let checked = 0, divergent = 0;
  for (const m of (body.managers ?? []).slice(0, 6)) {
    const r = await fetch(
      `${API_BASE}/api/dashboard/kvp-report/manager-detail?managerId=${m.managerId}&from=${from}&to=${to}`,
      { headers: H });
    if (r.status !== 200) continue;
    const d = await r.json() as { monthTotals: { received: { deals: number; revenue: number }; dispatched: number } };
    const t = d.monthTotals;
    if (!t.received.deals || !t.received.revenue) continue;
    checked++;
    // Дві формули на тих самих даних — і вони МАЮТЬ розходитись там, де угоди ≠ авто.
    if (t.dispatched && t.dispatched !== t.received.deals) divergent++;
  }
  assert.ok(checked > 0, "🔴 у жодного менеджера нема грошей ② — перевіряти нічого");
  assert.ok(divergent > 0,
    `🔴 у всіх ${checked} перевірених менеджерів угоди ② == авто — на такій вибірці підміна `
    + "знаменника невидима, і гейт нічого не доводить");
});

import Anthropic from "@anthropic-ai/sdk";
import { pool } from "../db/pool.js";
import { getMetric } from "../ai/metricTools.js";
import { buildSystemBlocks, execTool, TOOLS, MODEL, MAX_TOOL_ITERATIONS } from "../ai/respond.js";

/**
 * ГЕЙТ ЯКОСТІ AI — версія 2 (READ-ONLY). Запуск на сервері:
 *   node dist/scripts/gateAiOracle.js
 *
 * ЧОМУ ПЕРЕПИСАНО. Попередній гейт був регуляркою «є число 10-12 десь у тексті».
 * Замір 31.07.2026 показав, що він міряє не те:
 *  • він ВІДХИЛИВ правку, яка наблизила знаменник реклами до ядра втричі (42% → 13%
 *    похибки) — бо відсоток при цьому виріс і вийшов за 10-12;
 *  • він ставив ✅ відповіді, чий чисельник розходився з ядром у 1.9 разу;
 *  • порівняння «по прозі» дало хибний ❌ на Q4, де ряд був ІДЕНТИЧНИЙ, а різнився
 *    лише порядок слів навколо чисел.
 *
 * ТРИ ПРАВИЛА НОВОГО ОРАКУЛА:
 *  1. Еталон рахує ЯДРО в момент прогону (`getMetric`), а не зашитий у файл текст.
 *     Зашитий еталон протухає мовчки; порахований — ні.
 *  2. Порівняння ЧИСЛОВЕ: з відповіді витягуються числа, і кожне обов'язкове число
 *     еталона має бути серед них. Формулювання не впливає.
 *  3. ЗЕЛЕНИЙ = 2 прогони + ІДЕНТИЧНІ числа між прогонами + числа == ядро.
 *     Один прогін більше не доказ: у замірі Q2 проходив 2 рази з 3.
 */

const RUNS = Number(process.env.RUNS ?? 2);
const client = new Anthropic({ timeout: 8 * 60 * 1000 });
let failed = false;

const kyivToday = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
/** Останні 12 повних місяців + поточний, як їх бачить правило «за рік» у промті. */
function last12(): { from: string; to: string } {
  const t = kyivToday();
  const y = +t.slice(0, 4), m = +t.slice(5, 7);
  const fromY = m === 12 ? y : y - 1, fromM = (m % 12) + 1;
  return { from: `${fromY}-${String(fromM).padStart(2, "0")}-01`, to: t };
}

/**
 * Числа з тексту — САМЕ ДАНІ. Перед витягом прибираємо все, що числом лише виглядає:
 *  • дати `YYYY-MM(-DD)`;
 *  • доменні константи (статуси 142/143, id воронок і стадій) — модель законно
 *    називає їх у поясненні («успішні угоди 142»), і це не результат розрахунку;
 *  • тривалості («за 12 місяців») — інакше «12» збігається з відсотком 12.0 і гейт
 *    ловить фразеологію замість цифри.
 * Без цього оракул знову міряв би обгортку, а не відповідь.
 */
const DOMAIN_IDS = /\b(142|143|8921932|155304|8921928|7336928|8921936|7337048|8921948|69716460|60412544|69716312|25044997|100274340|69716164|63019380)\b/g;
const numsOf = (t: string): number[] =>
  (t.replace(/\d{4}-\d{2}(-\d{2})?/g, " ")
    .replace(DOMAIN_IDS, " ")
    .replace(/\d+\s*(?:міс\b|місяц\w*|тижн\w*|дн(?:і|ів|я)\b)/gi, " ")
    .match(/\d[\d  ]*(?:[.,]\d+)?/g) ?? [])
    .map((s) => Number(s.replace(/[\s ]/g, "").replace(",", ".")))
    .filter((x) => Number.isFinite(x));

interface Case {
  id: string;
  q: string;
  /**
   * Еталон із ЯДРА:
   *  • must — числа, які ОБОВ'ЯЗКОВО мають бути у відповіді;
   *  • universe — УСІ числа, які ядро віддає по цьому питанню. Порівнюємо між
   *    прогонами лише перетин відповіді з universe, тобто САМІ ДАНІ. Інакше гейт
   *    ловить прозу («успішні 142», «за 12 міс») і дає хибний ❌ — та сама помилка
   *    «порівняння по прозі», через яку минулий оракул забракував Q4 з ІДЕНТИЧНИМ рядом.
   */
  reference: () => Promise<{ must: number[]; universe: number[]; note: string }>;
  /** Питання без цифр (уточнення) — перевіряємо поведінку, не числа. */
  behaviour?: (text: string, toolCalls: string[]) => string | null;
}

const CASES: Case[] = [
  {
    id: "Q1", q: "Сформуй звіт по клієнту ПВК Арсенал за червень",
    reference: async () => {
      const r = await getMetric("received_by_client", { from: "2026-06-01", to: "2026-06-30" });
      if (!r.ok) throw new Error(r.error);
      const rows = r.data as { key: string; revenue: number; deals: number }[];
      const hit = rows.filter((x) => /арсенал/i.test(String(x.key)));
      const deals = hit.reduce((s, x) => s + Number(x.deals), 0);
      const revenue = Math.round(hit.reduce((s, x) => s + Number(x.revenue), 0));
      return { must: [deals, revenue], universe: [deals, revenue],
               note: `ядро: ${deals} угод / ${revenue} ₴ (ключів: ${hit.length})` };
    },
  },
  {
    id: "Q2", q: "Побудуй статистику по конверсії за цілий рік",
    reference: async () => {
      const { from, to } = last12();
      const r = await getMetric("conversion_ads_by_month", { from, to });
      if (!r.ok) throw new Error(r.error);
      const rows = (r.data as { ym: string; entered: number; wonEventually: number; mature: boolean }[])
        .filter((x) => x.mature);
      // Беремо ТРИ зрілі місяці — досить, щоб зловити інший знаменник/чисельник,
      // і не робить гейт крихким до того, скільки саме місяців модель показала.
      const pick = rows.slice(-3);
      const all = r.data as { entered: number; wonEventually: number; wonInMonth: number; cohortPct: number; periodPct: number }[];
      return {
        must: pick.flatMap((x) => [x.entered, x.wonEventually]),
        universe: all.flatMap((x) => [x.entered, x.wonEventually, x.wonInMonth, x.cohortPct, x.periodPct]),
        note: `ядро (реклама, зрілі міс.): ${pick.map((x) => `${x.ym} ${x.wonEventually}/${x.entered}`).join(" · ")}`,
      };
    },
  },
  {
    id: "Q3", q: "дані не точні, перевір ще раз",
    reference: async () => ({ must: [], universe: [], note: "цифр не має бути — має просити уточнення" }),
    behaviour: (text, calls) => {
      if (!/уточн|яка саме|про які|конкретн/i.test(text)) return "не попросив уточнення";
      if (calls.length) return `поліз у дані замість уточнення (${calls.join(",")})`;
      return null;
    },
  },
  {
    id: "Q4", q: "статистику к-сті відправлених авто за місяць",
    reference: async () => {
      const { from, to } = last12();
      const r = await getMetric("success_by_bucket", { from, to, granularity: "month" });
      if (!r.ok) throw new Error(r.error);
      const rows = r.data as { bucket: string; deals: number }[];
      const pick = rows.slice(0, 3); // перші три місяці ряду
      const all = r.data as { deals: number; revenue: number }[];
      return { must: pick.map((x) => Number(x.deals)),
               universe: all.flatMap((x) => [Number(x.deals), Math.round(Number(x.revenue))]),
               note: `ядро: ${pick.map((x) => `${x.bucket.slice(0, 7)}=${x.deals}`).join(" · ")}` };
    },
  },
];

interface RunResult { text: string; nums: number[]; calls: string[]; iter: number }

async function ask(q: string): Promise<RunResult> {
  const system = await buildSystemBlocks();
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: q }];
  const calls: string[] = [];
  let text = "", iter = 0;
  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    iter++;
    const r = await client.messages.create({ model: MODEL, max_tokens: 8000, system, tools: TOOLS, messages });
    const uses = r.content.filter((c): c is Anthropic.ToolUseBlock => c.type === "tool_use");
    const t = r.content.filter((c) => c.type === "text").map((c) => (c as Anthropic.TextBlock).text).join("\n");
    if (t) text = t;
    if (!uses.length) break;
    messages.push({ role: "assistant", content: r.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of uses) {
      calls.push(tu.name);
      results.push({ type: "tool_result", tool_use_id: tu.id, content: await execTool(tu.name, tu.input as Record<string, unknown>, null) });
    }
    messages.push({ role: "user", content: results });
  }
  return { text, nums: numsOf(text), calls, iter };
}

console.log(`ОРАКУЛ AI · модель ${MODEL} · прогонів ${RUNS} · сьогодні ${kyivToday()}\n`);

for (const c of CASES) {
  let ref: { must: number[]; universe: number[]; note: string };
  try { ref = await c.reference(); }
  catch (e) { console.log(`${c.id} ❌ еталон не порахувався: ${e instanceof Error ? e.message : e}`); failed = true; continue; }

  const runs: RunResult[] = [];
  for (let k = 0; k < RUNS; k++) runs.push(await ask(c.q));

  // (1) стабільність: набір чисел між прогонами має збігатись.
  // Для питань БЕЗ цифр (уточнення) числову стабільність не міряємо взагалі: там
  // «числа» — це нумерація списку («1. 2. 3.»), і вона нічого не означає. Саме на
  // цьому оракул дав хибний ❌ у першому прогоні — та сама помилка, що й «порівняння
  // по прозі», лише з іншого боку.
  const numericCase = ref.must.length > 0;
  const inUniverse = (v: number) => ref.universe.some((u) => Math.abs(u - v) < 0.5);
  const dataOf = (r: RunResult) => [...new Set(r.nums.filter(inUniverse))].sort((a, b) => a - b);
  const key = (r: RunResult) => JSON.stringify(dataOf(r));
  const stable = !numericCase || runs.every((r) => key(r) === key(runs[0]));

  // (2b) СТОРОННІ ЧИСЛА: усе, що виглядає як дані (≥100, не рік) і чого в ядрі НЕМА.
  // Саме тут ловиться ручна арифметика — рівно те, що дало 9750 замість 9752.
  const isYear = (v: number) => v >= 1900 && v <= 2100 && Number.isInteger(v);
  const strays = numericCase
    ? [...new Set(runs.flatMap((r) => r.nums.filter((v) => v >= 100 && !isYear(v) && !inUniverse(v))))]
    : [];

  // (2) збіг з ядром: кожне обов'язкове число присутнє в КОЖНОМУ прогоні
  const missing = runs.map((r) => ref.must.filter((v) => !r.nums.some((x) => Math.abs(x - v) < 0.5)));
  const matchesCore = missing.every((m) => m.length === 0);

  // (3) поведінкова перевірка (для питань без цифр)
  const behaviour = c.behaviour ? runs.map((r) => c.behaviour!(r.text, r.calls)).filter(Boolean) : [];

  const green = stable && matchesCore && behaviour.length === 0 && strays.length === 0;
  if (!green) failed = true;
  console.log("═".repeat(70));
  console.log(`${green ? "✅" : "❌"} ${c.id} · ${c.q}`);
  console.log(`   ${ref.note}`);
  console.log(`   витків: ${runs.map((r) => r.iter).join("/")} · інструменти: ${runs[0].calls.join(",") || "—"}`);
  console.log(`   стабільність між прогонами: ${stable ? "✅ числа ідентичні" : "❌ РОЗІЙШЛИСЬ"}`);
  console.log(`   збіг з ядром: ${matchesCore ? "✅" : `❌ не знайдено у відповіді: ${missing.map((m, i) => `прогін${i + 1}[${m.join(", ")}]`).filter((_, i) => missing[i].length).join(" ")}`}`);
  if (behaviour.length) console.log(`   поведінка: ❌ ${behaviour.join(" · ")}`);
  if (strays.length) console.log(`   числа поза ядром (порахував сам?): ❌ ${strays.join(", ")}`);
  if (!stable) runs.forEach((r, i) => console.log(`     прогін ${i + 1} (дані): ${dataOf(r).join(" ")}`));
  if (!green) console.log(`   → ${runs[0].text.replace(/\s+/g, " ").slice(0, 400)}`);
}

console.log("\n" + "═".repeat(70));
console.log(failed
  ? "❌ ГЕЙТ ПРОВАЛЕНО (зелений = 2 прогони + ідентичні числа + числа == ядро)"
  : "✅ ГЕЙТ ЗЕЛЕНИЙ: усі питання стабільні між прогонами і збігаються з ядром");
await pool.end();
process.exit(failed ? 1 : 0);

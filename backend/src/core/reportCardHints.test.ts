import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * ⓘ ПІДКАЗКИ КАРТКИ МЕНЕДЖЕРА У «ЗВІТІ» (задача 9233, ТЗ Юлі 16.11.2026).
 *
 * На РПК 12.11 цифри картки («Відправлено», план тижня, факт + очікування, «чекає рішення») ніхто не міг
 * прочитати без пояснень. Приймання — людина читає ⓘ біля числа. Тому гейт стверджує ПРИВʼЯЗКУ: ⓘ стоїть
 * у тому самому рядку верстки, що й підпис числа, а не «десь у файлі» (межа змістова — рядок підпису).
 */
const FE = (p: string) => fileURLToPath(new URL(`../../../frontend/src/${p}`, import.meta.url));
const src = () => readFileSync(FE("pages/dashboard/sections/ReportPlanSection.tsx"), "utf8");

/** Рядок верстки, де стоїть підпис; рівно один, інакше перевіряти нема чого. */
function lineWith(s: string, marker: RegExp): string {
  const lines = s.split("\n").filter((l) => marker.test(l));
  assert.equal(lines.length, 1, `підпис ${String(marker)} мусить бути в картці рівно один раз, знайдено ${lines.length}`);
  return lines[0];
}

test("#7800 КАРТКА МЕНЕДЖЕРА: ⓘ стоїть біля кожного з пʼяти чисел 9233 (тиждень, «Відправлено», прогноз, «чекає…», «чекають рішення»)", () => {
  const s = src();
  const cases: [RegExp, string][] = [
    [/<span>Тиждень \{weekLabel\} · <b>\{fmt\(m\.week\.fact\)\}<\/b>/, "weekPlan"],
    [/<span>Відправлено · <b>\{fmt\(sent\)\} ₴<\/b>/, "sent"],
    [/ · прогноз <b>\{k\(m\.projected\)\}<\/b>/, "projected"],
    [/\{\(m\.expectThisMonth > 0 \|\| noDate > 0\) &&/, "expectLegend"],
    [/\{aw && <InfoHint/, "awaiting"],
  ];
  for (const [marker, key] of cases) {
    const line = lineWith(s, marker);
    assert.match(line, new RegExp(`<InfoHint text=\\{CARD_HINT\\.${key}\\} />`), `біля підпису ${String(marker)} немає ⓘ CARD_HINT.${key}`);
  }
  // Легенда «чекає…» і кнопка «чекають рішення» — ⓘ мусить жити поруч із ними, а не в іншому блоці картки.
  const legend = s.indexOf("чекає без дати <b>{fmt(noDate)}</b>");
  const legendHint = s.indexOf("<InfoHint text={CARD_HINT.expectLegend} />");
  assert.ok(legend > 0 && legendHint > legend && s.slice(legend, legendHint).split("\n").length <= 3, "ⓘ легенди відʼїхала від легенди «чекає…»");
  const btn = s.indexOf("🚚 чекають рішення:");
  const btnHint = s.indexOf("<InfoHint text={CARD_HINT.awaiting} />");
  assert.ok(btn > 0 && btnHint > btn && !s.slice(btn, btnHint).includes("<div"), "ⓘ «чекають рішення» відʼїхала від кнопки");
});

test("#7800b ТЕКСТИ ⓘ КАЖУТЬ ТЕ, ЩО РАХУЄ КОД: прогноз без добору, «Відправлено» за датою загрузки, план тижня з ручною ціллю", () => {
  const s = src();
  const start = s.indexOf("const CARD_HINT = {");
  assert.ok(start > 0, "CARD_HINT зник");
  const body = s.slice(start, s.indexOf("} as const;", start));
  const hint = (k: string) => {
    const m = new RegExp(`${k}: ((?:"[^"]*"\\s*\\+?\\s*)+),`).exec(body);
    assert.ok(m, `немає тексту ${k}`);
    return m[1].replace(/"\s*\+\s*"/g, "");
  };
  // Прогноз = факт + очікування з датою ЦЬОГО місяця (рішення 06.08.2026): добір і «без дати» не входять.
  assert.match(hint("projected"), /плановою датою в цьому місяці/);
  assert.match(hint("projected"), /без планової дати сюди не входять/);
  assert.doesNotMatch(hint("projected"), /добір/i);
  assert.match(hint("sent"), /Датою загрузки/);
  assert.match(hint("sent"), /збігатися не мають/);
  assert.match(hint("weekPlan"), /понеділок/);
  assert.match(hint("weekPlan"), /вручну/);
  assert.match(hint("awaiting"), /Дзвінки на мобільні/);
  assert.match(hint("awaiting"), /18:00/);
  // Стара підказка прогнозу казала «+ добір нового бізнесу» — це формула ДО 06.08.2026; повертати її не можна.
  assert.doesNotMatch(s, /title="факт \+ зона визнання \+ добір/);
  // Дзеркало: бекенд справді рахує прогноз без добору — інакше текст ⓘ стверджував би неправду.
  const be = readFileSync(fileURLToPath(new URL("../../src/routes/dashboard.ts", import.meta.url)), "utf8");
  assert.match(be, /projected: Math\.round\(forecast\.forecastMonth\(fact, expPlannedM\.get\(m\.id\)\?\.thisMonth \?\? 0, monthInProgress\)\)/);
});

/**
 * 🧱 Блок «Аванс» не ховає блокувальник реклами + «Усе готівкою» (25.11.2026, Андрусенко й «багато запитів» до Тетяни).
 *
 * Причина: `<Block id="adv">`. У RuAdList — стандартному списку блокувальників для укр/рос браузерів — є загальне правило
 * `###adv`: будь-який елемент з id="adv" ховається на всіх сайтах. Дані для блоку були, а кнопки «Подати заявку на аванс»
 * менеджер не бачив. Гейт перевіряє ВСІ якорі кабінету й «Зарплати», а не лише цей: наступний `id="ads"` зникне так само.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", "payroll");
const SRC = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "src", p), "utf8");
const FRONT = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => { const p = path.join(dir, f); return statSync(p).isDirectory() ? files(p) : /\.(tsx|ts|css)$/.test(f) ? [p] : []; });
}
/** Імена, які загальні правила блокувальників (EasyList, RuAdList) ховають без огляду на сайт. */
const BLOCKED = /^(ad|ads|adv|advert\w*|advertisement\w*|banner\w*|sponsor\w*|ad-\w+|adv-\w+|ads-\w+|adbox|adblock\w*)$/i;

/** Усі id і класи у фронті «Зарплати»: id="x", id: "x", id={CONST} (значення константи), className="a b", CSS-селектори. */
function anchors(): { file: string; name: string }[] {
  const fmt = FRONT("cabinet/format.ts");
  const consts = new Map([...fmt.matchAll(/export const (\w+) = "([^"]+)"/g)].map((m) => [m[1], m[2]]));
  const out: { file: string; name: string }[] = [];
  for (const f of files(ROOT)) {
    const s = readFileSync(f, "utf8"), file = path.relative(ROOT, f);
    for (const m of s.matchAll(/\bid=["']([\w-]+)["']/g)) out.push({ file, name: m[1] });
    for (const m of s.matchAll(/\bid=\{(\w+)\}/g)) if (consts.has(m[1])) out.push({ file, name: consts.get(m[1])! });
    for (const m of s.matchAll(/className=["`]([^"`]+)["`]/g)) for (const c of m[1].split(/\s+/)) if (/^[\w-]+$/.test(c)) out.push({ file, name: c });
    if (f.endsWith(".css")) for (const m of s.matchAll(/[.#]([a-zA-Z][\w-]*)/g)) out.push({ file, name: m[1] });
  }
  return out;
}

test("#10940 АВАНС НЕ ХОВАЄТЬСЯ: жоден id чи клас «Зарплати» не потрапляє під загальні правила блокувальників (adv, ads, banner…); блок «Аванс» має свій якір", () => {
  const all = anchors();
  assert.ok(all.length > 50, `якорів знайдено замало (${all.length}) — сканер зламався, а не код чистий`);
  const bad = all.filter((a) => BLOCKED.test(a.name));
  assert.deepEqual(bad, [], `блокувальник реклами сховає: ${bad.map((b) => `${b.file}: ${b.name}`).join(", ")}`);
  // дзеркало: сам предикат ловить те, через що блок зникав
  assert.ok(BLOCKED.test("adv") && BLOCKED.test("ads") && !BLOCKED.test("zc-avans") && !BLOCKED.test("advance"), "предикат блокувальника");
  const adv = FRONT("cabinet/Advance.tsx");
  assert.match(adv, /<Block id=\{ADVANCE_BLOCK_ID\}/, "блок «Аванс» — з якорем-константою");
  assert.equal(all.some((a) => a.file.endsWith("Advance.tsx") && a.name === "zc-avans"), true, "якір блоку «Аванс» = zc-avans");
});

test("#10941 ПОСИЛАННЯ НА АВАНС: сповіщення «заявки відкрито» веде на новий якір; старі посилання focus=adv перекладаються, а не губляться", () => {
  assert.match(SRC("payroll/service.ts"), /focus: "#zc-avans"/, "сповіщення «Заявки на аванс відкрито» — на новий якір");
  assert.doesNotMatch(SRC("payroll/service.ts"), /focus: "#adv"/);
  const fmt = FRONT("cabinet/format.ts"), cab = FRONT("cabinet/Cabinet.tsx"), ov = FRONT("cabinet/Overview.tsx");
  assert.match(fmt, /FOCUS_ALIAS[^=]*= \{ adv: ADVANCE_BLOCK_ID \}/, "старе «adv» (рушій і вже надіслані сповіщення) → новий якір");
  assert.equal((cab.match(/anchor\(ctx\.goExtra/g) ?? []).length, 2, "обидва входи фокусу (перший рендер і новий перехід) — через переклад");
  assert.match(ov, /go\("pay", ADVANCE_BLOCK_ID\)/, "«Виплати» з «Огляду» — на новий якір");
});

test("#10942 УСЕ ГОТІВКОЮ: у формі (аванс і виплата ЗП) кнопка ставить готівку = сумі, карти в нуль; нульові рядки карт сервер пропускає", () => {
  const pl = FRONT("cabinet/PayLines.tsx");
  assert.match(pl, />Усе готівкою</, "кнопка «Усе готівкою» у формі");
  assert.match(pl, /onChange\(\{ cash: Math\.round\(due\), lines: draft\.lines\.map\(\(l\) => \(\{ \.\.\.l, amount: 0 \}\)\) \}\)/, "готівка = сума, карти = 0");
  assert.match(FRONT("cabinet/payDraft.ts"), /lines: d\.lines\.filter\(\(l\) => l\.amount > 0\)/, "нульові карти в запит не йдуть");
  assert.match(SRC("payroll/service.ts"), /if \(!\(amount > 0\)\) continue;/, "сервер пропускає нульовий рядок карти (нова карта без номера не валідується)");
});

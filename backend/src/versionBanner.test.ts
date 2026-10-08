import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const codeOf = (...rel: string[]) =>
  readFileSync(path.join(import.meta.dirname, "..", "..", "frontend", "src", ...rel), "utf8")
    .replace(/^\s*\/\/.*$/gm, " ").replace(/\{?\/\*[\s\S]*?\*\/\}?/g, " ").replace(/\s+/g, " ");

/**
 * #414 — ПЛАШКА «НОВА ВЕРСІЯ» ПОВЕРТАЄТЬСЯ ПІСЛЯ НАСТУПНОГО ВИКАТУ.
 *
 * Заміряно 15.09.2026: людина працювала на бандлі без «Спільних задач», а плашка
 * мовчала при справних sha бандла, health і сервері. Єдиний шлях до тиші — одне
 * закриття: `closed` не скидалось, а опитування спинялось після першого «застарів».
 *
 * Дві половини, обидві обовʼязкові: закриття привʼязане до sha сервера (на тому ж
 * sha не турбуємо — інакше плашка спливала б щохвилини), і опитування живе далі
 * (інакше про наступний викат нема кому дізнатись).
 *
 * 🧨 Червоніє, якщо: повернути `if (stale) return`; повернути булеве `closed`;
 * прибрати `serverSha` з відповіді `fetchClientStale`.
 */
test("#414 ПЛАШКА «НОВА ВЕРСІЯ»: закрив на цьому викаті — мовчить, вийшов наступний — показує знову", () => {
  const b = codeOf("components", "VersionBanner.tsx");
  assert.doesNotMatch(b, /if \(stale\) return;/, "🔴 опитування знову спиняється після першого «застарів» — наступний викат ніхто не побачить");
  assert.doesNotMatch(b, /setClosed\(/, "🔴 булеве закриття повернулось — одне Escape і тиша до перезавантаження");
  assert.match(b, /const open = stale && serverSha != null && dismissedSha !== serverSha;/,
    "🔴 умова показу не порівнює sha закриття з sha сервера");
  assert.match(b, /const dismiss = \(\) => setDismissedSha\(serverSha\);/, "🔴 закриття не запамʼятовує, НА ЯКОМУ викаті закрили");
  assert.match(b, /else if \(r\.stale === false\) setStale\(false\);/, "🔴 вердикт «актуальна» не гасить плашку");
  const a = codeOf("api.ts");
  assert.match(a, /serverSha: data\?\.version\?\.sha \?\? data\?\.version\?\.shortSha \?\? null/,
    "🔴 fetchClientStale не віддає sha сервера — банеру нема з чим порівняти закриття");
});

/**
 * #1497 — «НОВА ВЕРСІЯ» ЙДЕ ЧЕРЕЗ ЄДИНУ СИСТЕМУ СПОВІЩЕНЬ (Роман, 08.10.2026: «треба щоб всі сповіщення були в 1
 * системі і підпорядковувалися 1 правилам»).
 *
 * Власна картка в кутку лягала поверх стопки звичайних сповіщень. Тепер `VersionBanner` лише вирішує, КОЛИ
 * показати, а показує `useToast` — зі спільними правилами (`toastRules.ts`). Що стверджуємо:
 *  · жодної власної верстки: немає `position: "fixed"`, класів `app-toast`, порталу — компонент повертає `null`;
 *  · сповіщення з ключем `new-version` (повтор опитування замінює, а не дублює) і дією «Оновити» → перезавантаження;
 *  · будь-яке закриття → `dismiss` (мовчить до наступного викату, `#414`).
 *
 * 🧨 Червоніє, якщо: повернути власну картку; прибрати ключ (копія на кожне опитування); прибрати `onDismiss: dismiss`
 * (після ✕ сповіщення повертатиметься кожні 2 хв).
 */
test("#1497 «НОВА ВЕРСІЯ» — ЗВИЧАЙНЕ СПОВІЩЕННЯ ЄДИНОЇ СИСТЕМИ: без власної картки, з ключем, «Оновити» і закриттям до наступного викату", () => {
  const b = codeOf("components", "VersionBanner.tsx");
  assert.doesNotMatch(b, /position: "fixed"/, "🔴 повернулась власна картка в кутку — знову накладається на сповіщення");
  assert.doesNotMatch(b, /className="app-toast/, "🔴 VersionBanner знову малює сповіщення сам, а не через useToast");
  assert.doesNotMatch(b, /createPortal/, "🔴 власний портал — окремий механізм сповіщень");
  assert.match(b, /const toast = useToast\(\);/, "🔴 сповіщення не через єдину систему");
  assert.match(b, /key: "new-version"/, "🔴 без ключа кожне опитування додаватиме копію сповіщення");
  assert.match(b, /action: \{ label: "Оновити", run: \(\) => location\.reload\(\) \}/, "🔴 немає дії «Оновити» з перезавантаженням");
  assert.match(b, /onDismiss: dismiss,/, "🔴 закриття не запамʼятовує викат — сповіщення повертатиметься кожні 2 хв");
  assert.match(b, /return null;\s*\}\s*$/, "🔴 компонент знову щось малює сам");
  assert.doesNotMatch(b, /autoFocus/, "🔴 фокус на «Оновити» — пробіл посеред набору тексту перезавантажить сторінку");
});

/**
 * #1498 — У ФРОНТІ НЕМАЄ `alert()` БРАУЗЕРА (08.10.2026, прохід A «одна система сповіщень»).
 *
 * Сіре вікно браузера — окремий механізм сповіщень із власними правилами (блокує сторінку, не стилізується, не
 * висить у стопці). 24 виклики в 7 файлах переведено на `useToast` (помилка висить до закриття). Перелік файлів —
 * УВЕСЬ `frontend/src`, а не названі: критерій від предмета, щоб новий файл з `alert(` не пройшов повз.
 *
 * 🧨 Червоніє, якщо будь-де у фронті знову зʼявиться `alert(` / `window.alert(`.
 */
test("#1498 у фронті немає alert() браузера — помилки йдуть у єдину систему сповіщень", async () => {
  const { readdirSync, statSync } = await import("node:fs");
  const root = path.join(import.meta.dirname, "..", "..", "frontend", "src");
  const files: string[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d)) { const f = path.join(d, n); if (statSync(f).isDirectory()) walk(f); else if (/\.(tsx?|jsx?)$/.test(n) && !/\.test\./.test(n)) files.push(f); } };
  walk(root);
  assert.ok(files.length > 50, `🔴 у frontend/src знайдено лише ${files.length} файлів — перевіряти нема чого, це не «зелено»`);
  const hits: string[] = [];
  for (const f of files) {
    const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
    if (/(^|[^A-Za-z_.$])(window\.)?alert\(/.test(code)) hits.push(path.relative(root, f));
  }
  assert.deepEqual(hits, [], `🔴 alert() браузера повернувся: ${hits.join(", ")} — використовуйте useToast (помилка: { error: true })`);
});

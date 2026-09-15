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

/**
 * 🧪 ЗАПУСК НАБОРУ З ПАРАЛЕЛЬНІСТЮ, ЩО ВМІЩАЄТЬСЯ В ХОСТИНГ (11.11.2026, Роман: «оптимізуй»).
 *
 * `node scripts/testRun.mjs <аргументи node>` — те саме, що `node <аргументи node>`, з однією відмінністю:
 * на ХОСТИНГУ (є `/proc/lve` — ліміт памʼяті акаунта, де вже живуть прод і PHP) `--test-concurrency` не більший за
 * `HOST_TEST_CONCURRENCY`. Деінде (ноутбук) — рівно те, що попросили, або дефолт node.
 *
 * 📐 ЧОМУ. На хостингу `os.availableParallelism()` = 48, тож `node --test` без прапорця тримає до 47 тест-процесів
 * одночасно (у середньому 73 МБ кожен, 15 файлів ≥ 150 МБ — замір 11.11 по кожному з 363). Крок `test` викату ганяв
 * саме так `npm test` двічі (база + дерево), і з 52 аварій прода під замком за 45 днів 48 сталися в перші 300 с фази
 * `check`. Ядро вбиває найбільший процес акаунта — прод. На ноутбуці 14 → 8 потоків: 134 с → 137 с, пік 1 621 → 955 МБ;
 * 4: 166 с, 614 МБ. Тобто понад кілька потоків паралельність часу майже не купує, а памʼять — множить.
 *
 * Аргументи передаються як є, тож усі літерали режимів (`--import ./dist/testReadOnly.js`, вартовий
 * `--test-reporter=./dist/testRunGate.js`) лишаються в `package.json`, де їх стережуть `#203b` і read-only-гейти.
 * Перевизначити: `UTS_TEST_CONCURRENCY=<n>`. Код виходу — код набору.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Стеля на хостингу. 4, а не 8: поруч у фазі `check` уже живуть прод (300–450 МБ) і PHP (сплески до ~1,5 ГБ RSS). */
export const HOST_TEST_CONCURRENCY = 4;

const FLAG = /^--test-concurrency(?:=(.*))?$/;

/** Скільки попросили аргументами (`--test-concurrency=N` або `--test-concurrency N`); `null` — не просили. */
export function requestedConcurrency(argv) {
  for (let i = 0; i < argv.length; i++) {
    const m = FLAG.exec(argv[i]);
    if (!m) continue;
    const v = m[1] ?? argv[i + 1];
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new Error(`testRun: --test-concurrency має бути цілим ≥ 1, а не «${v}»`);
    return n;
  }
  return null;
}

/**
 * Чиста функція вибору. `null` у відповіді — не ставити прапорця (дефолт node).
 * Порядок: явне перевизначення → хостинг (стеля) → те, що попросили.
 */
export function pickConcurrency({ lve, requested, override }) {
  if (override !== undefined && override !== null && String(override).trim() !== "") {
    const n = Number(override);
    if (!Number.isInteger(n) || n < 1) throw new Error(`testRun: UTS_TEST_CONCURRENCY має бути цілим ≥ 1, а не «${override}»`);
    return n;
  }
  if (lve) return Math.min(requested ?? HOST_TEST_CONCURRENCY, HOST_TEST_CONCURRENCY);
  return requested;
}

/** Аргументи для node: власний прапорець паралельності прибрано, вибраний — першим. */
export function buildArgs(argv, n) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const m = FLAG.exec(argv[i]);
    if (m) { if (m[1] === undefined) i++; continue; }
    out.push(argv[i]);
  }
  return n === null || n === undefined ? out : [`--test-concurrency=${n}`, ...out];
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const lve = existsSync("/proc/lve");
  const n = pickConcurrency({ lve, requested: requestedConcurrency(argv), override: process.env.UTS_TEST_CONCURRENCY });
  // stderr, а не stdout: stdout кроку `test` розбирається як TAP.
  console.error(`testRun: паралельність ${n ?? "дефолт node"}${lve ? ` (хостинг, стеля ${HOST_TEST_CONCURRENCY})` : ""}`);
  const r = spawnSync(process.execPath, buildArgs(argv, n), { stdio: "inherit" });
  if (r.error) { console.error(`testRun: не вдалось запустити node: ${r.error.message}`); process.exit(1); }
  if (r.signal) { console.error(`testRun: набір убито сигналом ${r.signal}`); process.exit(1); }
  process.exit(r.status ?? 1);
}

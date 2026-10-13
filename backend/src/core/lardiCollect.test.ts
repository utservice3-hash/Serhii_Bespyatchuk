import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { collectVerdict, lardiMessage, runLardiCollect, type CollectTally, type LardiAnswer, type LardiKind } from "./lardiCollect.js";

const SRC = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", "..", "src", rel), "utf8");

/** Відповідь Lardi на відмову — дослівно та, що приходила 17.09–12.10.2026. */
const DENIED_403 = JSON.stringify({ statusCode: 403, message: "Метод доступний лише при підключенні пакета \"Розширений доступ до API\"",
  errorCode: 0, wrongFields: null, messageArgs: null });
const tally = (p: Partial<CollectTally>): CollectTally =>
  ({ routes: 3, requests: 6, ok: 0, newRows: 0, denied: null, failed: 0, lastFail: null, ...p });

/**
 * #1660 — ВИРОК ПРОХОДУ (13.10.2026, після 3,5 тижня «успіху з нулем»): відмова в доступі → падіння з текстом самого
 * Lardi; жодної відповіді 200 за прохід → падіння; хоч одна 200 → успіх; маршрутів немає → успіх. Без бази.
 * 🧨 Червоніє, якщо знову ковтати відмову, мовчати на повному провалі чи кричати, коли просто нема чого збирати.
 */
test("#1660 ВИРОК: відмова Lardi й нуль відповідей — падіння з причиною; хоч одна 200 чи нема маршрутів — успіх", () => {
  const denied = collectVerdict(tally({ denied: { code: 403, detail: DENIED_403 }, requests: 1 }));
  assert.equal(denied.ok, false, "🔴 відмову Lardi в доступі прочитано як успіх");
  assert.match(denied.ok ? "" : denied.error, /^Lardi 403: Метод доступний лише при підключенні пакета "Розширений доступ до API"$/,
    "🔴 тривога не каже, що саме сталось (код і текст Lardi)");
  const silent = collectVerdict(tally({ failed: 6, lastFail: "503 Service Unavailable" }));
  assert.equal(silent.ok, false, "🔴 жодної відповіді за прохід — а записано успіх");
  assert.match(silent.ok ? "" : silent.error, /жодного разу: 6 з 6 запитів невдалі \(остання помилка: 503 Service Unavailable\)/);
  assert.deepEqual(collectVerdict(tally({ ok: 1, failed: 5 })), { ok: true }, "дзеркало: поодинокий збій при живих відповідях — не тривога");
  assert.deepEqual(collectVerdict(tally({ routes: 0, requests: 0 })), { ok: true }, "дзеркало: маршрутів немає — збирати нічого, це не збій");
  assert.equal(lardiMessage("<html>Bad Gateway</html>"), "<html>Bad Gateway</html>", "🔴 не-JSON відповідь загублено");
  assert.equal(lardiMessage(""), "без тексту");
});

/** Фейкові залежності: Lardi відповідає за сценарієм, лічимо виклики. */
function fakeDeps(routes: number, answer: (kind: LardiKind, i: number) => LardiAnswer | Error) {
  const calls = { search: 0, record: 0, sleep: 0 };
  const deps = {
    listRoutes: async () => Array.from({ length: routes }, (_, i) => i),
    search: async (kind: LardiKind, i: number) => { calls.search++; const a = answer(kind, i); if (a instanceof Error) throw a; return a; },
    record: async (_k: LardiKind, _i: number, content: unknown[]) => { calls.record++; return content.length; },
    sleep: async () => { calls.sleep++; },
  };
  return { calls, deps };
}
const ok200 = (n = 2): LardiAnswer => ({ code: 200, content: Array.from({ length: n }, (_, i) => ({ id: i })), detail: "" });

/**
 * #1661 — ПРОХІД: на першій відмові 403 збір ЗУПИНЯЄТЬСЯ (1 запит, а не 220, як 12.10) і падає з текстом Lardi, нічого не
 * записавши; живий Lardi — пише кожну відповідь і рахує нові рядки; збій мережі на частині маршрутів — не падіння;
 * повний провал (5xx / таймаути скрізь) — падіння.
 * 🧨 Червоніє, якщо прибрати ранню зупинку, повернути `continue` на 403 чи ковтати повний провал.
 */
test("#1661 ПРОХІД: 403 — стоп на першому запиті й падіння; живий — пише все; частковий збій — успіх; повний — падіння", async () => {
  const d = fakeDeps(110, () => ({ code: 403, content: null, detail: DENIED_403 }));
  await assert.rejects(runLardiCollect(d.deps), /^Error: Lardi 403: Метод доступний лише при підключенні пакета/,
    "🔴 відмову Lardi проковтнуто — джоба знову «успішна» з нулем");
  assert.deepEqual([d.calls.search, d.calls.record], [1, 0], "🔴 після відмови в доступі збір пішов далі по маршрутах");

  const live = fakeDeps(3, () => ok200(2));
  const t = await runLardiCollect(live.deps);
  assert.deepEqual([t.routes, t.requests, t.ok, t.newRows, live.calls.record], [3, 6, 6, 12, 6], "дзеркало: живий Lardi — усе записано");

  const partial = fakeDeps(3, (k, i) => (i === 0 && k === "cargo" ? new Error("fetch failed") : ok200(1)));
  const p = await runLardiCollect(partial.deps);
  assert.deepEqual([p.failed, p.ok, p.lastFail], [1, 5, "fetch failed"], "дзеркало: поодинокий збій мережі не валить прохід");

  const down = fakeDeps(3, (_k, i) => (i === 1 ? new Error("timeout") : { code: 503, content: null, detail: "Service Unavailable" }));
  await assert.rejects(runLardiCollect(down.deps), /Lardi не відповів жодного разу: 6 з 6/, "🔴 Lardi лежить, а прохід «успішний»");
  assert.equal(down.calls.search, 6, "на 5xx зупинки немає — це не про обліковий запис, наступний маршрут може відповісти");

  const empty = fakeDeps(0, () => ok200());
  assert.equal((await runLardiCollect(empty.deps)).requests, 0, "дзеркало: маршрутів немає — запитів немає, успіх");
});

/**
 * #1662 — ПРОВОДКА: джоба ходить через `runLardiCollect` (а не власний цикл, що ковтає відмову); під наглядом із частотою
 * свого крону, тож падіння й мовчання доходять тривогою в Telegram. Частоту беремо з самої бібліотеки крону (як `#537`).
 * 🧨 Червоніє, якщо повернути власний цикл із `catch {}`, зняти джобу з нагляду чи розвести частоти.
 */
test("#1662 ПРОВОДКА: collectLardi через runLardiCollect, без ковтання; під наглядом із частотою крону", async () => {
  const job = SRC("jobs/collectLardi.ts");
  assert.match(job, /await runLardiCollect<Route>\(\{/, "🔴 джоба не ходить через спільний прохід із вироком");
  assert.doesNotMatch(job, /catch \{/, "🔴 у джобі знову ковтається помилка");
  assert.doesNotMatch(job, /code !== 200[^\n]*continue/, "🔴 повернувся цикл, що мовчки пропускає не-200");
  const src = SRC("index.ts");
  const call = src.indexOf('runJob("collectLardi", () => collectLardi())');
  assert.ok(call > 0, "🔴 збір цін не запускається з крону");
  const spec = [...src.slice(0, call).matchAll(/cron\.schedule\("([^"]+)"/g)].pop()?.[1];
  assert.ok(spec, "🔴 не знайдено крон збору цін");
  const { createRequire } = await import("node:module");
  const TimeMatcher = createRequire(import.meta.url)("node-cron/src/time-matcher.js") as new (p: string) => { match(d: Date): boolean };
  const tm = new TimeMatcher(`0 ${spec}`);
  const fires = Array.from({ length: 24 * 60 }, (_, m) => m).filter((m) => tm.match(new Date(2026, 9, 13, Math.floor(m / 60), m % 60, 0)));
  const gaps = fires.map((x, i) => ((fires[(i + 1) % fires.length] - x + 1440) % 1440) || 1440);
  assert.equal(new Set(gaps).size, 1, `🔴 крон «${spec}» стріляє нерівно`);
  const { MONITORED_JOBS } = await import("../jobs/monitoredJobs.js");
  const row = MONITORED_JOBS.find((j) => j.name === "collectLardi");
  assert.ok(row, "🔴 збір цін не під наглядом — його падіння й мовчання ніхто не побачить");
  assert.equal(row.everyMin, gaps[0], `🔴 нагляд чекає раз на ${String(row.everyMin)} хв, а крон стріляє раз на ${String(gaps[0])}`);
});

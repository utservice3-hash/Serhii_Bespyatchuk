import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 📏 ЗАДАЧНИК: СТАРА ТАБЛИЦЯ НЕ ЗАВИСАЄ НА «КОМАНДНИХ ЗАДАЧАХ» (задача 9227, 18.11.2026).
 *
 * Ліля (тімлід, 610 рядків у «Командних») бачила «помилку при переході на задачі команди». Причина:
 * у старому вигляді кожне поле назви й коментаря міряло свою висоту само, і кожен вимір змушував
 * браузер перерахувати всю таблицю. Заміряно в браузері: 600 задач - 10,4 с, на процесорі вчетверо
 * слабшому - 67 с («Сторінка не відповідає»). Після правки - 1,0 с і 5,1 с, висоти ті самі (0 обрізаних).
 *
 * Гейти стережуть ПОРЯДОК операцій (усі записи «auto» → усі читання → усі записи висоти), бо саме
 * чергування «запис-читання» в кожному полі давало квадратичний час. Модуль фронту транспілюється
 * справжній, а не переказаний.
 */
const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const src = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

async function loadFitBatch() {
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(src("frontend/src/pages/dashboard/fitBatch.ts"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  type Target = { style: { height: string }; readonly scrollHeight: number };
  return import(`data:text/javascript,${encodeURIComponent(js)}`) as Promise<{
    fitHeights: (els: readonly Target[]) => void;
    createFitBatch: (schedule: (cb: () => void) => void) => { mark: (el: Target) => void; flush: () => void };
  }>;
}

/** Поле-підробка, що записує кожну операцію в спільний журнал: так видно ПОРЯДОК записів і читань. */
function fakeField(log: string[], name: string, content: number) {
  let h = "";
  return {
    name,
    style: {
      get height() { return h; },
      set height(v: string) { h = v; log.push(`${name}=${v}`); },
    },
    get scrollHeight() { log.push(`${name}?`); return content; },
  };
}

test("#9227 📏 ВИСОТА ПОЛІВ ТАБЛИЦІ ЗАДАЧ - ОДНИМ ПРОХОДОМ: спершу всім «auto», потім усі читання, потім усі висоти", async () => {
  const { fitHeights } = await loadFitBatch();
  const log: string[] = [];
  const els = [fakeField(log, "a", 20), fakeField(log, "b", 60), fakeField(log, "c", 40)];
  fitHeights(els);
  assert.deepEqual(log, ["a=auto", "b=auto", "c=auto", "a?", "b?", "c?", "a=20px", "b=60px", "c=40px"],
    "🔴 записи й читання висоти чергуються - кожне поле знову змушує браузер перерахувати всю таблицю (600 рядків = хвилина зависання)");
});

test("#9227b 🪞 ЧЕРГА ТАБЛИЦІ: кожне поле отримує СВОЮ висоту, підгонка одна на всіх, повторний виклик нічого не чіпає", async () => {
  const { createFitBatch } = await loadFitBatch();
  const log: string[] = [];
  let scheduled = 0;
  const batch = createFitBatch(() => { scheduled++; });
  const els = [fakeField(log, "a", 22), fakeField(log, "b", 88), fakeField(log, "c", 44)];
  for (const el of els) batch.mark(el);
  assert.equal(log.length, 0, "🔴 поле міряє себе вже під час позначки - пакету немає");
  batch.flush();
  assert.deepEqual(els.map((e) => e.style.height), ["22px", "88px", "44px"],
    "🔴 висоти не ті, що в текстів: поле обрізане або з порожнім місцем");
  assert.equal(log.filter((x) => x.endsWith("?")).length, 3, "🔴 кожне поле мало бути виміряне рівно раз");
  assert.equal(scheduled, 1, "🔴 страховочний кадр замовлено не один раз на пакет");
  const n = log.length;
  batch.flush();
  assert.equal(log.length, n, "🔴 порожня черга знову чіпає поля");
});

test("#9227c ТАБЛИЦЯ ЗАДАЧ ПІДГАНЯЄ ПОЛЯ ЧЕРЕЗ ЧЕРГУ: поле в таблиці не міряє себе саме, тіло таблиці підганяє всіх після рендеру", () => {
  const ui = src("frontend/src/pages/dashboard/sections/TasksSection.tsx");
  const at = ui.indexOf("function AutoTextarea(");
  assert.ok(at > 0, "🔴 AutoTextarea не знайдено - гейт нема на чому перевіряти");
  const body = ui.slice(at, ui.indexOf("\n}\n", at));
  assert.doesNotMatch(body, /scrollHeight/, "🔴 поле знову саме читає scrollHeight - вимір у кожному рядку окремо");
  assert.match(body, /if \(batch\) batch\.mark\(el\);\s*else fitHeights\(\[el\]\);/, "🔴 поле в таблиці не стає в чергу");
  assert.match(body, /useContext\(FitBatchCtx\)/, "🔴 поле не бачить черги своєї таблиці");
  assert.match(ui, /function FitBatchBody\([^]*?useLayoutEffect\(\(\) => \{ batch\.flush\(\); \}\);[^]*?<tbody>\{children\}<\/tbody>/,
    "🔴 тіло таблиці не підганяє поля після рендеру");
  const opens = (ui.match(/<FitBatchBody>/g) ?? []).length;
  const fields = (ui.match(/<AutoTextarea\b/g) ?? []).length;
  assert.ok(fields > 0, "🔴 полів AutoTextarea у задачнику немає - перевіряти нічого");
  assert.equal(opens, 1, "🔴 таблиця задач не обгорнута в FitBatchBody (або обгорток кілька)");
  const tb = ui.indexOf("<FitBatchBody>"), te = ui.indexOf("</FitBatchBody>");
  const inside = (ui.slice(tb, te).match(/<AutoTextarea\b/g) ?? []).length;
  assert.equal(inside, fields, "🔴 є поле AutoTextarea поза тілом таблиці з чергою");
});

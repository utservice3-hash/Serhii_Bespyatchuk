import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * #75 — ПАТЧ ГОНКИ В `pg-copy-streams` НАКЛАДЕНО, І ВІН ЩЕ МАЄ СЕНС.
 *
 * 🔴 НАВІЩО ЦЕЙ ГЕЙТ ВЗАГАЛІ (вимога власника 11.08.2026). Ми правимо ЧУЖУ
 * бібліотеку в рантаймі. Оновлять пакет, перепишуть внутрішнє — накладка мовчки
 * перестане лягати, і ми повернемось до 60% падінь на COPY, не дізнавшись про це.
 * Це рівно той клас, який ми ловимо весь час: механізм наче стоїть, а шлях, яким
 * приходить помилка, він не покриває.
 *
 * Тому перевіряємо ТРИ речі, а не одну:
 *   #75  — відбиток бібліотеки той, що очікувався, і патч ліг;
 *   #75b — сама гонка ВІДТВОРЕНА і патч її знімає (без патча — падіння);
 *   #75c — відмова гучна: без патча бекап не починається, а не працює тихо.
 *
 * ⚠️ Гонку відтворюємо ДЕТЕРМІНОВАНО, а не «30 разів проти прода»: справжня вона
 * часова, тож тест на живій базі був би флакі й доводив би погоду. Тут імітується
 * рівно те, що стається насправді — подія `readable` ПІСЛЯ `_cleanup()`.
 */

const { to: copyTo } = await import("pg-copy-streams");
const proto = () => Object.getPrototypeOf(copyTo("COPY (SELECT 1) TO STDOUT")) as Record<string, Function>;

/** Екземпляр у стані «копію завершено, прибрано за собою», з фальшивим потоком. */
function afterCleanup(): { q: Record<string, unknown>; reads: () => number } {
  const q = copyTo("COPY (SELECT 1) TO STDOUT") as unknown as Record<string, unknown>;
  let reads = 0;
  // `_forward` вимагає `connection`, і саме тому охоронець його пропускає:
  // `_cleanup` цього поля НЕ чіпає — у цьому весь баг.
  q.connection = { stream: { read: () => { reads++; return reads === 1 ? Buffer.from("x") : null; } } };
  q._drained = true;
  q._forwarding = false;
  (q._cleanup as () => void).call(q); // ← те саме, що робить бібліотека в кінці копії
  return { q, reads: () => reads };
}

test("#75 ПАТЧ НАКЛАДЕНО, І ВІДБИТОК БІБЛІОТЕКИ ТОЙ, ЩО ОЧІКУВАВСЯ", async () => {
  const { applyCopyStreamPatch, copyPatchState } = await import("./copyStreamPatch.js");
  const st = applyCopyStreamPatch();
  assert.equal(st.applied, true,
    `🔴 патч НЕ ліг: ${st.reason}. Бібліотеку оновили або переписали — перевір, чи баг `
    + "не виправлено вгорі: тоді патч треба ПРИБРАТИ, а не лагодити");
  assert.equal(copyPatchState().applied, true, "🔴 стан патча не запамʼятався");
  assert.equal((proto()._forward as { __utsCopyPatch?: boolean }).__utsCopyPatch, true,
    "🔴 позначки на пропатченій функції немає — накладено не те, що думаємо");
  // Ідемпотентність: повторний виклик не має обгортати обгортку.
  const before = proto()._forward;
  applyCopyStreamPatch();
  assert.equal(proto()._forward, before, "🔴 повторний виклик наклав патч удруге");
});

test("#75b ГОНКА ВІДТВОРЕНА: без патча — падіння, з патчем — тиша", async () => {
  const { applyCopyStreamPatch } = await import("./copyStreamPatch.js");
  applyCopyStreamPatch();

  // ── З ПАТЧЕМ: не падає і, головне, НЕ ЧИТАЄ з потоку.
  const a = afterCleanup();
  assert.doesNotThrow(() => (a.q._forward as () => void).call(a.q),
    "🔴 патч не тримає: подія readable після завершення копії досі валить COPY");
  assert.equal(a.reads(), 0,
    "🔴 патч пропустив читання з потоку. Цей chunk належить НАСТУПНОМУ повідомленню "
    + "протоколу — проковтнути його означає зіпсувати зʼєднання замість копії");

  // ── БЕЗ ПАТЧА (знімаємо тимчасово): та сама фікстура МУСИТЬ упасти.
  //    Інакше перевірка вище зеленіла б і на зламаному патчі — просто тому,
  //    що ламатись нема чому.
  const p = proto();
  const saved = p._forward;
  p._forward = function (this: Record<string, unknown>) {
    // дослівна поведінка оригіналу: охоронець без перевірки `_buffer`
    if (this._forwarding || !this._drained || !this.connection) return;
    const st = (this.connection as { stream: { read: () => Buffer | null } }).stream;
    let chunk: Buffer | null;
    while (this._drained && (chunk = st.read()) !== null) this._drained = (this._parse as Function).call(this, chunk);
  };
  const b = afterCleanup();
  assert.throws(() => (b.q._forward as () => void).call(b.q), /reading 'push'|_buffer/,
    "🔴 фікстура НЕ відтворює гонку — гейт порожній, і «з патчем не падає» нічого не доводить");
  p._forward = saved;
});

test("#75c БЕЗ ПАТЧА БЕКАП НЕ ПОЧИНАЄТЬСЯ, а не працює тихо", async () => {
  const m = await import("./copyStreamPatch.js");
  m.applyCopyStreamPatch();
  assert.doesNotThrow(() => m.assertCopyStreamPatched(), "🔴 з накладеним патчем відмовляється працювати");

  // Імітуємо «бібліотеку оновили»: підміняємо `_parse` так, щоб відбиток не збігся.
  const p = proto();
  const savedParse = p._parse, savedForward = p._forward;
  delete (p._forward as { __utsCopyPatch?: boolean }).__utsCopyPatch;
  p._parse = function () { /* переписано вгорі — нашого `this._buffer.push` більше немає */ };
  const st = m.applyCopyStreamPatch();
  assert.equal(st.applied, false, "🔴 патч ліг на чужий код, відбитку якого не впізнав");
  assert.match(String(st.reason), /відбиток/, "🔴 причина відмови не названа");
  assert.throws(() => m.assertCopyStreamPatched(), /НЕ накладено/,
    "🔴 бекап погодився працювати без патча — саме та тиха робота, якої не має бути");
  // Відновлення: повертаємо збережену (вже пропатчену) функцію РАЗОМ із маркером.
  // Без маркера `applyCopyStreamPatch` чесно відмовиться — бо побачить у `_forward`
  // згадку `_buffer` і вирішить, що баг виправлено вгорі. Це правильна поведінка
  // відбитка, і саме тому відновлюємо стан, а не кличемо патч ще раз.
  p._parse = savedParse;
  p._forward = savedForward;
  (p._forward as { __utsCopyPatch?: boolean }).__utsCopyPatch = true;
  assert.doesNotThrow(() => m.applyCopyStreamPatch());
  assert.equal(m.copyPatchState().applied, true, "🔴 стан не відновився після тесту");
});

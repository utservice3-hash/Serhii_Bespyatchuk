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

/**
 * 🔴 ФІКСТУРА ВІДТВОРЮЄ ЦИКЛ, А НЕ МОЮ ГІПОТЕЗУ.
 *
 * Перша редакція цього гейта імітувала подію `readable` ПІСЛЯ `_cleanup()` — і була
 * зелена, поки патч насправді НЕ ПРАЦЮВАВ (15 падінь із 30 на проді). Саботаж її
 * валив, і це виглядало як доказ. Механізм інший: копія завершується ВСЕРЕДИНІ циклу
 * `_forward`, і наступна ітерація читає ще один chunk.
 *
 * Тут відтворено саме це: `_parse` на ПЕРШОМУ chunk кличе `_cleanup()` (як робить
 * бібліотека, коли дочитала копію) і повертає `true`. Далі все вирішує те, що
 * поверне обгортка.
 */
function loopFixture(parse: (this: Record<string, unknown>, c: unknown) => unknown) {
  let reads = 0;
  const q: Record<string, unknown> = {
    _buffer: { push: () => {} }, _drained: true, _forwarding: false,
    _cleanup(this: Record<string, unknown>) { this._buffer = null; },
    _parse: parse,
    connection: { stream: { read: () => { reads++; return reads <= 2 ? Buffer.from("x") : null; } } },
  };
  return { q, reads: () => reads };
}

/** Дослівний цикл із `copy-to.js` — щоб перевіряти НАШЕ правило, а не переписаний цикл. */
function origForward(this: Record<string, unknown>): void {
  if (this._forwarding || !this._drained || !this.connection) return;
  this._forwarding = true;
  const st = (this.connection as { stream: { read: () => Buffer | null } }).stream;
  let chunk: Buffer | null;
  while (this._drained && (chunk = st.read()) !== null)
    this._drained = (this._parse as Function).call(this, chunk);
  this._forwarding = false;
}

test("#75 ПАТЧ НАКЛАДЕНО, І ВІДБИТОК БІБЛІОТЕКИ ТОЙ, ЩО ОЧІКУВАВСЯ", async () => {
  const { applyCopyStreamPatch, copyPatchState } = await import("./copyStreamPatch.js");
  const st = applyCopyStreamPatch();
  assert.equal(st.applied, true,
    `🔴 патч НЕ ліг: ${st.reason}. Бібліотеку оновили або переписали — перевір, чи баг `
    + "не виправлено вгорі: тоді патч треба ПРИБРАТИ, а не лагодити");
  assert.equal(copyPatchState().applied, true, "🔴 стан патча не запамʼятався");
  assert.equal((proto()._parse as { __utsCopyPatch?: boolean }).__utsCopyPatch, true,
    "🔴 позначки на пропатченій функції немає — накладено не те, що думаємо");
  // Ідемпотентність: повторний виклик не має обгортати обгортку.
  const before = proto()._parse;
  applyCopyStreamPatch();
  assert.equal(proto()._parse, before, "🔴 повторний виклик наклав патч удруге");
});

test("#75b ГОНКА ВІДТВОРЕНА: без патча — падіння, з патчем — тиша", async () => {
  const { wrapParse } = await import("./copyStreamPatch.js");

  // «Бібліотечний» _parse: на першому chunk копія дочитана → _cleanup() обнуляє буфер.
  const libParse = function (this: Record<string, unknown>): unknown {
    (this._buffer as { push: (c: unknown) => void }).push(null); // те, що падає, якщо буфера немає
    (this._cleanup as () => void).call(this);
    return true;
  };

  // ── БЕЗ ПАТЧА: другий оберт циклу валиться на null-буфері.
  const bad = loopFixture(libParse);
  assert.throws(() => origForward.call(bad.q), /reading 'push'/,
    "🔴 фікстура НЕ відтворює гонку — гейт порожній. Саме на цьому я вже спіймався: "
    + "зелений тест при непрацюючому патчі");
  assert.equal(bad.reads(), 2, "🔴 без патча цикл мусив прочитати ДРУГИЙ chunk — інакше ламатись нема на чому");

  // ── З ПАТЧЕМ: не падає І не читає другий chunk.
  const good = loopFixture(wrapParse(libParse) as never);
  assert.doesNotThrow(() => origForward.call(good.q), "🔴 патч не зупиняє цикл");
  assert.equal(good.reads(), 1,
    "🔴 патч дозволив ще один read(). Після _detach() потік уже належить обробнику pg — "
    + "зайвий chunk краде повідомлення протоколу і псує ЗʼЄДНАННЯ, а не копію");

  // Дзеркало: поки буфер живий, обгортка нічого не міняє.
  const alive = { _buffer: { push: () => {} } } as Record<string, unknown>;
  assert.equal(wrapParse(() => "як-є").call(alive as never, null), "як-є",
    "🔴 обгортка втручається в нормальний хід — вона мусить бути прозорою");
});

test("#75c БЕЗ ПАТЧА БЕКАП НЕ ПОЧИНАЄТЬСЯ, а не працює тихо", async () => {
  const m = await import("./copyStreamPatch.js");
  m.applyCopyStreamPatch();
  assert.doesNotThrow(() => m.assertCopyStreamPatched(), "🔴 з накладеним патчем відмовляється працювати");

  // Імітуємо «бібліотеку оновили»: підміняємо `_parse` так, щоб відбиток не збігся.
  const p = proto();
  const savedParse = p._parse, savedForward = p._forward;
  delete (p._parse as { __utsCopyPatch?: boolean }).__utsCopyPatch;
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
  (p._parse as { __utsCopyPatch?: boolean }).__utsCopyPatch = true;
  assert.doesNotThrow(() => m.applyCopyStreamPatch());
  assert.equal(m.copyPatchState().applied, true, "🔴 стан не відновився після тесту");
});

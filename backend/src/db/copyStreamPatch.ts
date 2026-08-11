import { to as copyTo } from "pg-copy-streams";

/**
 * 🩹 ПАТЧ ГОНКИ В `pg-copy-streams` — і гейт на те, що він ДОСІ накладається.
 *
 * 🔴 ЩО ЗЛАМАНО (заміряно 11.08.2026 проти прода). `copy-to.js`:
 *
 *     _cleanup()  { this._buffer = null; … }          // завершення копії
 *     _forward()  { if (this._forwarding || !this._drained || !this.connection) return
 *                   … this._drained = this._parse(chunk) }
 *     _parse(c)   { this._buffer.push(c)  ← рядок 95: TypeError на null }
 *
 * `_cleanup` обнуляє буфер, але НЕ чіпає жодного поля, яке стереже охоронець
 * `_forward`. Прилетіла ще одна подія `readable` після завершення копії — і
 * `_parse` отримує `this._buffer === null`. Чиста гонка за часом: не залежить ні
 * від таблиці, ні від розміру рядка.
 *
 * **Заміряно:** 30 спроб поспіль на `stats_series` (3 МБ, найбільший рядок 160 байт)
 * дали **12 успіхів і 18 падінь — 60%**. Через це `COPY_ATTEMPTS = 3` був не
 * запобіжником, а лотереєю: три невдачі поспіль мають шанс 21.6%, тобто ≈17 таблиць
 * із 78 очікувано втрачались би за прогін.
 *
 * **Апгрейд НЕ лікує:** `copy-to.js` у 7.0.0 байт-у-байт той самий, окрім
 * `require('obuf')` → `require('./obuf')`. Перевірено `npm pack` обох версій.
 *
 * 🔴 ЧОМУ ПАТЧИМО `_forward`, А НЕ `_parse` (відступ від початкового формулювання).
 * «Хай `_parse` тихо завершується при `_buffer === null`» лікує симптом, але вже
 * ПІСЛЯ того, як `_forward` витяг chunk із потоку: `while (… (chunk = connectionStream.read()) !== null)`.
 * А до цього моменту `_detach()` уже повернув потік справжньому обробнику `pg` —
 * тобто вкрадений chunk належить НАСТУПНОМУ повідомленню протоколу. Проковтнути
 * його означало б зіпсувати зʼєднання замість того, щоб зіпсувати копію: тихіше,
 * але гірше. Охоронець `_forward` не дає прочитати chunk узагалі — нічого не
 * крадеться і нічого не губиться.
 */

/**
 * ВІДБИТОК БІБЛІОТЕКИ. Патч тримається на тому, ЯК саме написані три функції.
 * Оновлять пакет, перепишуть внутрішнє — і накладка мовчки перестане мати сенс.
 * Тому перед патчем звіряємо все, на що він спирається:
 *   1. `_parse` справді штовхає в `this._buffer` (є що ламати);
 *   2. `_cleanup` справді обнуляє `_buffer` (є звідки взятись `null`);
 *   3. охоронець `_forward` про `_buffer` НЕ питає (баг ще не виправлений вгорі).
 *
 * ⚠️ Пункт 3 — не формальність: якщо автори полагодять це самі, відбиток НЕ
 * збігається, ми падаємо і ПРИБИРАЄМО патч. Мовчазна накладка поверх виправленого
 * коду — така сама пастка, як її відсутність.
 */
const FINGERPRINT: { name: string; check: (src: Record<string, string>) => boolean; why: string }[] = [
  { name: "_parse штовхає в this._buffer", why: "інакше ламатись нема чому — патч поверх іншого коду",
    check: (s) => /this\._buffer\.push\(/.test(s._parse) },
  { name: "_cleanup обнуляє this._buffer", why: "інакше null у _buffer не звідки взятись",
    check: (s) => /this\._buffer\s*=\s*null/.test(s._cleanup) },
  { name: "охоронець _forward НЕ питає про _buffer", why: "якщо питає — баг уже виправлено вгорі, патч треба ПРИБРАТИ",
    check: (s) => !/_buffer/.test(s._forward) },
];

export interface CopyPatchState { applied: boolean; reason: string | null; }
let state: CopyPatchState = { applied: false, reason: "ще не застосовано" };

/** Прототип `CopyStreamQuery` — клас назовні не експортується, дістаємо з екземпляра. */
function copyProto(): Record<string, (...a: unknown[]) => unknown> {
  // Конструктор нічого не робить із зʼєднанням — лише виставляє поля.
  return Object.getPrototypeOf(copyTo("COPY (SELECT 1) TO STDOUT"));
}

export function applyCopyStreamPatch(): CopyPatchState {
  try {
    const proto = copyProto();
    if ((proto._forward as { __utsCopyPatch?: boolean }).__utsCopyPatch) {
      state = { applied: true, reason: null };
      return state;
    }
    const src = { _parse: String(proto._parse), _cleanup: String(proto._cleanup), _forward: String(proto._forward) };
    for (const f of FINGERPRINT)
      if (!f.check(src))
        throw new Error(`відбиток pg-copy-streams не збігся: «${f.name}» — ${f.why}`);

    const orig = proto._forward;
    function patched(this: { _buffer: unknown }, ...args: unknown[]): unknown {
      // Копія вже завершилась і прибрала за собою — читати з потоку більше НЕ можна.
      if (this._buffer == null) return undefined;
      return orig.apply(this, args);
    }
    (patched as { __utsCopyPatch?: boolean }).__utsCopyPatch = true;
    proto._forward = patched as typeof proto._forward;
    state = { applied: true, reason: null };
  } catch (err) {
    state = { applied: false, reason: err instanceof Error ? err.message : String(err) };
  }
  return state;
}

export function copyPatchState(): CopyPatchState { return state; }

/**
 * 🔴 «НЕ НАКЛАДЕНО → ПАДІННЯ З ЧЕСНОЮ ПОМИЛКОЮ, А НЕ ТИХА РОБОТА БЕЗ НЬОГО».
 *
 * ⚠️ Свідомий відступ: падаємо НЕ на старті сервера, а на старті БЕКАПУ.
 * Патч захищає рівно одну джобу; класти весь сайт через те, що накладка не лягла
 * на бібліотеку копіювання, — непропорційно (на відміну від кеша ролей, де ціна
 * тихої роботи = відкриті гейти). Джоба падає гучно: помилка йде в `job_runs`,
 * звідти в банер. Тиха робота без патча неможлива в обох випадках.
 */
export function assertCopyStreamPatched(): void {
  const s = copyPatchState();
  if (!s.applied)
    throw new Error(
      `backupDb: патч гонки pg-copy-streams НЕ накладено (${s.reason}). Без нього ~60% таблиць `
      + "падають на COPY, і копія буде частковою. Перевір версію pg-copy-streams і "
      + "src/db/copyStreamPatch.ts — можливо, баг виправили вгорі й патч треба прибрати.");
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { wireValue, PLAN_MIN_BOUNDS, DEFAULT_PLAN_MIN } from "../core/settingWire.js";

/**
 * 🤝 #277–#277b — ФРОНТОВИЙ ТИП НАЛАШТУВАНЬ == БЕКЕНДНОМУ, І ЗБЕРЕЖЕННЯ НІЧОГО НЕ ГУБИТЬ.
 *
 * 🔴 ПРИВІД, ЗАМІРЯНИЙ 02.09.2026. Фронтовий `AppSettings` мав ШІСТЬ полів із девʼяти:
 * бракувало `planMinPerManager`, `tracker` і `adSources`. `saveSettings` шле САМЕ цей
 * обʼєкт — отже екран Налаштувань щоразу надсилав неповний набір. Не втрачалось нічого
 * ЛИШЕ тому, що PUT написаний оборонно: кожне поле має фолбек `current.X`, а `tracker` —
 * по кожному підполю окремо.
 *
 * Тобто ми були зелені ЗАВДЯКИ ДІРЦІ, а не за побудовою: варто комусь дописати нове поле
 * без фолбека — і перше ж збереження стерло б його ВСІМ, а фронт би не помітив. Сьогодні
 * найгостріше з трекером: його конфіг переживає збереження виключно завдяки фолбекам.
 *
 * ⚠️ Гейти читають ДЖЕРЕЛО обох сторін, бо предмет — саме УЗГОДЖЕНІСТЬ двох файлів.
 * Жива перевірка бачить один шлях і не бачить розбіжності типів узагалі.
 */

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const SRC = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

/** Поля інтерфейсу `AppSettings` із тексту — по імені перед двокрапкою на верхньому рівні. */
function fields(src: string, iface: string): string[] {
  const m = new RegExp(`export interface ${iface} \\{([\\s\\S]*?)\\n\\}`).exec(src);
  if (!m) return [];
  const body = m[1].replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  let depth = 0;
  const out: string[] = [];
  for (const line of body.split("\n")) {
    const name = /^\s{2}(\w+)\??\s*:/.exec(line);
    if (depth === 0 && name) out.push(name[1]);
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
  }
  return out.sort();
}

test("#277 КОНТРАКТ: множина полів фронту == множині полів бекенда", () => {
  const be = fields(SRC("backend/src/routes/settings.ts"), "AppSettings");
  const fe = fields(SRC("frontend/src/api.ts"), "AppSettings");
  assert.ok(be.length >= 8, `🔴 бекендний тип не впізнано (${be.length} полів) — гейт втратив предмет`);
  assert.ok(fe.length >= 8, `🔴 фронтовий тип не впізнано (${fe.length} полів)`);
  const missingFe = be.filter((f) => !fe.includes(f));
  const extraFe = fe.filter((f) => !be.includes(f));
  assert.deepEqual(missingFe, [],
    `🔴 фронт НЕ ЗНАЄ полів: ${missingFe.join(", ")}. Екран шле неповний набір, і вони ` +
    "виживають лише завдяки фолбекам у PUT — тобто завдяки дірці, а не за побудовою");
  assert.deepEqual(extraFe, [],
    `🔴 фронт знає поля, яких у бекенді немає: ${extraFe.join(", ")} — вони летять у нікуди`);
});

test("#277b 🪞 КОЖНЕ ПОЛЕ PUT МАЄ ФОЛБЕК НА ПОТОЧНЕ — другий шар не прибрано", () => {
  /**
   * Контракт вище — ПЕРШИЙ шар. Фолбеки лишаються ДРУГИМ: часткове збереження мусить
   * бути безпечним і тоді, коли запит шле не наш екран (агент, curl, старий бандл).
   * 🔴 Без цього твердження «звели контракт» стало б приводом фолбеки прибрати.
   */
  const be = SRC("backend/src/routes/settings.ts");
  const next = /const next: AppSettings = \{([\s\S]*?)\n  \};/.exec(be);
  assert.ok(next, "🔴 блок `next` не впізнано — гейт втратив предмет");
  const body = next![1];
  for (const f of ["loyaltyThreshold", "sleepingWindowMonths", "ratesFallbackFullPerKm", "adSources"]) {
    assert.ok(new RegExp(`${f}[\\s\\S]{0,200}?current\\.${f}`).test(body),
      `🔴 поле «${f}» більше не має фолбека на current — часткове збереження зітре його`);
  }
  // Трекер: фолбек ПО КОЖНОМУ підполю, а не на обʼєкт цілком.
  const tr = /tracker: \{([\s\S]*?)\n    \},/.exec(body);
  assert.ok(tr, "🔴 блок `tracker` не впізнано");
  const subs = [...tr![1].matchAll(/current\.tracker\.(\w+)/g)].map((m) => m[1]);
  assert.ok(subs.length >= 8,
    `🔴 підполів трекера з фолбеком лише ${subs.length} — решта зникне при збереженні ` +
    "налаштувань з екрана. Трекер вмикається цими днями, і його конфіг тримається саме на цьому");
  // 🪞 І межа плану теж має фолбек — але через три стани, а не clampInt.
  assert.ok(/wireValue\(body\.planMinPerManager/.test(body),
    "🔴 межа плану більше не читається через три стани — «очистити» знову означатиме нуль");
  assert.equal(wireValue(undefined, PLAN_MIN_BOUNDS, 12345, DEFAULT_PLAN_MIN), 12345);
});

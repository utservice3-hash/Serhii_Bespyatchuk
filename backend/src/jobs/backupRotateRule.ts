/**
 * ПРАВИЛО РОТАЦІЇ БЕКАПІВ — окремий модуль БЕЗ жодного імпорту.
 *
 * ⚠️ ЧОМУ ОКРЕМО. `backupDb.ts` тягне `config.js`, який кидає на відсутньому
 * `DATABASE_URL` ще НА ІМПОРТІ — тест не встигає навіть почати. Це **четвертий**
 * випадок цієї пастки за сесію (перед тим: `monitoredJobs`, `syncGuardRule`,
 * `klassParity`), тож дані й рішення відокремлені від з'єднання ЗАВЖДИ.
 *
 * 🔴 НАВІЩО ЦЕ ПРАВИЛО. 10.08.2026 у каталозі лежало 26 папок бекапу, а
 * `MANIFEST.txt` мали ТРИ: 20.07, 25.07, 29.07. Ротація «тримати 14 найновіших
 * папок» зітерла б найстаріші — тобто дві з трьох єдиних придатних копій, лишивши
 * чотирнадцять порожніх. Наявність папки читалася б як наявність бекапу.
 */

/** Скільки придатних копій тримаємо (за звичайних умов). */
export const KEEP = 14;
/** Скільки днів тримаємо НЕПОВНІ копії, перш ніж прибрати. */
export const KEEP_BROKEN_DAYS = 14;
/**
 * 🔒 ПІДЛОГА, НЕЗАЛЕЖНА ВІД `KEEP` — правило власника 10.08.2026 дослівно:
 * каталог із `MANIFEST.txt` не видаляється, поки не існує щонайменше ДВОХ новіших
 * каталогів із `MANIFEST.txt`. Зменшить хтось `KEEP` до 1 — остання копія все одно
 * вціліє. Інваріанта не має триматись на вдалому значенні константи.
 */
export const MIN_KEPT_COMPLETE = 2;

/**
 * ЩО САМЕ ротація видалила б — ЧИСТА функція, без файлової системи.
 * Так рішення доводиться фікстурою, а не «прогнати й подивитись, що зникло».
 */
export function plannedDeletions(
  dirs: { name: string; complete: boolean }[],
  nowMs: number,
  keep = KEEP,
  keepBrokenDays = KEEP_BROKEN_DAYS
): string[] {
  const sorted = [...dirs].sort((a, b) => a.name.localeCompare(b.name));
  const complete = sorted.filter((d) => d.complete);
  const out: string[] = [];
  // Неповні: прибираємо лише старші за поріг — копіями вони не є, але слідів для
  // розбору позбавляти себе не варто, доки місце дозволяє.
  const cutoff = nowMs - keepBrokenDays * 86_400_000;
  for (const d of sorted.filter((x) => !x.complete)) {
    const ts = Date.parse(d.name.slice(4, 14)); // `uts_YYYY-MM-DD_…`; нерозбірне ім'я лишаємо
    if (Number.isFinite(ts) && ts < cutoff) out.push(d.name);
  }
  // Придатні: за `keep`, але НІКОЛИ не чіпаємо останні `MIN_KEPT_COMPLETE`.
  const maxDeletable = Math.max(0, complete.length - Math.max(keep, MIN_KEPT_COMPLETE));
  for (const d of complete.slice(0, maxDeletable)) out.push(d.name);
  return out;
}

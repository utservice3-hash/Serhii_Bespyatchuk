/**
 * 📊 КРИТЕРІЙ КРОКУ `test` У ВИКАТІ — ПРИРІСТ, А НЕ КОД 0.
 *
 * 🔴 ЧОМУ. `npm test` у контейнері дає **104 падіння** через відсутній `backend/.env`;
 * на прод-сервері натомість скіпаються scratch-гейти, заради яких крок 0 і існує.
 * Тобто вимога «код 0» невиконувана в ЖОДНОМУ з двох середовищ — і `deploy:check`
 * обходили запасним шляхом. Інструмент, який неможливо виконати, не захищає нікого:
 * його перестають запускати, і робить це не порушник, а сумлінний виконавець.
 *
 * ⚖️ КРИТЕРІЙ ТРИСКЛАДОВИЙ, І КОЖНА ЧАСТИНА ЗАКРИВАЄ СВІЙ СТАН ІЗ ПРАВИЛА ПРО ТРИ:
 *   ① приріст падінь == 0            — «пройшло» проти «впало»
 *   ② виконане не звузилось          — «жодного разу не виконувалось»
 *   ③ жоден гейт не зник             — «не застосовувалось» (реєстр оголошень)
 * Одне без одного пропускає рівно ту дію, якої ми боїмось: зняв гейт → падінь стало
 * менше → крок зелений. Заміряно на власному прикладі: «полагоджене» оточення
 * (`JWT_SECRET=dummy`, знятий `DATABASE_URL`) дає бездоганні **459 ✔ / 0 падінь** —
 * і НЕ ВИКОНУЄ двохсот тестів. Ані ①, ані ③ цього не бачать.
 */

export interface TapLine { name: string; ok: boolean; skipped: boolean }

/**
 * 🔴 БЕЗ НОРМАЛІЗАЦІЇ ПОРІВНЯННЯ ПО ІМЕНАХ — НЕ КРАЩЕ ЗА ПОРІВНЯННЯ ПО ЧИСЛУ,
 * А НОВИЙ СПОСІБ ЗБРЕХАТИ В ОБИДВА БОКИ ОДНОЧАСНО.
 *
 * Заміряно 26.08.2026 на ОДНАКОВОМУ коді: 8 зі 104 падінь — це смерть ФАЙЛУ, і TAP
 * називає її АБСОЛЮТНИМ шляхом. База лежить у worktree, дерево — у клоні, тож сирі
 * імена дали «8 зникло, 8 зʼявилось». Після нормалізації — 0 і 0.
 * Плюс TAP екранує решітку: `\#6 БЕЗПЕКА…`. Той самий баг я вже мав у `gateCount`.
 */
export function normaliseName(raw: string): string {
  const unescaped = raw.replace(/\\(.)/g, "$1").trim();
  // Смерть файлу: лишаємо шлях ВІД `dist/`, тобто те, що однакове в будь-якому чекауті.
  const m = /(?:^|\/)dist\/(.+\.test\.(?:js|mjs|cjs))$/.exec(unescaped);
  return m ? `dist/${m[1]}` : unescaped;
}

/** Розбір TAP-виводу `node --test`. Директиви `# SKIP` / `# TODO` — не частина імені. */
export function parseTap(out: string): TapLine[] {
  const res: TapLine[] = [];
  for (const line of out.split("\n")) {
    const m = /^(not ok|ok) (\d+) - (.*)$/.exec(line);
    if (!m) continue;
    let name = m[3];
    const dir = / # (SKIP|TODO)\b.*$/i.exec(name);
    if (dir) name = name.slice(0, dir.index);
    res.push({ name: normaliseName(name), ok: m[1] === "ok", skipped: !!dir });
  }
  return res;
}

/**
 * 🔴 НОРМАЛІЗУЄМО ТУТ, А НЕ ПОКЛАДАЄМОСЬ НА ВИКЛИКАЧА. `normaliseName` ідемпотентна,
 * тож повторний виклик нічого не коштує — а от критерій, який мовчки вимагає, щоб
 * хтось ІНШИЙ підготував йому вхід, ламається рівно тоді, коли його покличуть з
 * нового місця. Той самий клас, що «умова була правильною, бо хтось поруч давав їй
 * потрібні дані».
 */
const failed = (t: readonly TapLine[]) =>
  new Set(t.filter((x) => !x.ok).map((x) => normaliseName(x.name)));
/** «Виконано» = не скіпнуто. Саме ця множина не сміє звужуватись. */
const executed = (t: readonly TapLine[]) =>
  new Set(t.filter((x) => !x.skipped).map((x) => normaliseName(x.name)));

export interface Delta {
  ok: boolean;
  newFailures: string[];
  stoppedExecuting: string[];
  lostGates: string[];
  /** Падіння, що зникли. НЕ помилка — але й не тиха «перемога»: див. коментар нижче. */
  vanishedFailures: string[];
  lines: string[];
}

/**
 * 🔴 ЗНИКЛЕ ПАДІННЯ КРОК НЕ ВГАДУЄ, А НАЗИВАЄ. Воно означає одне з двох — чужий фікс
 * або НЕТОТОЖНІ середовища — і розрізнити їх з імен неможливо. Тихо зарахувати це як
 * покращення означало б повторити «105 проти 106»: голе число сховало б регресію під
 * виглядом поліпшення. Небезпечний варіант (тест зник або став скіпом) ловить ②.
 */
export function judgeDelta(
  base: readonly TapLine[], tree: readonly TapLine[], lostGates: readonly string[] = [],
): Delta {
  const bf = failed(base), tf = failed(tree);
  const be = executed(base), te = executed(tree);
  const newFailures = [...tf].filter((n) => !bf.has(n)).sort();
  const vanishedFailures = [...bf].filter((n) => !tf.has(n)).sort();
  const stoppedExecuting = [...be].filter((n) => !te.has(n)).sort();
  const lost = [...lostGates].sort();
  const ok = newFailures.length === 0 && stoppedExecuting.length === 0 && lost.length === 0;

  const lines: string[] = [
    `база: ${base.length} рядків, падінь ${bf.size}, виконано ${be.size}`,
    `дерево: ${tree.length} рядків, падінь ${tf.size}, виконано ${te.size}`,
  ];
  if (newFailures.length) lines.push(
    `🔴 ① НОВІ ПАДІННЯ (${newFailures.length}) — їх не було на базі:`,
    ...newFailures.slice(0, 20).map((n) => `   ﹣ ${n}`));
  if (stoppedExecuting.length) lines.push(
    `🔴 ② ПЕРЕСТАЛИ ВИКОНУВАТИСЬ (${stoppedExecuting.length}) — на базі виконувались, тут скіпнуті або зникли.`,
    "   Це найтихіша з поломок: падінь НЕ побільшало, а перевіряти перестали:",
    ...stoppedExecuting.slice(0, 20).map((n) => `   ﹣ ${n}`));
  if (lost.length) lines.push(
    `🔴 ③ ЗНИКЛИ ГЕЙТИ (${lost.length}) за gateCount проти sha з health.version:`,
    ...lost.slice(0, 20).map((n) => `   ﹣ ${n}`));
  if (vanishedFailures.length) lines.push(
    `ℹ зникло падінь: ${vanishedFailures.length}. Це НЕ зараховується як покращення:`,
    "   зникле падіння означає або чужий фікс, або нетотожні середовища, і з імен",
    "   розрізнити їх неможливо. Якщо ти цього не робив — звір оточення обох прогонів.",
    ...vanishedFailures.slice(0, 10).map((n) => `   ﹣ ${n}`));
  if (ok) lines.push("✔ приріст падінь 0 · виконане не звузилось · гейти на місці");
  return { ok, newFailures, stoppedExecuting, lostGates: lost, vanishedFailures, lines };
}

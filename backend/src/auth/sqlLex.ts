/**
 * СКАНЕР ШАБЛОННИХ ЛІТЕРАЛІВ — заміна регулярці `/`([^`]{20,8000})`/g`.
 *
 * 🔴 НАВІЩО, ЦИФРОЮ. Регулярка не знає, який бектик відкривальний. Літерал із
 * підстановкою вона ріже навпіл (`SELECT … ${x ? `AND y` : ""} … FROM deals`
 * читається як «до внутрішнього бектика» + «від внутрішнього до зовнішнього»), а
 * підстановки має 386 із 659 літералів у `dist/routes`. Заміряно 26.08.2026 на
 * тому самому вході:
 *
 *   викликів `.query(` з шаблонним аргументом      358
 *   регулярка бачить блок рівно на цій позиції       50   (14%)
 *   сканер                                          358   (100%)
 *
 * І це ламало ворота В ОБИДВА боки, не лише в бік пропуску: з 20 блоків, які
 * `#17c` класифікував, ШІСТЬ не були літералами взагалі — обрізки й чистий JS
 * (`, [managerId]); if (chk.rows[0]?.team_id !== auth.teamId) return res.status(403)…`).
 * Ворота рахували керуючий потік як «законний SQL».
 *
 * 🧭 ЧОМУ СВІЙ СКАНЕР, А НЕ `typescript`. Шість файлів набору вже піднімають
 * компілятор, і саме вони — стоячий підозрюваний у тихих смертях файлів
 * (див. CLAUDE.md, «ВИКОНАЛОСЬ 450 ІЗ 466»). `gates.test.ts` сьогодні не піднімає
 * жодного; робити його сьомим заради 90 рядків — поганий обмін.
 *
 * ⚠️ РЕГУЛЯРНІ ЛІТЕРАЛИ — НЕ ПЕДАНТИЗМ, А ВИМІРЯНА ВИМОГА. У `routes/rates.js`
 * лежить /[’'`ʼ]/ — регулярка з БЕКТИКОМ усередині. Сканер, що не розрізняє
 * ділення й регулярку, з цього місця зсуне парність до кінця файла.
 */

/** Шаблонний літерал: `q` — вміст БЕЗ обрамлення, `at` — зсув відкривального бектика. */
export interface SqlBlock { q: string; at: number }
/** Конструкція, що не закрилась до кінця файла. Будь-яка — це «не зміг розібрати». */
export interface Unterminated { kind: "template" | "string" | "comment" | "substitution" | "regex"; at: number }
export interface LexResult { blocks: SqlBlock[]; unterminated: Unterminated[] }

/** Після цих символів `/` починає РЕГУЛЯРКУ, а не ділення. */
const REGEX_OK_AFTER = new Set("(,=:[!&|?{};*%+-~^<>".split(""));
/** Слова, після яких `/` теж регулярка (`return /x/.test(s)`). */
const REGEX_OK_WORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "case", "do", "else", "yield", "await", "throw",
]);

function regexAllowedAt(src: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return true;
  const c = src[j];
  if (REGEX_OK_AFTER.has(c)) return true;
  if (!/[A-Za-z0-9_$]/.test(c)) return false;
  let k = j;
  while (k >= 0 && /[A-Za-z0-9_$]/.test(src[k])) k--;
  return REGEX_OK_WORDS.has(src.slice(k + 1, j + 1));
}

type Frame = { kind: "tmpl"; at: number } | { kind: "sub"; at: number; braces: number };

/**
 * Розбирає джерело JS/TS і віддає ШАБЛОННІ ЛІТЕРАЛИ ВЕРХНЬОГО РІВНЯ.
 * Вкладені (усередині `${…}`) окремими блоками НЕ віддаються — вони вже входять
 * у текст зовнішнього, і саме так їх бачить читач запиту.
 *
 * Коментарі, рядкові літерали й регулярки сканер розуміє сам, тож попереднє
 * «зрізання коментарів» регуляркою більше не потрібне (воно ще й псувало розбір:
 * у `training.js` давало дві помилки синтаксису).
 */
export function lexTemplates(src: string): LexResult {
  const blocks: SqlBlock[] = [];
  const unterminated: Unterminated[] = [];
  const stack: Frame[] = [];
  const inTemplate = () => stack.length > 0 && stack[stack.length - 1].kind === "tmpl";
  let i = 0;

  while (i < src.length) {
    if (inTemplate()) {
      const top = stack[stack.length - 1] as { kind: "tmpl"; at: number };
      const c = src[i];
      if (c === "\\") { i += 2; continue; }
      if (c === "`") {
        stack.pop();
        // блок віддаємо ЛИШЕ якщо це літерал верхнього рівня
        if (!stack.some((f) => f.kind === "tmpl")) blocks.push({ q: src.slice(top.at + 1, i), at: top.at });
        i++; continue;
      }
      if (c === "$" && src[i + 1] === "{") { stack.push({ kind: "sub", at: i, braces: 0 }); i += 2; continue; }
      i++; continue;
    }

    const c = src[i];
    // ── коментарі
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl + 1; continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end === -1) { unterminated.push({ kind: "comment", at: i }); i = src.length; continue; }
      i = end + 2; continue;
    }
    // ── регулярний літерал
    if (c === "/" && regexAllowedAt(src, i)) {
      let j = i + 1, cls = false, closed = false;
      while (j < src.length) {
        const d = src[j];
        if (d === "\\") { j += 2; continue; }
        if (d === "\n") break;
        if (d === "[") cls = true;
        else if (d === "]") cls = false;
        else if (d === "/" && !cls) { closed = true; j++; break; }
        j++;
      }
      if (!closed) { i++; continue; }              // не регулярка — просто ділення
      while (j < src.length && /[a-z]/.test(src[j])) j++;
      i = j; continue;
    }
    // ── рядкові літерали
    if (c === "'" || c === '"') {
      let j = i + 1, closed = false;
      while (j < src.length) {
        const d = src[j];
        if (d === "\\") { j += 2; continue; }
        if (d === "\n") break;
        if (d === c) { closed = true; j++; break; }
        j++;
      }
      if (!closed) { unterminated.push({ kind: "string", at: i }); i = src.length; continue; }
      i = j; continue;
    }
    // ── шаблон
    if (c === "`") { stack.push({ kind: "tmpl", at: i }); i++; continue; }
    // ── дужки підстановки
    if (c === "{" && stack.length > 0 && stack[stack.length - 1].kind === "sub") {
      (stack[stack.length - 1] as { braces: number }).braces++; i++; continue;
    }
    if (c === "}" && stack.length > 0 && stack[stack.length - 1].kind === "sub") {
      const top = stack[stack.length - 1] as { kind: "sub"; at: number; braces: number };
      if (top.braces === 0) stack.pop(); else top.braces--;
      i++; continue;
    }
    i++;
  }

  for (const f of stack) unterminated.push({ kind: f.kind === "tmpl" ? "template" : "substitution", at: f.at });
  return { blocks, unterminated };
}

/**
 * ОРАКУЛ ПРИСУТНОСТІ, НЕЗАЛЕЖНИЙ ВІД СКАНЕРА. Позицію виклику `.query(` з
 * шаблонним аргументом видно простим пошуком — і саме з нею звіряється покриття.
 * Твердження «розібрано == присутньо» не спирається на те, що сканер сам про себе
 * каже (див. CLAUDE.md: «ГЕЙТ, ЩО ПОРІВНЮЄ ДВІ КОПІЇ, НАПИСАНІ В САМОМУ ТЕСТІ»).
 *
 * ⚠️ МЕЖА, НАЗВАНА ВГОЛОС: оракул рахує і `.query(` всередині коментаря, якщо такий
 * колись з'явиться, — і гейт тоді почервоніє. Це навмисно: відрізнити його від
 * справжнього виклику можна лише тим самим сканером, який оракул і перевіряє.
 */
export const QUERY_CALL = /\.query(?:Array)?\(\s*`/g;
export function queryCallOffsets(src: string): number[] {
  return [...src.matchAll(QUERY_CALL)].map((m) => (m.index ?? 0) + m[0].length - 1);
}

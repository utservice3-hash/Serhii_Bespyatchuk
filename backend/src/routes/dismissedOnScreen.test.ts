import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { needsApi, API_BASE } from "../testMode.js";

/**
 * #59 — БУДИЛЬНИК: ГРОШІ ЗВІЛЬНЕНИХ У СУМІ, АЛЕ НЕ НА ЕКРАНІ.
 *
 * 🔴 ПРИВІД І ЙОГО ТОЧНА ФОРМА. Відкат вигляду до 31.07 (рішення власника 07.08.2026)
 * повернув верстку, яка НЕ знає масиву `dismissed`. Водночас `glance.fact` рахує
 * гроші звільнених РАЗОМ з активними — і це правильно, бо інакше Σ по екрану
 * перестала б дорівнювати ядру. Виходить розбіжність: кільце «Команда за місяць»
 * показує суму, частину якої не пояснює жоден видимий рядок.
 *
 * 🟢 РІШЕННЯ ВЛАСНИКА — НЕ ХОВАТИ, А ПОСТАВИТИ БУДИЛЬНИК. `glance.fact` не чіпаємо
 * (число правильне); гейт червоніє В ТОЙ ДЕНЬ, коли `dismissed` стане непорожнім,
 * а верстці нема де його показати.
 *
 * ⚠️ ЧОМУ ЦЕ НЕ «ТЕСТ, ЩО ЗАВЖДИ ЗЕЛЕНИЙ». Сьогодні `dismissed` порожній (Шевчука
 * повернуто), тож будильник мовчить — і саме тому він потрібен: розбіжність
 * зʼявиться МОВЧКИ, першої ж деактивації, а не з попередженням. Заміряно 06.08,
 * поки Шевчук був деактивований: **71 896 ₴** у сумі компанії без жодного рядка
 * на екрані.
 */
const FE = fileURLToPath(new URL(
  "../../../frontend/src/pages/dashboard/sections/ReportPlanSection.tsx", import.meta.url));

/**
 * ⚠️ `toLocaleString("uk-UA")` розділяє розряди НЕРОЗРИВНИМ пробілом (U+00A0), а не
 * звичайним — перевірено: `71 896`. Через це `includes("71 896")` зі звичайним
 * пробілом не спрацьовував, і саботаж `#59b` червонів на СПРАВНОМУ предикаті.
 * Нормалізуємо тут, а не в тесті: текст поломки має ще й копіюватись у пошук.
 */
const fmtUah = (n: number) =>
  Math.round(n).toLocaleString("uk-UA").replace(/[  ,]/g, " ") + " ₴";

/**
 * Чи вміє верстка показати звільнених? Ознака — читання поля `dismissed` з відповіді.
 * Перевіряємо ДЖЕРЕЛО, бо це властивість розмітки: API віддає масив однаково, і
 * жоден HTTP-гейт не відрізнить «показано» від «проігноровано».
 *
 * 🔴 Коментарі вирізаються перед пошуком — інакше опис проблеми у самому файлі
 * зараховувався б як її розвʼязання (той самий клас, що ловили у `#58`).
 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

async function screenShowsDismissed(): Promise<boolean> {
  const src = stripComments(await readFile(FE, "utf8"));
  return /\bdismissed\b/.test(src);
}

/**
 * 🧮 ПРЕДИКАТ ВИНЕСЕНО В ЧИСТУ ФУНКЦІЮ — щоб його можна було САБОТУВАТИ без БД,
 * без прода і без деактивації живої людини. Повертає текст поломки або `null`.
 * Саме її кличуть обидва тести: `#59` — на живих даних, `#59b` — на підкинутих.
 */
export function unexplainedDismissedMoney(
  dismissed: { name: string; fact: number }[],
  showsDismissed: boolean,
  glanceFact: number,
): string | null {
  const money = dismissed.reduce((s, m) => s + (m.fact ?? 0), 0);
  if (money === 0) return null;      // немає грошей — немає розбіжності
  if (showsDismissed) return null;   // є де показати — теж немає
  return `🔴 ГРОШІ ЗВІЛЬНЕНИХ У СУМІ, АЛЕ НЕ НА ЕКРАНІ: ${fmtUah(money)} від `
    + `${dismissed.filter((m) => m.fact).length} осіб `
    + `(${dismissed.filter((m) => m.fact).map((m) => m.name).join(", ")}) входять у `
    + `glance.fact ${fmtUah(glanceFact)}, а верстка Звіту не читає масив \`dismissed\` — `
    + "жоден видимий рядок цієї суми не пояснює. Або показати їх окремим рядком, або "
    + "свідомо виключити з `glance.fact` (і тоді Σ по екрану розійдеться з ядром).";
}

test("#59 гроші звільнених не висять у сумі без рядка на екрані", needsApi(), async () => {
  const { signToken } = await import("../auth/auth.js");
  const token = signToken({ userId: 0, role: "admin", roleKey: "admin", managerId: null, teamId: null });
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);

  const r = await fetch(`${API_BASE}/api/dashboard/report-plan?from=${ym}-01&to=${to}`,
    { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200, `🔴 /report-plan віддав ${r.status}`);
  const b = await r.json() as { glance: { fact: number }; dismissed: { name: string; fact: number }[] };
  assert.ok(Array.isArray(b.dismissed),
    "🔴 у відповіді нема масиву `dismissed` — будильник перевіряє не те, що думає");

  const problem = unexplainedDismissedMoney(b.dismissed, await screenShowsDismissed(), b.glance.fact);
  assert.equal(problem, null, problem ?? "");
});

/**
 * #59b — САБОТАЖ В ОБИДВА БОКИ, БЕЗ БД І БЕЗ ПРОДА.
 *
 * Підкидаємо предикату рівно той стан, що був 06.08 — звільнений Шевчук із
 * 71 896 ₴ — і вимагаємо ЧЕРВОНОГО. Дзеркало: той самий стан, але верстка вміє
 * показати звільнених → предикат мовчить.
 *
 * ⚠️ ЧОМУ НЕ «ДЕАКТИВУВАТИ ЖИВОГО В ТРАНЗАКЦІЇ З ROLLBACK», як просив власник.
 * Спробував — і воно НЕ довело б нічого: `#59` читає HTTP, а сервер ходить у БД
 * СВОЇМ зʼєднанням і незакомічену транзакцію не бачить у принципі. Тест був би
 * зелений незалежно від того, працює предикат чи ні. Тому саботуємо ВХІД
 * предиката, а не стан бази: перевіряється та сама логіка, тільки чесно.
 */
test("#59b саботаж: звільнений із грішми робить предикат червоним", async () => {
  const SABOTAGE = [{ name: "Шевчук Назар", fact: 71_896 }];

  const red = unexplainedDismissedMoney(SABOTAGE, false, 347_116);
  assert.ok(red && red.includes("71 896"),
    "🔴 предикат НЕ помітив 71 896 ₴ у звільненого при верстці без `dismissed` — будильник глухий");
  assert.ok(red.includes("Шевчук Назар"),
    "🔴 повідомлення не називає, ЧИЇ це гроші — з такого тексту не почати розбір");

  // Дзеркало 1: верстка вміє показати → мовчить.
  assert.equal(unexplainedDismissedMoney(SABOTAGE, true, 347_116), null,
    "🔴 предикат червоніє навіть тоді, коли звільнених Є ДЕ показати — він би будив дарма "
    + "й за два тижні його вимкнули б");
  // Дзеркало 2: звільнені є, але без грошей → теж мовчить (сам факт звільнення не поломка).
  assert.equal(unexplainedDismissedMoney([{ name: "Хтось", fact: 0 }], false, 347_116), null,
    "🔴 предикат вважає поломкою звільненого БЕЗ грошей — а він нічого не спотворює");
});

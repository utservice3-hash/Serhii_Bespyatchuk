/**
 * 🗂 Розбір таблиці Даші «UTS UA техніка» → вкладка «Облік техніки 2026» (рішення Романа 29.09.2026:
 * перенести разово, після викату). Чисто, без бази й мережі — щоб гейт #967 перевіряв саме правила.
 *
 * Що заміряно в таблиці 29.09.2026 (≈72 одиниці, 16 людей, 40 «вільний»):
 *  • над шапкою — блок «Розташування | Київ 201»: це розташування за замовчуванням для рядків нижче;
 *  • шапка: Обліковий № | Тип | Модель | Дата придбання | Де придбано | Ціна | Коментарій |
 *    Розташування | Відповідальний | Користувач | Дата переміщення;
 *  • колонки «Дата придбання» і «Де придбано» місцями зсунуті (дата лежить у колонці посилання),
 *    тож дату й посилання шукаємо в ОБОХ за формою значення, а не за номером колонки;
 *  • «бн» в обліковому № і «-» у тексті — «не заповнено», а не значення (сентинел → порожньо);
 *  • «Користувач» = «вільний» — видачі немає; будь-що інше — людина, якій видано.
 */
export interface SheetItem {
  row: number;
  invNo: string;
  kind: string;
  model: string;
  purchasedOn: string | null;
  purchaseUrl: string | null;
  price: number | null;
  comment: string;
  location: string;
  holderName: string | null;
  movedOn: string | null;
}

const SENTINELS = new Set(["-", "—", "бн", "б/н", "н/д"]);
const clean = (v: string | undefined): string => {
  const s = (v ?? "").replace(/\s+/g, " ").trim();
  return SENTINELS.has(s.toLowerCase()) ? "" : s;
};
/**
 * `дд.мм.рррр` → `рррр-мм-дд`; решта (і неіснуючі дати) — null. Роздільник буває й `,` та `/`
 * (заміряно в таблиці: «03,07.2026», «14/08/2026») — це та сама дата, а не сміття.
 */
export function dmyToIso(v: string | undefined): string | null {
  const m = /^(\d{1,2})[.,/](\d{1,2})[.,/](\d{4})$/.exec(clean(v));
  if (!m) return null;
  const iso = `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso;
}
function priceOf(v: string | undefined): number | null {
  const s = clean(v).replace(/[\s ₴грн.]/gi, "").replace(",", ".");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function parseEquipmentSheet(table: string[][]): { items: SheetItem[]; skipped: number; header: number } {
  const header = table.findIndex((r) => clean(r[1]) === "Тип" && clean(r[0]).startsWith("Обліковий"));
  if (header < 0) throw new Error("У таблиці не знайдено шапки «Обліковий № | Тип | …» — розкладка змінилась, перенесення зупинено");
  let block = "";
  for (let i = 0; i < header; i++) if (clean(table[i][2]) === "Розташування" && clean(table[i][3])) block = clean(table[i][3]);
  const items: SheetItem[] = [];
  let skipped = 0;
  for (let i = header + 1; i < table.length; i++) {
    const r = table[i];
    if (clean(r[2]) === "Розташування" && clean(r[3]) && !clean(r[1])) { block = clean(r[3]); continue; }
    const kind = clean(r[1]);
    if (!kind) { if (r.some((c) => clean(c))) skipped++; continue; }
    const c34 = [r[3], r[4]];
    const user = clean(r[9]);
    items.push({
      row: i + 1,
      invNo: clean(r[0]),
      kind,
      model: clean(r[2]),
      purchasedOn: c34.map(dmyToIso).find((x) => x) ?? null,
      purchaseUrl: c34.map(clean).find((x) => /^https?:\/\//i.test(x)) ?? null,
      price: priceOf(r[5]),
      comment: clean(r[6]),
      location: clean(r[7]) || block,
      holderName: !user || user.toLowerCase() === "вільний" ? null : user,
      movedOn: dmyToIso(r[10]),
    });
  }
  return { items, skipped, header };
}

/**
 * Людина з таблиці → запис реєстру. Точний збіг ПІБ або однозначний збіг «прізвище + імʼя» (у
 * таблиці часто без по батькові). Двоє кандидатів — `null`: краще «не зіставлено», ніж чужа людина.
 */
export function matchEmployee(name: string, employees: readonly { id: number; fullName: string }[]): number | null {
  const norm = (s: string) => s.toLowerCase().replace(/[’'`ʼ]/g, "").replace(/\s+/g, " ").trim();
  const n = norm(name);
  const exact = employees.filter((e) => norm(e.fullName) === n);
  if (exact.length === 1) return exact[0].id;
  if (exact.length > 1) return null;
  const [a, b] = n.split(" ");
  if (!a || !b) return null;
  const two = employees.filter((e) => { const [x, y] = norm(e.fullName).split(" "); return x === a && y === b; });
  return two.length === 1 ? two[0].id : null;
}

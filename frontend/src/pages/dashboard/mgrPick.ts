/**
 * 👥 ВИБІР МЕНЕДЖЕРІВ У ЗВІТІ — «ЯК КОЛОНКИ, ТІЛЬКИ РЯДКИ» (задача 10752, ручний список правок Романа, 23.11.2026).
 *
 * Поруч із «Колонки · N з M» стоїть «Менеджери · N з M»: галочками обираєш, чиї рядки показати (таблиця й картки).
 * Чистий модуль без React: гейти бекенду виконують його функції, а не читають текст.
 *
 * 🔴 ЗБЕРІГАЄМО ПРИХОВАНИХ, А НЕ ОБРАНИХ. Вибір переживає перезавантаження (як колонки), тож список «обраних»
 * мовчки ховав би кожного НОВОГО менеджера: його id у збереженому списку немає, і він ніколи б не зʼявився. Список
 * «прихованих» має протилежну властивість — новий менеджер видно одразу, сховати його можна лише свідомо.
 *
 * 🔴 ВИБІР ОСОБИСТИЙ: ключ `rptHiddenMgrs:<userId>` — та сама причина, що в колонок (двоє за одним компʼютером
 * перемикали б одне одному). Без userId — спільний ключ `rptHiddenMgrs`.
 *
 * 🔴 ЗВУЖЕНИЙ СПИСОК МУСИТЬ ЧИТАТИСЬ ЯК ЗВУЖЕНИЙ: поки серед ПОКАЗАНИХ даних є прихований, підсумок таблиці
 * підписується «Обрані рядки», а не «Весь відділ» (`rowsScopeLabel`), і на панелі стоїть плашка з «×». Прихований,
 * якого в поточних даних немає (інша команда у фільтрі), список не звужує — і підпис це не стверджує.
 */

export const MGR_HIDDEN_LS = "rptHiddenMgrs";
/** Мінімальне сховище (localStorage або фікстура тесту). */
export interface PickStore { getItem(key: string): string | null; setItem(key: string, value: string): void }
export const mgrHiddenKey = (userId: number | null | undefined): string =>
  userId != null ? `${MGR_HIDDEN_LS}:${String(userId)}` : MGR_HIDDEN_LS;

/** Прочитати прихованих. Немає запису, зіпсований JSON, не масив, сміття всередині — «приховано нікого» (видно всіх). */
export function readHiddenMgrs(store: PickStore | null, userId: number | null | undefined): number[] {
  try {
    if (!store) return [];
    const raw: unknown = JSON.parse(store.getItem(mgrHiddenKey(userId)) || "null");
    if (!Array.isArray(raw)) return [];
    const out = new Set<number>();
    for (const v of raw) if (typeof v === "number" && Number.isInteger(v) && v > 0) out.add(v);
    return [...out];
  } catch {
    return [];
  }
}

/** Записати прихованих (лише свій ключ). `false` — сховище недоступне: вибір живе до перезавантаження. */
export function writeHiddenMgrs(store: PickStore | null, userId: number | null | undefined, ids: readonly number[]): boolean {
  try {
    if (!store) return false;
    store.setItem(mgrHiddenKey(userId), JSON.stringify([...new Set(ids)]));
    return true;
  } catch {
    return false;
  }
}

/** Рядки без прихованих. Порядок не змінюється; кого немає у списку прихованих — показано (і нових теж). */
export function pickManagers<T extends { managerId: number }>(rows: readonly T[], hidden: readonly number[]): T[] {
  if (hidden.length === 0) return [...rows];
  const h = new Set(hidden);
  return rows.filter((m) => !h.has(m.managerId));
}

/** Чи звужено ПОКАЗАНИЙ список: є хоч один прихований серед поточних даних. */
export function isPickNarrowed(rows: readonly { managerId: number }[], hidden: readonly number[]): boolean {
  if (hidden.length === 0) return false;
  const h = new Set(hidden);
  return rows.some((m) => h.has(m.managerId));
}

/** Підпис підсумкового рядка таблиці: будь-яке звуження рядків → «Обрані рядки»; інакше — як було. */
export function rowsScopeLabel(p: { role: string; statusFiltered: boolean; pickNarrowed: boolean }): string {
  if (p.statusFiltered || p.pickNarrowed) return "Обрані рядки";
  return p.role === "manager" ? "Команда" : "Весь відділ";
}

export interface PickGroup<T> { team: string; rows: T[] }
/** Групи для меню: за назвою команди (без команди — «Поза командами»), команди й люди — за абеткою. */
export function pickGroups<T extends { managerId: number; name: string; teamName: string | null }>(rows: readonly T[]): PickGroup<T>[] {
  const by = new Map<string, T[]>();
  for (const m of rows) {
    const t = m.teamName ?? "Поза командами";
    const arr = by.get(t);
    if (arr) arr.push(m); else by.set(t, [m]);
  }
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "uk"))
    .map(([team, rs]) => ({ team, rows: [...rs].sort((a, b) => a.name.localeCompare(b.name, "uk")) }));
}

/** Перемкнути набір людей: усі видимі → сховати їх; інакше → показати всіх (зняти з прихованих). */
export function toggleMany(hidden: readonly number[], ids: readonly number[]): number[] {
  const h = new Set(hidden);
  const allShown = ids.every((id) => !h.has(id));
  for (const id of ids) { if (allShown) h.add(id); else h.delete(id); }
  return [...h];
}

/**
 * 🗂 КАТЕГОРІЯ СПІВРОБІТНИКА (28.10.2026, ТЗ Івана: фільтр «Співробітників» і «Плинності» за категорією).
 *
 * Посада в картці — вільний текст (у 62 працюючих 18 написань: «віддалений» / «віддаленний менеджер», «teamlead» /
 * «тім-лід»), тож фільтр по ній розсипався б. Категорію рахує правило нижче; HR може поставити її вручну
 * (`employees.category`), і ручна завжди перемагає. Невпізнана посада — `null` («Без категорії»), а не
 * найближча здогадка: невідоме має бути видимим. Тримає #2960.
 *
 * ⚠️ Склад категорій — пропозиція, яку Іван ще не затвердив (питання 1 макета). Змінити — лише `EMP_CATEGORIES`
 * тут і дзеркало у `frontend/src/api.ts` (його звіряє #2960b).
 */
export const EMP_CATEGORIES = [
  ["manager", "Менеджери"],
  ["teamlead", "Тім-ліди"],
  ["leadgen", "Лідогенерація"],
  ["accounting", "Бухгалтерія"],
  ["finance", "Фінансист"],
  ["management", "Керівництво"],
  ["office", "Офіс і HR"],
  ["it", "IT"],
] as const;
export type EmpCategory = (typeof EMP_CATEGORIES)[number][0];
const KEYS = new Set<string>(EMP_CATEGORIES.map(([k]) => k));
export const isEmpCategory = (v: unknown): v is EmpCategory => typeof v === "string" && KEYS.has(v);

/**
 * Порядок перевірок — частина правила: «офіс-менеджер» і «HR-менеджер» — офіс, а не менеджери;
 * «керівник групи продажу» — тім-лід, а не керівництво.
 */
const RULES: [EmpCategory, RegExp][] = [
  ["teamlead", /т[іи]м[\s-]?л[іи]д|team[\s-]?lead|керівник групи/],
  ["leadgen", /л[іи]д[\s-]?о?ген|lead[\s-]?gen/],
  ["accounting", /бухгалт/],
  ["finance", /ф[іи]нанс/],
  ["it", /розробн|програміст|developer|devops|(^|[^a-zа-яіїєґ])(it|айті)([^a-zа-яіїєґ]|$)/],
  ["office", /(^|[^a-zа-яіїєґ])hr[dm]?([^a-zа-яіїєґ]|$)|рекрут|офіс|адміністратор|секретар/],
  ["management", /директор|(^|[^a-zа-яіїєґ])(сео|ceo)([^a-zа-яіїєґ]|$)|керівник|засновник|власник/],
  ["manager", /менеджер|(^|\s)мен(\s|$)|продаж|sales/],
];

export function categoryOf(position: string | null | undefined): EmpCategory | null {
  const p = (position ?? "").toLowerCase().replace(/[ʼ'’`]/g, "").trim();
  if (!p) return null;
  for (const [k, re] of RULES) if (re.test(p)) return k;
  return null;
}

/** Підсумкова категорія людини: ручна, якщо поставлена, інакше — за посадою. */
export const effectiveCategory = (manual: string | null | undefined, position: string | null | undefined): EmpCategory | null =>
  isEmpCategory(manual) ? manual : categoryOf(position);

/**
 * 🎯 КОМУ ЙДУТЬ ТЕНДЕРНІ УГОДИ І ЗАДАЧА «ЗВʼЯЗАТИСЯ» — ЧИСТІ ПРАВИЛА, БЕЗ ЖОДНОГО ІМПОРТУ (задача 8731; TOP Weekly 09.11.2026,
 * Сергій: «можливість на адміна без відповідального… або на вибраного… або по черзі між лідгенами й менеджерами»; відповіді Романа
 * 10.11.2026: по черзі — ПО ДНЯХ, вихідні продовжують чергу, «на адміна» = акаунт «Операційний директор», задачу тоді нікому,
 * задача закривається сама).
 *
 * Режими (`prozorro_settings.assign_mode`):
 *  • `opdir`    — усі угоди на акаунт Kommo «Операційний директор» (`OPDIR_KOMMO_USER_ID`), далі розбирають вручну; задачі немає;
 *  • `one`      — на одну вибрану людину (як до 10.11), лише лідоген;
 *  • `rotation` — по черзі ПО ДНЯХ: усі угоди одного київського дня — одній людині, наступного — наступній, по колу; календарні
 *                 дні, вихідні теж (джоба біжить щодня). Відлік — від `rotationFrom` (день, коли чергу задали): цього дня — перший.
 */

export type AssignMode = "opdir" | "one" | "rotation";
export const ASSIGN_MODES: readonly AssignMode[] = ["opdir", "one", "rotation"];
/** Акаунт Kommo «Операційний директор» (managers.id 2) — службовий, на нього падає все в режимі `opdir`. */
export const OPDIR_KOMMO_USER_ID = 904923;
export const ROTATION_MAX = 30;
/** «Комерційний відділ» (КВП, Левентова) — не менеджер, у чергу не йде (Роман 10.11.2026: «Левентову прибери»). */
export const KVP_DEPT_TEAM_ID = 37283;
/**
 * Хто може бути в черзі (Роман 10.11.2026: «тільки менеджери з акаунтом в Kommo + лідогенератори»): КОМЕРЦІЙНИЙ менеджер за
 * правилом ядра (`metrics.commercialManagerSql` — його передає роут: модуль без імпортів) або команда «Лідогенерація»; без КВП-відділу.
 * Без команди (Роман, «Операційний директор») і фінанси — ні. Аліас таблиці managers — `m`.
 */
export const rotationScopeSql = (commercialSql: string, leadgenTeamId: number): string =>
  `((${commercialSql}) OR m.team_id = ${Math.trunc(leadgenTeamId)}) AND m.team_id IS DISTINCT FROM ${KVP_DEPT_TEAM_ID}`;

const dayNum = (d: string): number => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) / 86_400_000;
export const addDays = (d: string, n: number): string => new Date((dayNum(d) + n) * 86_400_000).toISOString().slice(0, 10);

/** Чия черга в київський день `day`: індекс у `ids` від дня `from` по колу (до `from` — так само по колу назад). */
export function rotationPick(ids: readonly number[], from: string, day: string): number | null {
  if (!ids.length) return null;
  const k = Math.round(dayNum(day) - dayNum(from));
  return ids[((k % ids.length) + ids.length) % ids.length];
}

export type AssignTarget =
  | { kind: "opdir" }
  | { kind: "person"; managerId: number }
  | { kind: "none"; reason: string };

/** Кому віддати угоди дня `day` за налаштуваннями. Порожня черга / не вибрано — `none` з причиною (угоди чекають, як і раніше). */
export function assignTarget(c: { assignMode: AssignMode; responsibleManagerId: number | null; rotationIds: readonly number[]; rotationFrom: string | null },
  day: string): AssignTarget {
  if (c.assignMode === "opdir") return { kind: "opdir" };
  if (c.assignMode === "rotation") {
    const id = rotationPick(c.rotationIds, c.rotationFrom ?? day, day);
    return id == null ? { kind: "none", reason: "черга порожня — нікого не вибрано" } : { kind: "person", managerId: id };
  }
  return c.responsibleManagerId == null ? { kind: "none", reason: "лідоген не вибраний" } : { kind: "person", managerId: c.responsibleManagerId };
}

/** Задачу «звʼязатися» ставимо лише по угодах, створених ПІСЛЯ викату правила (старі 389 угод — без задач, рішення плану 10.11). */
export const CONTACT_TASKS_FROM = "2026-11-10T12:00:00Z";
export const CONTACT_TASK_DEPARTMENT = "Тендери Prozorro";

export function contactTaskTitle(companyName: string, amount: number | null): string {
  const sum = amount != null && Number.isFinite(amount) ? ` — тендер на ${Math.round(amount).toLocaleString("uk-UA").replace(/ /g, " ")} ₴` : " — тендер Prozorro";
  return `Зв'язатися: ${companyName}${sum}`;
}
export function contactTaskText(l: { companyName: string; contactName: string | null; phone: string | null; leadUrl: string }): string {
  return [`Нова угода з тендера Prozorro: ${l.companyName}.`, `Угода в Kommo: ${l.leadUrl}`,
    `Контакт: ${l.contactName ?? "не вказано"}${l.phone ? `, ${l.phone}` : ""}.`,
    "Задача закриється сама, щойно буде вихідний дзвінок на цей номер із розмовою довше 8 с."].join("\n");
}

/**
 * ☎️ ЗАДАЧА ЗАКРИВАЄТЬСЯ САМА: вихідний дзвінок на номер контакту угоди, розмова ДОВШЕ `minSec` (те саме «успішний дзвінок», що в
 * лідгенів: вихідний, розмова > 8 с), НЕ раніше за створення угоди. Вхідний чи короткий — ні.
 */
export function callClosesTask(call: { callType: string; billsec: number; at: number }, pushedAt: number, outbound: readonly string[], minSec: number): boolean {
  return outbound.includes(call.callType) && call.billsec > minSec && call.at >= pushedAt;
}
export const CONTACT_DONE_REASON = "Закрито автоматично: був вихідний дзвінок клієнту (розмова довше 8 с)";

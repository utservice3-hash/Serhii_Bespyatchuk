/**
 * 👥 ТІМЛІД І СЕЙФ СВОЄЇ КОМАНДИ — ЧИСТЕ ПРАВИЛО (29.09.2026, рішення Романа за погодженням Сергія:
 * «тімліду показувати дані своїх співробітників + всі паролі і пароль від дашборду»).
 *
 * Одна функція вирішує «чи цей тімлід бачить цю людину» для ВСІХ дверей: список, картка, код показу,
 * показ і скидання пароля. Список не має власного SQL-фільтра за роллю чи станом — він бере ширший
 * набір (та сама команда) і проганяє КОЖЕН рядок крізь `teamMemberVerdict`. Інакше правило жило б
 * двічі (у SQL і тут), і перша ж правка однієї копії мовчки розвела б список із показом.
 *
 * 🔴 КОМАНДА — З CRM, А НЕ З РЕЄСТРУ. `users.team_id` синк переписує з `managers.team_id` кожні 30 хв,
 * а `employees.team_label` — ручне поле, яке відстає (22.09 у Панасюка стояв '9' — команда Дарини —
 * через день після переходу до Дмитрука). Тому людей без акаунта тімлід не бачить: привʼязати їх до
 * команди нема за чим, і вгадувати за підписом ми не будемо.
 *
 * 🔴 КОМАНДУ ТІМЛІДА ЧИТАЄМО З БАЗИ, А НЕ З ТОКЕНА. Токен знає команду на момент входу: 29.09
 * Сердюка перевели в «Лідогенерацію», а його сесія ще годину казала «без команди». Для межі
 * доступу застарілий токен означав би або порожній екран, або — гірше — стару команду.
 */
export interface TeamActor { userId: number; role: string; teamId: number | null }
export interface TeamTarget {
  userId: number;
  /** Ефективна роль: `COALESCE(role_override, role)`. */
  role: string;
  teamId: number | null;
  /** `users.is_active` — вхід відкритий. */
  active: boolean;
  /** Стан менеджера «звільнений» (`manager_work_state`) — вхід закрито, людини в команді вже немає. */
  dismissed: boolean;
}

export type TeamVerdict = { ok: true } | { ok: false; reason: string };

export function teamMemberVerdict(a: TeamActor, t: TeamTarget | null): TeamVerdict {
  if (a.role !== "team_lead") return { ok: false, reason: "Лише для тімліда" };
  if (a.teamId == null) return { ok: false, reason: "У вас немає команди в CRM — попросіть адміністратора привʼязати" };
  if (!t) return { ok: false, reason: "Людину не знайдено" };
  if (t.userId === a.userId) return { ok: false, reason: "Свої доступи тут не показуються" };
  if (t.teamId !== a.teamId) return { ok: false, reason: "Людина не з вашої команди" };
  if (t.role !== "manager") return { ok: false, reason: "Лише менеджери вашої команди" };
  if (!t.active || t.dismissed) return { ok: false, reason: "Людина вже не працює" };
  return { ok: true };
}

/**
 * Що з сейфу видно тімліду: паролі до сервісів (включно з дашбордом). Банківські картки — ні:
 * це не доступ до роботи, а реквізити для виплат людині (рішення 29.09.2026).
 */
export const teamSecretVisible = (kind: string): boolean => kind === "password";

/** Сервіс пароля дашборда в сейфі — той самий ключ, що в `SECRET_SERVICES`. */
export const DASHBOARD_SERVICE = "dashboard";

/**
 * 🗄 ЖИТТЄВИЙ ЦИКЛ ОСОБИСТИХ ДОКУМЕНТІВ І ОФЕРІВ ЗА СТАНОМ ЛЮДИНИ — чисте правило без БД.
 *
 * Рішення власника (ТЗ ⑦ + 15.09.2026 вечір): «після звільнення офер і документи менеджера
 * переходять в архів»; «при поверненні повертаються всі документи з архіву, але зі статусом
 * неактивні, і їх можна активувати при потребі».
 *
 * Стан людини — ОДНЕ правило на всю систему, `stateOf` з `core/managerState.ts` (те саме, що
 * закриває вхід звільненим). Тут воно лише споживається:
 *  - `dismissed` + живий особистий/офер → в архів з причиною `dismissed`;
 *  - `active`/`finishing` + архівований ЧЕРЕЗ ЗВІЛЬНЕННЯ → повернути як «неактивний»;
 *  - ручний архів (`manual`) поверненням не скасовується — його робила людина свідомо;
 *  - `finishing` («завершує») ще працює — нічого не рушить;
 *  - загальні документи належать компанії, а не людині — не рушать НІКОЛИ (#444).
 */
import type { WorkState } from "./managerState.js";

export type LifecycleAction = "archive" | "return" | "none";

export interface LifecycleDoc {
  section: "general" | "personal" | "offer";
  archivedAt: Date | string | null;
  archivedReason: string | null;
}

export function lifecycleAction(state: WorkState, doc: LifecycleDoc): LifecycleAction {
  if (doc.section === "general") return "none";
  if (state === "dismissed") return doc.archivedAt == null ? "archive" : "none";
  // active | finishing
  if (doc.archivedAt != null && doc.archivedReason === "dismissed") return "return";
  return "none";
}

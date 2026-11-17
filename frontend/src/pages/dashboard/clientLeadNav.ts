/**
 * 🔙 «З КИМ ГОВОРИТИ» — РІВЕНЬ ЕКРАНА В АДРЕСІ (задача 9225, 17.11.2026).
 *
 * Тімлід відкривав менеджера і не міг повернутись до списку: дрібний ланцюжок над лічильниками на кнопку не
 * схожий, а вибір команди чи менеджера не писав нічого в адресу, тож «назад» браузера виводив з розділу.
 * Тепер команда й менеджер живуть у `?team=&mgr=`, і кожен перехід — окремий запис історії.
 *
 * Модуль без імпортів: його транспілює й ВИКОНУЄ гейт `#9225*`, а не читає очима.
 *
 * 🔴 АДРЕСА НЕ ДАЄ ПРАВ. Тімлід завжди бачить свою команду, хоч би що стояло в `team=`; менеджер — лише себе.
 * Дані ріже сервер, тут лише вибір рівня — але й рівень не має «відкривати» чужу команду навіть на вигляд.
 */

export type LeadNav = { team: number | null; mgr: number | null };

/** Ціле число з адреси; сміття, порожнє й дробове → null (рівень «список»). `-1` = «Без команди», тож мінус дозволено. */
function intParam(v: string | null): number | null {
  if (v == null || !/^-?\d{1,9}$/.test(v)) return null;
  return Number(v);
}

/** Рівень екрана з адреси з урахуванням ролі. */
export function readLeadNav(search: string, role: string, ownTeamId: number | null): LeadNav {
  if (role === "manager") return { team: null, mgr: null };
  const p = new URLSearchParams(search);
  const team = role === "team_lead" ? ownTeamId : intParam(p.get("team"));
  // Менеджер без команди не відкривається: у інтерфейсі до нього можна дійти лише через команду.
  const mgr = team == null ? null : intParam(p.get("mgr"));
  return { team, mgr };
}

/** Новий рядок запиту: `team`/`mgr` поставлено або прибрано, решта параметрів (`tab` тощо) лишається. */
export function leadNavSearch(search: string, nav: LeadNav): string {
  const p = new URLSearchParams(search);
  if (nav.team == null) p.delete("team"); else p.set("team", String(nav.team));
  if (nav.team == null || nav.mgr == null) p.delete("mgr"); else p.set("mgr", String(nav.mgr));
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** Куди веде кнопка «назад» на поточному рівні; null — кнопки немає (верхній рівень для цієї ролі). */
export function backTarget(nav: LeadNav, role: string): { label: string; nav: LeadNav } | null {
  if (role === "manager") return null;
  if (nav.mgr != null) return { label: "← Назад до списку менеджерів", nav: { team: nav.team, mgr: null } };
  if (nav.team != null && role !== "team_lead") return { label: "← Назад до списку команд", nav: { team: null, mgr: null } };
  return null;
}

/**
 * Чи кнопка «назад» на сторінці має зробити `history.back()`, а не новий запис. Так історія лишається лінійною:
 * інакше «← Назад» клав би ще один запис, і наступне «назад» браузера повертало б у щойно закритого менеджера.
 * `state` — `history.state` поточного запису; ми кладемо туди рівень, з якого прийшли (`from`).
 */
export function backIsHistoryBack(state: unknown, target: LeadNav): boolean {
  const from = (state as { lead9225?: { from?: LeadNav } } | null)?.lead9225?.from;
  return from != null && from.team === target.team && from.mgr === target.mgr;
}

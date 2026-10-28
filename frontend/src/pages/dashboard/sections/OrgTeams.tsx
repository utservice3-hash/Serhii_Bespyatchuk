import { useCallback, useEffect, useState } from "react";
import { fetchOrgTeams, createOrgTeam, updateOrgTeam, hiringError, type TeamsResp, type TeamOption } from "../../../api";
import type { Toast } from "../../../components/Toasts";
import { useDialogs } from "../../../components/Dialogs";
import "./hiring.css";
import "./org.css";

/**
 * 👥 КОМАНДИ: KOMMO + ВІДДІЛИ ДАШБОРДУ (рішення Романа 27.10.2026). Правила — `backend/src/core/teams.ts`.
 *  • «Продажі (Kommo)» — команди з Kommo; назви змінюють лише в Kommo.
 *  • «Відділи дашборду» — створюють тут (керівництво й HR, право `manage_teams`), у звіти продажів не потрапляють ніколи.
 *  • Відділ можна «зʼєднати» з командою Kommo — тоді його люди стоять у блоці тієї команди на орг-структурі.
 * Видалення немає: відділ архівується, і лише порожній.
 */

/** Варіанти для `<select>` з двома групами; значення — `k:<id>` / `d:<id>`. Архівні — лише якщо це поточний вибір. */
export function TeamOptions({ data, current }: { data: TeamsResp | null; current: string | null }) {
  if (!data) return current ? <option value={current}>…</option> : null;
  const dash = data.dashboard.filter((d) => !d.archived || d.key === current);
  return (
    <>
      <optgroup label="Продажі (Kommo)">
        {data.kommo.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}
      </optgroup>
      <optgroup label="Відділи дашборду">
        {dash.map((t) => <option key={t.key} value={t.key}>{t.name}{t.archived ? " (архів)" : ""}{t.linkedKommoName ? ` → ${t.linkedKommoName}` : ""}</option>)}
      </optgroup>
    </>
  );
}

export function useTeams(): [TeamsResp | null, () => void] {
  const [data, setData] = useState<TeamsResp | null>(null);
  const load = useCallback(() => { fetchOrgTeams().then(setData).catch(() => setData(null)); }, []);
  useEffect(load, [load]);
  return [data, load];
}

/** Картка «Відділи дашборду»: створити, перейменувати, зʼєднати з командою Kommo, архівувати / повернути. */
export function OrgTeamsCard({ toast, onChanged }: { toast: Toast; onChanged?: () => void }) {
  const [data, load] = useTeams();
  const dlg = useDialogs();
  const [name, setName] = useState("");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast(ok); load(); onChanged?.(); }
    catch (e) { toast(hiringError(e), { error: true }); }
    finally { setBusy(false); }
  };
  if (!data) return <p className="loading-text">Завантаження команд…</p>;
  const can = data.canManage;
  const live = data.dashboard.filter((d) => !d.archived);
  const archived = data.dashboard.filter((d) => d.archived);
  const rename = async (t: TeamOption) => {
    const v = await dlg.prompt(`Нова назва відділу «${t.name}»`, t.name);
    if (v && v !== t.name) void run(() => updateOrgTeam(t.id, { name: v }), `Відділ перейменовано: «${v}»`);
  };
  return (
    <div className="hr-card org-teams">
      <h3 style={{ margin: "0 0 4px" }}>Відділи дашборду</h3>
      <p className="hr-muted" style={{ margin: "0 0 10px", fontSize: 13 }}>
        Для людей поза продажами (IT, бухгалтерія, керівництво). У Звіт, КВП і плани не потрапляють. Команди продажів приходять із Kommo,
        і менеджера в іншу команду переводять у Kommo.
      </p>
      <div className="org-teams-tbl">
        <table className="org-list">
          <thead><tr><th>Відділ</th><th>Людей</th><th>Зʼєднано з Kommo</th>{can && <th />}</tr></thead>
          <tbody>
            {live.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td>{t.members}</td>
                <td>
                  {can ? (
                    <select className="hr-inp" value={t.linkedKommoId ?? ""} disabled={busy} aria-label={`Зʼєднати «${t.name}» з командою Kommo`}
                      onChange={(e) => void run(() => updateOrgTeam(t.id, { kommoTeamId: e.target.value ? Number(e.target.value) : null }),
                        e.target.value ? `«${t.name}» зʼєднано з командою Kommo` : `«${t.name}» відʼєднано від Kommo`)}>
                      <option value="">— окремо</option>
                      {data.kommo.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
                    </select>
                  ) : t.linkedKommoName ?? "—"}
                </td>
                {can && (
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button className="hr-btn xs" disabled={busy} onClick={() => void rename(t)}>Перейменувати</button>{" "}
                    <button className="hr-btn xs" disabled={busy || t.members > 0} title={t.members ? "Спершу переведіть людей в інший відділ" : undefined}
                      onClick={() => void run(() => updateOrgTeam(t.id, { archived: true }), `«${t.name}» в архіві`)}>В архів</button>
                  </td>
                )}
              </tr>
            ))}
            {!live.length && <tr><td colSpan={can ? 4 : 3} className="hr-muted">Відділів ще немає.</td></tr>}
          </tbody>
        </table>
      </div>
      {can && (
        <div className="org-teams-new">
          <input id="org-team-new" className="hr-inp" placeholder="Новий відділ, напр. «IT відділ»" value={name} onChange={(e) => setName(e.target.value)} aria-label="Назва нового відділу" />
          <select className="hr-inp" value={link} onChange={(e) => setLink(e.target.value)} aria-label="Зʼєднати з командою Kommo">
            <option value="">окремо від Kommo</option>
            {data.kommo.map((k) => <option key={k.id} value={k.id}>зʼєднати з «{k.name}»</option>)}
          </select>
          <button className="hr-btn p" disabled={busy || !name.trim()}
            onClick={() => void run(async () => { await createOrgTeam({ name: name.trim(), kommoTeamId: link ? Number(link) : null }); setName(""); setLink(""); },
              `Відділ «${name.trim()}» створено`)}>+ Відділ</button>
        </div>
      )}
      {archived.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <button className="hr-btn xs" onClick={() => setShowArchived((x) => !x)}>{showArchived ? "Сховати архів" : `Архів · ${archived.length}`}</button>
          {showArchived && (
            <ul className="org-teams-arch">
              {archived.map((t) => (
                <li key={t.id}>{t.name}{can && <> <button className="hr-btn xs" disabled={busy}
                  onClick={() => void run(() => updateOrgTeam(t.id, { archived: false }), `«${t.name}» повернуто з архіву`)}>Повернути</button></>}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

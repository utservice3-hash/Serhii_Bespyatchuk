import { useCallback, useEffect, useState } from "react";
import {
  fetchNominationWeek, reviewNomination,
  type NominationWeek, type NominationTeam, type NominationCell, type NominationKey,
} from "../../../api";
import { formatAmountFull } from "../format";
import "./nominations.css";

/**
 * 🏆 НОМІНАЦІЇ ТИЖНЯ (21.09.2026). Замінює ручний збір у чаті «Керівники»: доти кожен тімлід писав
 * Даші переможців своєї команди власним способом, а вона збирала з цього презентацію.
 *
 * Тепер переможців рахує ядро «як на Звіті» (гроші — «Факт», авто — «Авто»), тімлід лише
 * підтверджує або виправляє з причиною, у вівторок 08:00 тиждень фіксується. Хто що може —
 * вирішує СЕРВЕР (`canReview` у кожній клітинці); тут лише показ.
 *
 * 🔴 Число CRM не ховається ніколи: виправлене показується поруч із закресленим числом CRM.
 */

const addDays = (ymd: string, n: number): string => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dm = (ymd: string) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}`;
const DEPT_LABEL = { rnk: "ВРНК — нові клієнти", rpk: "ВРПК — постійні клієнти" } as const;

function fmt(unit: "uah" | "count" | "pct", v: number | null): string {
  if (v == null) return "—";
  if (unit === "uah") return formatAmountFull(v);
  if (unit === "pct") return `${Math.round(v)}%`;
  return String(v);
}

function errorOf(e: unknown): string {
  const r = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
  return r ?? "Не вдалося завантажити — спробуйте ще раз";
}

type Target = { team: NominationTeam; cell: NominationCell };

export function NominationsSection() {
  const [week, setWeek] = useState<string | undefined>(undefined);
  const [data, setData] = useState<NominationWeek | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<Target | null>(null);

  const load = useCallback((w?: string) => {
    setErr(null);
    fetchNominationWeek(w).then((d) => { setData(d); setWeek(d.weekFrom); }).catch((e) => setErr(errorOf(e)));
  }, []);
  useEffect(() => { load(undefined); }, [load]);

  const act = async (t: Target, action: "confirm") => {
    if (!data) return;
    setBusy(true); setErr(null);
    try { setData(await reviewNomination({ weekFrom: data.weekFrom, teamId: t.team.teamId, nomination: t.cell.nomination, action })); }
    catch (e) { setErr(errorOf(e)); }
    finally { setBusy(false); }
  };

  if (!data) return <div className="chart-card">{err ? <div className="nm-err">{err}</div> : <div className="loading-text">Рахуємо номінації…</div>}</div>;

  const def = (k: NominationKey) => data.defs.find((d) => d.key === k)!;
  const name = (id: number) => data.names[String(id)] ?? `Менеджер #${id}`;
  const names = (ids: number[]) => ids.map(name).join(", ");
  const isLead = data.viewer.role === "team_lead";
  const reviewable = data.teams.flatMap((t) => t.cells.filter((c) => c.canReview || c.final.status === "confirmed" || c.final.status === "overridden"));
  const done = reviewable.filter((c) => c.final.status === "confirmed" || c.final.status === "overridden").length;

  const statePill = data.state === "frozen"
    ? <span className="nm-pill ok">Зафіксовано {data.frozenAt ? new Date(data.frozenAt).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : ""}</span>
    : <span className="nm-pill draft">Чернетка · фіксація {dm(data.freezeDueAt.slice(0, 10))} о 08:00</span>;

  const statusPill = (c: NominationCell) => {
    if (c.final.status === "confirmed") return <span className="nm-pill ok">✓ підтверджено</span>;
    if (c.final.status === "overridden") return <span className="nm-pill fix">виправлено</span>;
    if (c.final.status === "empty") return <span className="nm-pill wait">ніхто не набрав</span>;
    return <span className="nm-pill wait">{c.final.stale ? "CRM змінився — підтвердьте знову" : "очікує"}</span>;
  };

  /** Число й переможці — фінальні; якщо виправлено, під ними закреслене число CRM і причина. */
  const valueBlock = (c: NominationCell) => {
    const d = def(c.nomination);
    const crmText = c.crm.state === "ok" ? `${names(c.crm.winners)} · ${fmt(d.unit, c.crm.value)}` : "ніхто не набрав";
    return (
      <div className="nm-cell">
        {c.final.status === "empty"
          ? <span className="nm-muted">ніхто не набрав</span>
          : <>
              <span className="nm-who">{names(c.final.winners)}{c.final.winners.length > 1 ? <span className="nm-muted"> · нічия</span> : null}</span>
              <span className="nm-num">{fmt(d.unit, c.final.value)}
                {c.nomination === "marginPct" && (c.final.value ?? 0) > data.marginFlagPct ? <> <span className="nm-pill flag">⚑ понад {data.marginFlagPct}%</span></> : null}
              </span>
            </>}
        {c.nomination === "marginPct" && c.deal?.price != null && c.deal.cost != null && c.final.status !== "overridden"
          ? <span className="nm-muted">угода: маржа {formatAmountFull(c.deal.price)} / водію {formatAmountFull(c.deal.cost)}</span> : null}
        {c.final.status === "overridden" ? <>
          <span className="nm-strike">CRM: {crmText}</span>
          <span className="nm-muted">«{c.final.reason}»</span>
        </> : null}
      </div>
    );
  };

  const actions = (team: NominationTeam, c: NominationCell) => {
    if (data.state === "frozen") return null;
    if (!c.canReview) return c.whyNot ? <div className="nm-muted">{c.whyNot}</div> : null;
    return (
      <div className="nm-btns">
        {c.final.status !== "confirmed" && c.crm.state === "ok"
          ? <button className="nm-btn p" disabled={busy} onClick={() => act({ team, cell: c }, "confirm")}>Підтвердити</button> : null}
        <button className="nm-btn" disabled={busy} onClick={() => setEdit({ team, cell: c })}>{c.final.status === "overridden" ? "Змінити" : "Виправити"}</button>
      </div>
    );
  };

  const header = (
    <div className="nm-head">
      <h2>Номінації тижня{isLead && data.teams[0] ? ` · ${data.teams[0].teamName}` : ""}</h2>
      <div className="nm-period">
        <button className="nm-nav" aria-label="попередній тиждень" onClick={() => week && load(addDays(week, -7))}>‹</button>
        <span className="nm-week">{dm(data.weekFrom)}–{dm(data.weekTo)}.{data.weekTo.slice(0, 4)}</span>
        <button className="nm-nav" aria-label="наступний тиждень" onClick={() => week && load(addDays(week, 7))}>›</button>
        {statePill}
      </div>
    </div>
  );

  const banner = (
    <div className="nm-card nm-banner">
      <span>Підтверджено <b>{done} з {reviewable.length}</b></span>
      <span className="nm-muted">Числа — з CRM, як на Звіті: гроші — «Факт» (оплата отримана + успішно реалізовано), авто — «Авто» (дата завантаження), тиждень пн–нд за Києвом.
        {data.state === "draft" ? " Непідтверджене зафіксується як є." : ""}</span>
      {err ? <span className="nm-err">{err}</span> : null}
    </div>
  );

  const noCost = data.teams.reduce((a, t) => a + t.noCostDeals, 0);

  return (
    <div>
      {header}
      {banner}
      {data.teams.length === 0 ? <div className="nm-card nm-banner nm-muted">Немає команд у заліку за цей тиждень.</div> : null}

      {isLead ? data.teams.map((t) => (
        <div className="nm-card nm-scroll" key={t.teamId}>
          <table className="nm-table">
            <thead><tr><th>Номінація</th><th>Переможець</th><th>Стан</th><th /></tr></thead>
            <tbody>
              {t.cells.map((c) => (
                <tr key={c.nomination}>
                  <td>{def(c.nomination).label}<div className="nm-muted">{def(c.nomination).hint}</div></td>
                  <td>{valueBlock(c)}</td>
                  <td>{statusPill(c)}</td>
                  <td>{actions(t, c)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )) : (
        <div className="nm-card nm-scroll">
          <table className="nm-table">
            <thead><tr><th>Команда</th>{data.defs.map((d) => <th key={d.key} title={d.hint}>{d.label.replace(/^Найбільш(ий|а) /, "")}</th>)}</tr></thead>
            <tbody>
              {(["rnk", "rpk"] as const).map((dept) => {
                const teams = data.teams.filter((t) => t.dept === dept);
                if (teams.length === 0) return null;
                return [
                  <tr className="dept" key={`${dept}-h`}><td colSpan={data.defs.length + 1}>{DEPT_LABEL[dept]}</td></tr>,
                  ...teams.map((t) => (
                    <tr key={t.teamId}>
                      <td><div className="nm-who">{t.teamName}</div></td>
                      {t.cells.map((c) => <td key={c.nomination}>{valueBlock(c)}<div style={{ marginTop: 4 }}>{statusPill(c)}</div>{actions(t, c)}</td>)}
                    </tr>
                  )),
                  <tr className="win" key={`${dept}-w`}>
                    <td><b>🏆 Переможець {dept === "rnk" ? "ВРНК" : "ВРПК"}</b></td>
                    {data.defs.map((d) => {
                      const w = data.depts.find((x) => x.dept === dept && x.nomination === d.key);
                      return <td key={d.key}>{w && w.state === "ok" ? <b>{names(w.winners)} · {fmt(d.unit, w.value)}</b> : <span className="nm-muted">ніхто не набрав</span>}</td>;
                    })}
                  </tr>,
                ];
              })}
            </tbody>
          </table>
        </div>
      )}

      {noCost > 0 ? <p className="nm-muted">⚠ «% маржі» не рахується для угод без «Расходу 1» (виплати водію): {noCost} угод{isLead ? " команди" : ""} цього тижня без нього.</p> : null}

      {edit ? <OverrideDialog data={data} target={edit} onClose={() => setEdit(null)} onSaved={(d) => { setData(d); setEdit(null); }} /> : null}
    </div>
  );
}

function OverrideDialog({ data, target, onClose, onSaved }: { data: NominationWeek; target: Target; onClose: () => void; onSaved: (d: NominationWeek) => void }) {
  const d = data.defs.find((x) => x.key === target.cell.nomination)!;
  const crm = target.cell.crm;
  const [ids, setIds] = useState<number[]>(target.cell.final.status === "overridden" ? target.cell.final.winners : crm.state === "ok" ? crm.winners : []);
  const [value, setValue] = useState<string>(target.cell.final.value != null ? String(target.cell.final.value) : "");
  const [reason, setReason] = useState<string>(target.cell.final.reason ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const name = (id: number) => data.names[String(id)] ?? `Менеджер #${id}`;

  const save = async () => {
    if (reason.trim().length < 3) return setErr("Вкажіть причину — без неї виправлення не зберігається.");
    setBusy(true); setErr(null);
    try {
      onSaved(await reviewNomination({ weekFrom: data.weekFrom, teamId: target.team.teamId, nomination: target.cell.nomination, action: "override", overrideManagerIds: ids, overrideValue: Number(value.replace(",", ".")), reason: reason.trim() }));
    } catch (e) { setErr(errorOf(e)); setBusy(false); }
  };

  return (
    <div className="nm-modal-back" onClick={onClose}>
      <div className="nm-modal" role="dialog" aria-labelledby="nm-dh" onClick={(e) => e.stopPropagation()}>
        <h3 id="nm-dh">Виправити: «{d.label}» · {target.team.teamName}</h3>
        <div className="nm-crm">За CRM: <b>{crm.state === "ok" ? `${crm.winners.map(name).join(", ")} — ${fmt(d.unit, crm.value)}` : "ніхто не набрав"}</b>
          <div className="nm-muted">{d.hint}, тиждень {dm(data.weekFrom)}–{dm(data.weekTo)}</div></div>
        <div className="nm-field"><span>Переможець (при нічиї — кілька)</span>
          <div className="nm-checks">
            {target.team.members.map((m) => (
              <label key={m.id}><input type="checkbox" id={`nm-m-${m.id}`} checked={ids.includes(m.id)}
                onChange={(e) => setIds((cur) => e.target.checked ? [...cur, m.id] : cur.filter((x) => x !== m.id))} /> {m.name}</label>
            ))}
          </div>
        </div>
        <label className="nm-field"><span>Число{d.unit === "uah" ? ", ₴" : d.unit === "pct" ? ", %" : ""}</span>
          <input className="nm-inp" id="nm-value" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} /></label>
        <label className="nm-field"><span>Причина *</span>
          <textarea className="nm-inp" id="nm-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Чому число відрізняється від CRM" />
          <span className="nm-muted">Причину й число CRM побачить керівництво — вони лишаються поруч і в знімку.</span></label>
        {err ? <div className="nm-err">{err}</div> : null}
        <div className="nm-btns" style={{ justifyContent: "flex-end" }}>
          <button className="nm-btn" onClick={onClose}>Скасувати</button>
          <button className="nm-btn p" disabled={busy || ids.length === 0 || !value} onClick={save}>Зберегти виправлення</button>
        </div>
      </div>
    </div>
  );
}

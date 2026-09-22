import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchNominationWeek, reviewNomination, confirmNominationsBulk, fetchDayItems,
  fetchManualSlides, createManualSlide, updateManualSlide, deleteManualSlide, restoreManualSlide, fetchPeoplePhotos,
  type NominationWeek, type NominationTeam, type NominationCell, type NominationKey, type ManualSlidesResp, type ManualSlide, type ManualSlideKind, type PersonPhoto,
  type DayItems,
} from "../../../api";
import { EmployeePhoto } from "./EmployeePhotos";
import { NominationsPresentation } from "./NominationsPresentation";
import { formatAmountFull } from "../format";
import {
  parseWeekParam, parseAmount, countdown, groupCells, teamProgress, frozenSummary, ownDataHint, DRILL_KIND, fmtValue, leadsMessage, isAbout,
} from "../nominationsView";
import "./nominations.css";

/**
 * 🏆 НОМІНАЦІЇ ТИЖНЯ (21.09.2026; зручна версія — 22.09.2026). Замінює ручний збір у чаті «Керівники».
 *
 * Модель (затверджено Романом 22.09): система ПРОПОНУЄ переможця з CRM «як на Звіті», тімлід натискає
 * «Погоджуюсь» або вводить «Свої дані» (хто, число, звідки воно); рядок, де переможець — сам тімлід,
 * вирішує керівництво. Кожне рішення скасовне до фіксації (вт 08:00). Хто що може — вирішує СЕРВЕР
 * (`canReview` у кожній клітинці); логіка груп, відліку й повідомлення — `../nominationsView.ts` (гейти #650-#651).
 *
 * 🔴 Пропозиція системи не ховається ніколи: «свої дані» показуються поруч із закресленою пропозицією.
 */

const addDays = (ymd: string, n: number): string => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dm = (ymd: string) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}`;
const kyivDateOf = (ms: number) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
const mondayOf = (ymd: string) => { const dow = new Date(`${ymd}T12:00:00Z`).getUTCDay(); return addDays(ymd, -((dow + 6) % 7)); };
const whenText = (iso: string) => new Date(iso).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const DEPT_LABEL = { rnk: "ВРНК — нові клієнти", rpk: "ВРПК — постійні клієнти" } as const;

function errorOf(e: unknown): string {
  const r = (e as { response?: { data?: { error?: string }; status?: number } })?.response;
  return r?.data?.error ?? "Не вдалося — спробуйте ще раз";
}

type Drill = { managerId: number; name: string; nomination: NominationKey; kind: "received" | "dispatched"; value: number | null; unit: "uah" | "count" | "pct" };

export function NominationsSection() {
  const firstWeek = useMemo(() => parseWeekParam(window.location.search) ?? undefined, []);
  const [data, setData] = useState<NominationWeek | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [show, setShow] = useState(false);
  const [openTeam, setOpenTeam] = useState<number | null>(null);
  const [drill, setDrill] = useState<Drill | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState<"ok" | string | null>(null);
  const req = useRef(0);

  const load = useCallback((w?: string) => {
    const id = ++req.current;
    setLoading(true); setErr(null); setDrill(null);
    fetchNominationWeek(w).then((d) => {
      if (id !== req.current) return; // запізніла відповідь попереднього тижня
      setData(d);
      // Посилання з ?week= відкриває саме цей тиждень; пишемо його назад, щоб копія адреси теж вела сюди.
      const u = new URL(window.location.href);
      u.searchParams.set("week", d.weekFrom);
      window.history.replaceState(window.history.state, "", u.pathname + u.search + u.hash);
    }).catch((e) => { if (id === req.current) setErr(errorOf(e)); })
      .finally(() => { if (id === req.current) setLoading(false); });
  }, []);
  useEffect(() => { load(firstWeek); }, [load, firstWeek]);
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 60_000); return () => window.clearInterval(t); }, []);

  if (!data) {
    return (
      <div className="chart-card">
        {err ? <div className="nm-err">{err} <button className="nm-btn" onClick={() => load(firstWeek)}>Спробувати ще раз</button></div>
          : <div className="loading-text">Рахуємо номінації…</div>}
      </div>
    );
  }

  const isLead = data.viewer.role === "team_lead";
  const frozen = data.state === "frozen";
  const currentMonday = mondayOf(kyivDateOf(now));
  const ongoing = data.weekFrom >= currentMonday; // тиждень ще триває — числа зміняться
  const cd = countdown(data.freezeInstant, now);
  const leadTeam = isLead ? data.teams[0] ?? null : null;
  const shownTeam = isLead ? leadTeam : data.teams.find((t) => t.teamId === openTeam) ?? null;

  const copyMessage = async () => {
    const text = leadsMessage(data, window.location.origin);
    try { await navigator.clipboard.writeText(text); setCopied("ok"); }
    catch { setCopied(text); } // буфер недоступний — показуємо текст, щоб скопіювати руками
    window.setTimeout(() => setCopied((c) => (c === "ok" ? null : c)), 4000);
  };

  const statePill = frozen
    ? <span className="nm-pill ok">Зафіксовано {data.frozenAt ? whenText(data.frozenAt) : ""}</span>
    : ongoing
      ? <span className="nm-pill wait">Тиждень ще триває — числа зміняться до неділі</span>
      : <span className={`nm-pill ${cd.level === "danger" || cd.level === "past" ? "danger" : "draft"}`}>
          {cd.level === "past" ? `Фіксація вт ${dm(data.freezeDueAt.slice(0, 10))} — ось-ось` : `Перевірте до вт ${dm(data.freezeDueAt.slice(0, 10))}, 08:00 · лишилось ${cd.text}`}
        </span>;

  const header = (
    <div className="nm-head">
      <div>
        <h2>Номінації тижня</h2>
        {isLead && leadTeam ? <div className="nm-muted nm-sub">{leadTeam.teamName}</div> : null}
      </div>
      <div className="nm-period">
        <button className="nm-nav" aria-label="попередній тиждень" disabled={loading} onClick={() => load(addDays(data.weekFrom, -7))}>‹</button>
        <span className="nm-week">{dm(data.weekFrom)}–{dm(data.weekTo)}.{data.weekTo.slice(0, 4)}</span>
        <button className="nm-nav" aria-label="наступний тиждень" disabled={loading || ongoing} onClick={() => load(addDays(data.weekFrom, 7))}>›</button>
        {statePill}
        {loading ? <span className="nm-muted">Завантаження…</span> : null}
      </div>
      {!isLead ? (
        <div className="nm-head-actions">
          {!frozen ? <button className="nm-btn lg" onClick={() => void copyMessage()}>{copied === "ok" ? "Скопійовано ✓" : "Скопіювати повідомлення для тімлідів"}</button> : null}
          <button className="nm-btn lg p" onClick={() => setShow(true)}>Відкрити презентацію</button>
        </div>
      ) : null}
    </div>
  );

  const fs = frozen ? frozenSummary(data.teams) : null;
  const drillPanel = drill ? <DealsPanel drill={drill} week={data} onClose={() => setDrill(null)} /> : null;

  return (
    <div>
      {header}
      {err ? <div className="nm-card nm-banner"><span className="nm-err">{err}</span></div> : null}
      {copied && copied !== "ok" ? (
        <div className="nm-card nm-banner"><span>Буфер обміну недоступний — скопіюйте текст вручну:</span>
          <textarea className="nm-inp" readOnly value={copied} rows={5} onFocus={(e) => e.currentTarget.select()} />
          <button className="nm-btn" onClick={() => setCopied(null)}>Закрити</button></div>
      ) : null}
      {fs ? <div className="nm-card nm-banner">Тиждень зафіксовано{data.frozenAt ? ` ${whenText(data.frozenAt)}` : ""}: погоджено <b>{fs.confirmed}</b>, свої дані — <b>{fs.own}</b>, без рішення — <b>{fs.noDecision}</b> (пішла пропозиція системи). Змінити вже не можна.</div> : null}

      <div className={`nm-layout${drill ? " with-aside" : ""}`}>
        <div className="nm-main">
          {isLead ? (
            leadTeam
              ? <TeamBoard week={data} team={leadTeam} mode="lead" onData={setData} onDrill={setDrill} />
              : <div className="nm-card nm-banner nm-muted">Вашої команди в номінаціях цього тижня немає — у залік потрапляють команди з планом, як на Звіті.</div>
          ) : shownTeam ? (
            <>
              <button className="nm-btn" style={{ marginBottom: 10 }} onClick={() => { setOpenTeam(null); setDrill(null); }}>← Усі команди</button>
              <TeamBoard week={data} team={shownTeam} mode="admin" onData={setData} onDrill={setDrill} />
            </>
          ) : (
            <AdminOverview week={data} onOpen={(id) => { setOpenTeam(id); setDrill(null); }} />
          )}
          {data.teams.some((t) => t.noCostDeals > 0) ? (
            <p className="nm-muted">⚠ «% маржі» не рахується для угод без «Расходу 1» (виплати водію): {data.teams.reduce((a, t) => a + t.noCostDeals, 0)} угод{isLead ? " команди" : ""} цього тижня без нього.</p>
          ) : null}
          {!isLead && !shownTeam ? <ManualSlidesCard weekFrom={data.weekFrom} /> : null}
        </div>
        {drillPanel ? <><div className="nm-aside-back" onClick={() => setDrill(null)} />{drillPanel}</> : null}
      </div>

      {show ? <NominationsPresentation week={data} onClose={() => setShow(false)} /> : null}
    </div>
  );
}

/* ─────────────────────────── Огляд керівництва ─────────────────────────── */

function AdminOverview({ week, onOpen }: { week: NominationWeek; onOpen: (teamId: number) => void }) {
  const name = (id: number) => week.names[String(id)] ?? `Менеджер #${id}`;
  const short = (id: number) => name(id).split(/\s+/)[0];
  const rows = week.teams.map((t) => ({ t, p: teamProgress(t) }))
    .sort((a, b) => a.p.done / Math.max(1, a.p.total) - b.p.done / Math.max(1, b.p.total) || a.t.teamName.localeCompare(b.t.teamName, "uk"));
  const done = rows.reduce((a, r) => a + r.p.done, 0), total = rows.reduce((a, r) => a + r.p.total, 0);
  const lbl = (k: NominationKey) => (week.defs.find((d) => d.key === k)?.label ?? k).replace(/^Найбільш(ий|а) (к-сть )?/, "");
  const frozen = week.state === "frozen";
  return (
    <>
      {week.teams.length === 0 ? <div className="nm-card nm-banner nm-muted">Немає команд у заліку за цей тиждень.</div> : null}
      {!frozen && week.teams.length > 0 ? (
        <div className="nm-card">
          <div className="nm-card-h"><b>Хто вже перевірив свою команду</b><span className="nm-muted">Вирішено {done} з {total} · найменш готові — зверху · натисніть рядок, щоб відкрити картки команди</span></div>
          <div className="nm-progress-list">
            {rows.map(({ t, p }) => (
              <button key={t.teamId} className="nm-prog-row" onClick={() => onOpen(t.teamId)}>
                <span className="nm-prog-team"><b>{t.teamName}</b><span className="nm-muted">{t.leads.length ? t.leads.map((l) => l.name).join(", ") : "тімліда в дашборді немає"}</span></span>
                <span className="nm-bar" aria-hidden="true"><span style={{ width: `${p.total ? Math.round((p.done / p.total) * 100) : 0}%` }} /></span>
                <span className="nm-prog-n">{p.done} з {p.total}</span>
                <span className="nm-prog-wait">
                  {p.waitLead.length === 0 && p.waitBoss.length === 0 ? <span className="nm-pill ok">готово</span> : null}
                  {p.waitLead.length ? <span>{p.waitLead.map(lbl).join(", ")}</span> : null}
                  {p.waitBoss.length ? <span className="nm-warn-t">{p.waitLead.length ? " · " : ""}{p.waitBoss.map(lbl).join(", ")} — про тімліда, за вами</span> : null}
                </span>
                <span className="nm-muted nm-prog-at">{p.lastAt ? `остання дія ${whenText(p.lastAt)}` : "рішень ще немає"}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div className="nm-card nm-scroll">
        <table className="nm-table">
          <thead><tr><th>Команда</th>{week.defs.map((d) => <th key={d.key} title={d.hint}>{lbl(d.key)}</th>)}</tr></thead>
          <tbody>
            {(["rnk", "rpk"] as const).map((dept) => {
              const teams = week.teams.filter((t) => t.dept === dept);
              if (teams.length === 0) return null;
              return [
                <tr className="dept" key={`${dept}-h`}><td colSpan={week.defs.length + 1}>{DEPT_LABEL[dept]}</td></tr>,
                ...teams.map((t) => (
                  <tr key={t.teamId}>
                    <td><button className="nm-link" onClick={() => onOpen(t.teamId)}>{t.teamName}</button></td>
                    {t.cells.map((c) => {
                      const d = week.defs.find((x) => x.key === c.nomination)!;
                      const about = isAbout(c, t.leads.map((l) => l.managerId));
                      return (
                        <td key={c.nomination}>
                          {c.final.status === "empty" ? <span className="nm-muted">ніхто не набрав</span>
                            : <><span className="nm-name">{c.final.winners.map(short).join(", ")}</span> · <span className="nm-num">{fmtValue(d.unit, c.final.value)}</span></>}
                          {" "}{c.final.status === "confirmed" ? <span className="nm-pill ok">✓</span>
                            : c.final.status === "overridden" ? <span className="nm-pill fix">свої дані</span>
                            : c.final.status === "unconfirmed" && about && !frozen ? <span className="nm-pill draft">за вами</span> : null}
                          {c.nomination === "marginPct" && (c.final.value ?? 0) > week.marginFlagPct ? <span className="nm-pill danger">понад {week.marginFlagPct}%</span> : null}
                        </td>
                      );
                    })}
                  </tr>
                )),
                <tr className="win" key={`${dept}-w`}>
                  <td><b>🏆 Переможець {dept === "rnk" ? "ВРНК" : "ВРПК"}</b></td>
                  {week.defs.map((d) => {
                    const w = week.depts.find((x) => x.dept === dept && x.nomination === d.key);
                    return <td key={d.key}>{w && w.state === "ok" ? <b>{w.winners.map(name).join(", ")} · {fmtValue(d.unit, w.value)}</b> : <span className="nm-muted">ніхто не набрав</span>}</td>;
                  })}
                </tr>,
              ];
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ─────────────────────────── Картки команди (тімлід і керівництво) ─────────────────────────── */

function TeamBoard({ week, team, mode, onData, onDrill }: {
  week: NominationWeek; team: NominationTeam; mode: "lead" | "admin";
  onData: (d: NominationWeek) => void; onDrill: (d: Drill) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<NominationKey | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const frozen = week.state === "frozen";
  const aboutIds = mode === "lead" ? [week.viewer.managerId] : team.leads.map((l) => l.managerId);
  const g = groupCells(team.cells, aboutIds);
  const bulkable = g.pending.filter((c) => c.canReview && c.crm.state === "ok");

  const run = async (key: string, fn: () => Promise<NominationWeek>, ok?: string) => {
    setBusy(key); setErrs((e) => ({ ...e, [key]: "" }));
    try { const d = await fn(); onData(d); setEditing(null); if (ok) { setNote(ok); window.setTimeout(() => setNote(null), 4000); } }
    catch (e) { setErrs((x) => ({ ...x, [key]: errorOf(e) })); }
    finally { setBusy(null); }
  };
  const act = (c: NominationCell, action: "confirm" | "retract") =>
    run(c.nomination, () => reviewNomination({ weekFrom: week.weekFrom, teamId: team.teamId, nomination: c.nomination, action }));
  const saveOwn = (c: NominationCell, ids: number[], value: number, reason: string) =>
    run(c.nomination, () => reviewNomination({ weekFrom: week.weekFrom, teamId: team.teamId, nomination: c.nomination, action: "override", overrideManagerIds: ids, overrideValue: value, reason }));
  const bulk = () => run("bulk", () => confirmNominationsBulk({ weekFrom: week.weekFrom, teamId: team.teamId, nominations: bulkable.map((c) => c.nomination) }),
    `Погоджено: ${bulkable.length}. Кожне можна скасувати до фіксації.`);

  const card = (c: NominationCell, about: boolean) => (
    <NomCard key={c.nomination} week={week} team={team} cell={c} mode={mode} about={about}
      busy={busy === c.nomination || busy === "bulk"} err={errs[c.nomination] || null}
      editing={editing === c.nomination} onEdit={(on) => setEditing(on ? c.nomination : null)}
      onConfirm={() => void act(c, "confirm")} onRetract={() => void act(c, "retract")}
      onSaveOwn={(ids, v, r) => void saveOwn(c, ids, v, r)} onDrill={onDrill} />
  );
  const reviewed = g.pending.length + g.done.length;
  const aboutLabel = mode === "lead" ? "Про вас — вирішує керівництво" : "Про тімліда — вирішуєте ви";

  return (
    <div className="nm-board">
      {mode === "lead" && !frozen ? (
        <div className="nm-card nm-intro">
          <span>Система вже порахувала переможців з CRM — так само, як на Звіті. Погодьтеся з пропозицією або введіть <b>свої дані</b>: хто переміг, число і звідки воно. Де ви нічого не обрали, до фіксації піде пропозиція системи.</span>
          <div className="nm-intro-prog">
            <div className="nm-prog-line"><span>Опрацьовано <b>{g.done.length} з {reviewed}</b></span>{g.about.length ? <span className="nm-muted">ще {g.about.length} — про вас</span> : null}</div>
            <span className="nm-bar" aria-hidden="true"><span style={{ width: `${reviewed ? Math.round((g.done.length / reviewed) * 100) : 0}%` }} /></span>
          </div>
        </div>
      ) : null}
      {mode === "admin" ? <div className="nm-card nm-banner"><b>{team.teamName}</b><span className="nm-muted">{team.leads.length ? `тімлід: ${team.leads.map((l) => l.name).join(", ")}` : "тімліда в дашборді немає"} · ви бачите ті самі картки, що й тімлід, і можете вирішити за нього</span></div> : null}
      {note ? <div className="nm-card nm-banner nm-ok-t">{note}</div> : null}
      {errs.bulk ? <div className="nm-card nm-banner"><span className="nm-err">{errs.bulk}</span></div> : null}

      {g.pending.length ? <><div className="nm-sec">Чекають {mode === "lead" ? "вас" : "рішення"} · {g.pending.length}</div>{g.pending.map((c) => card(c, false))}</> : null}
      {g.done.length ? <><div className="nm-sec">Опрацьовано · {g.done.length}</div>{g.done.map((c) => card(c, false))}</> : null}
      {g.empty.length ? <><div className="nm-sec">Ніхто не набрав · {g.empty.length}</div>{g.empty.map((c) => card(c, false))}</> : null}
      {g.about.length ? <><div className="nm-sec">{aboutLabel} · {g.about.length}</div>{g.about.map((c) => card(c, true))}</> : null}

      {!frozen && bulkable.length > 1 ? (
        <div className="nm-bulk">
          <button className="nm-btn lg p" disabled={busy != null} onClick={() => void bulk()}>{busy === "bulk" ? "Погоджую…" : `Погодитись з рештою (${bulkable.length})`}</button>
          <span className="nm-muted">Кожне рішення можна скасувати до вт 08:00</span>
        </div>
      ) : null}
    </div>
  );
}

function NomCard({ week, team, cell, mode, about, busy, err, editing, onEdit, onConfirm, onRetract, onSaveOwn, onDrill }: {
  week: NominationWeek; team: NominationTeam; cell: NominationCell; mode: "lead" | "admin"; about: boolean;
  busy: boolean; err: string | null; editing: boolean; onEdit: (on: boolean) => void;
  onConfirm: () => void; onRetract: () => void; onSaveOwn: (ids: number[], value: number, reason: string) => void; onDrill: (d: Drill) => void;
}) {
  const [all, setAll] = useState(false);
  const d = week.defs.find((x) => x.key === cell.nomination)!;
  const frozen = week.state === "frozen";
  const name = (id: number) => week.names[String(id)] ?? team.members.find((m) => m.id === id)?.name ?? `Менеджер #${id}`;
  const me = week.viewer.managerId;
  const crm = cell.crm;
  const own = cell.final.status === "overridden";
  const winners = own ? cell.final.winners : crm.state === "ok" ? crm.winners : [];
  const value = own ? cell.final.value : crm.state === "ok" ? crm.value : null;
  const ranking = cell.ranking;
  const runners = (ranking ?? []).filter((r) => !(crm.state === "ok" && crm.winners.includes(r.managerId)) && r.value != null && r.value > 0).slice(0, 2);
  const drillKind = DRILL_KIND[cell.nomination];
  const drillFor = (id: number, v: number | null) => drillKind ? onDrill({ managerId: id, name: name(id), nomination: cell.nomination, kind: drillKind, value: v, unit: d.unit }) : undefined;
  const who = (id: number) => <>{name(id)}{id === me ? <span className="nm-pill me">ви</span> : null}</>;

  return (
    <div className={`nm-card nm-ncard${about ? " about" : ""}${editing ? " editing" : ""}`}>
      <div className="nm-nc-rule">
        <div className="nm-nc-lab">{d.label}</div>
        <div className="nm-rule"><b>Рахуємо:</b> {d.rule}<br /><b>Не рахуємо:</b> {d.notCounted}</div>
      </div>

      <div className="nm-nc-prop">
        <div className={`nm-sys${own ? " own" : ""}`}>{own ? `Свої дані${cell.review?.by ? ` · ${cell.review.by}` : ""}` : "Пропозиція системи · з CRM"}</div>
        {winners.length ? (
          <div className="nm-win">
            <span className="nm-avs">{winners.slice(0, 3).map((id) => <EmployeePhoto key={id} photo={week.photos?.[String(id)]} name={name(id)} size={40} className="nm-av" />)}</span>
            <span className="nm-name">{winners.map((id, i) => <span key={id}>{i ? ", " : ""}{who(id)}</span>)}{winners.length > 1 ? <span className="nm-muted"> · нічия</span> : null}</span>
            <span className="nm-big">{fmtValue(d.unit, value)}{d.unit === "count" && cell.nomination === "cars" ? " авто" : ""}</span>
          </div>
        ) : <div className="nm-muted">Ніхто не набрав — погоджувати нічого{frozen ? "" : ", але можна ввести свої дані"}.</div>}
        {own ? <>
          <div className="nm-quote">«{cell.final.reason}»</div>
          <div className="nm-strike">Пропозиція системи: {crm.state === "ok" ? `${crm.winners.map(name).join(", ")} · ${fmtValue(d.unit, crm.value)}` : "ніхто не набрав"}</div>
        </> : null}
        {cell.nomination === "marginPct" && (value ?? 0) > week.marginFlagPct ? <span className="nm-pill danger">понад {week.marginFlagPct}% від виплати водію</span> : null}
        {cell.nomination === "marginPct" && cell.deal?.price != null && cell.deal.cost != null && !own ? (
          <div className="nm-muted">угода-доказ: {cell.deal.url ? <a href={cell.deal.url} target="_blank" rel="noreferrer">{cell.deal.id}</a> : cell.deal.id} · маржа {formatAmountFull(cell.deal.price)} / водію {formatAmountFull(cell.deal.cost)}</div>
        ) : null}
        {ranking == null ? <div className="nm-muted">Рейтинг цього тижня не зберігався (тиждень зафіксовано до 22.09).</div>
          : runners.length && !all ? <div className="nm-run">{runners.map((r, i) => <span key={r.managerId}>{i ? " · " : ""}{i + 2}-е: {name(r.managerId).split(/\s+/)[0]} · {fmtValue(d.unit, r.value)}</span>)}</div> : null}
        {all && ranking ? (
          <div className="nm-rank">
            {ranking.map((r, i) => (
              <div key={r.managerId} className={`nm-rank-row${r.managerId === me ? " me" : ""}`}>
                <span>{i + 1} · {who(r.managerId)}</span>
                <span>{r.value != null && r.value > 0
                  ? (drillKind ? <button className="nm-link" onClick={() => drillFor(r.managerId, r.value)}>{fmtValue(d.unit, r.value)}</button> : fmtValue(d.unit, r.value))
                  : <span className="nm-muted">0 · не набрав</span>}</span>
              </div>
            ))}
          </div>
        ) : null}
        <div className="nm-links">
          {ranking && ranking.length > 1 ? <button className="nm-link" onClick={() => setAll(!all)}>{all ? "Згорнути" : `Уся команда (${ranking.length})`}</button> : null}
          {drillKind && crm.state === "ok" ? <button className="nm-link" onClick={() => drillFor(crm.winners[0], crm.value)}>Показати угоди →</button> : null}
          {cell.nomination === "intl" ? <span className="nm-muted">склад міжнародних — наступним проходом</span> : null}
        </div>
      </div>

      <div className="nm-nc-act">
        <Decision week={week} cell={cell} mode={mode} about={about} busy={busy} err={err} frozen={frozen}
          onConfirm={onConfirm} onRetract={onRetract} onOwn={() => onEdit(true)} />
      </div>

      {editing ? (
        <OwnData week={week} team={team} cell={cell} busy={busy} err={err} onCancel={() => onEdit(false)} onSave={onSaveOwn} />
      ) : null}
    </div>
  );
}

function Decision({ week, cell, mode, about, busy, err, frozen, onConfirm, onRetract, onOwn }: {
  week: NominationWeek; cell: NominationCell; mode: "lead" | "admin"; about: boolean; busy: boolean; err: string | null; frozen: boolean;
  onConfirm: () => void; onRetract: () => void; onOwn: () => void;
}) {
  const st = cell.final.status;
  const by = cell.review?.by ? ` · ${cell.review.by}` : "";
  const at = cell.review?.at ? ` · ${whenText(cell.review.at)}` : "";
  if (frozen) {
    return <span className="nm-muted">{st === "confirmed" ? "Погоджено" : st === "overridden" ? "Свої дані" : st === "empty" ? "Ніхто не набрав" : "Без рішення — пішла пропозиція системи"}</span>;
  }
  if (!cell.canReview) return <span className="nm-muted">{about && mode === "lead" ? "Вирішує керівництво" : cell.whyNot ?? ""}</span>;
  return (
    <div className="nm-dec">
      {st === "confirmed" ? (
        <div className="nm-done"><span>Погоджено{by}{at}</span><button className="nm-link" disabled={busy} onClick={onRetract}>Скасувати</button></div>
      ) : st === "overridden" ? (
        <>
          <button className="nm-link" disabled={busy} onClick={onOwn}>Змінити дані</button>
          {cell.crm.state === "ok"
            ? <button className="nm-link" disabled={busy} onClick={onConfirm}>Повернути пропозицію системи</button>
            : <button className="nm-link" disabled={busy} onClick={onRetract}>Прибрати свої дані</button>}
        </>
      ) : (
        <>
          {cell.crm.state === "ok" ? <button className="nm-btn lg p" disabled={busy} onClick={onConfirm}>{busy ? "Зберігаю…" : "Погоджуюсь"}</button> : null}
          <button className="nm-btn lg" disabled={busy} onClick={onOwn}>Свої дані</button>
        </>
      )}
      {cell.final.stale && st !== "confirmed" ? <span className="nm-muted">CRM змінився після вашого рішення — перевірте ще раз</span> : null}
      {err ? <span className="nm-err">{err}</span> : null}
      {week.state === "draft" && cell.review?.action === "retract" && st === "unconfirmed" ? <span className="nm-muted">рішення скасовано{by}</span> : null}
    </div>
  );
}

/** «Свої дані»: хто переміг (з рейтингу, число підставляється з CRM), своє число і звідки воно. */
function OwnData({ week, team, cell, busy, err, onCancel, onSave }: {
  week: NominationWeek; team: NominationTeam; cell: NominationCell; busy: boolean; err: string | null;
  onCancel: () => void; onSave: (ids: number[], value: number, reason: string) => void;
}) {
  const d = week.defs.find((x) => x.key === cell.nomination)!;
  const me = week.viewer.role === "team_lead" ? week.viewer.managerId : null;
  const list = cell.ranking ?? team.members.map((m) => ({ managerId: m.id, value: null as number | null }));
  const init = cell.final.status === "overridden" ? cell.final.winners : cell.crm.state === "ok" ? cell.crm.winners.filter((id) => id !== me) : [];
  const [ids, setIds] = useState<number[]>(init);
  const [num, setNum] = useState<string>(cell.final.status === "overridden" && cell.final.value != null ? String(cell.final.value)
    : cell.crm.state === "ok" ? String(d.unit === "pct" ? Math.round(cell.crm.value) : cell.crm.value) : "");
  const [why, setWhy] = useState<string>(cell.final.status === "overridden" ? cell.final.reason ?? "" : "");
  const name = (id: number) => week.names[String(id)] ?? team.members.find((m) => m.id === id)?.name ?? `Менеджер #${id}`;
  const value = parseAmount(num);
  const hint = ownDataHint(list, ids, value);
  const toggle = (id: number, v: number | null) => {
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
    setIds(next);
    // Перша обрана людина — підставляємо її число з CRM; далі людина правит сама.
    if (!ids.includes(id) && next.length === 1 && v != null && v > 0) setNum(String(d.unit === "pct" ? Math.round(v) : v));
  };
  const unitLbl = d.unit === "uah" ? "₴" : d.unit === "pct" ? "%" : cell.nomination === "cars" ? "авто" : "шт";
  return (
    <div className="nm-own" role="group" aria-label={`Свої дані: ${d.label}`}>
      <div className="nm-own-h"><b>Свої дані: {d.label.toLowerCase()}</b>
        <span className="nm-muted">Пропозиція системи: {cell.crm.state === "ok" ? `${cell.crm.winners.map(name).join(", ")} — ${fmtValue(d.unit, cell.crm.value)}` : "ніхто не набрав"}</span></div>
      <span className="nm-muted">Хто переміг — натисніть людину (кілька — нічия). Число з CRM підставиться, його можна змінити.</span>
      <div className="nm-chips">
        {list.map((r) => (
          <button key={r.managerId} type="button" className={`nm-chip${ids.includes(r.managerId) ? " on" : ""}`} disabled={r.managerId === me}
            title={r.managerId === me ? "Рядок про себе вирішує керівництво" : undefined} onClick={() => toggle(r.managerId, r.value)}>
            {name(r.managerId)}{r.managerId === me ? " (ви)" : ""} <b>{r.value != null && r.value > 0 ? fmtValue(d.unit, r.value) : "0"}</b>
          </button>
        ))}
      </div>
      <div className="nm-own-f">
        <label className="nm-field"><span>Ваше число, {unitLbl}</span>
          <input className="nm-inp" inputMode="decimal" value={num} onChange={(e) => setNum(e.target.value)} /></label>
        <label className="nm-field"><span>Звідки ваше число *</span>
          <input className="nm-inp" value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Напр.: 3 рейси внесені в CRM уже після неділі" /></label>
      </div>
      {num && value == null ? <div className="nm-err">Число має бути більше нуля: «11 200», «312%» чи «12,5» — підходить.</div> : null}
      {hint.differs || hint.higher.length ? (
        <div className="nm-hint">
          {hint.differs ? <>Ваше число відрізняється від CRM: у {ids.map(name).join(", ")} за CRM <b>{fmtValue(d.unit, hint.crmOfChosen)}</b>. </> : null}
          {hint.higher.length ? <>За CRM більше в {hint.higher.slice(0, 3).map((h) => `${name(h.managerId)} (${fmtValue(d.unit, h.value)})`).join(", ")}. </> : null}
          Зберегти можна — просто напишіть, звідки ваше число.{cell.nomination === "cars" ? " Підказка: угоди, що лише зайшли в оплату, в «Авто» не рахуються." : ""}
        </div>
      ) : null}
      {err ? <div className="nm-err">{err}</div> : null}
      <div className="nm-own-btns">
        <button className="nm-btn lg" onClick={onCancel}>Скасувати</button>
        <button className="nm-btn lg p" disabled={busy || ids.length === 0 || value == null || why.trim().length < 3}
          title={ids.length === 0 ? "Оберіть переможця" : value == null ? "Вкажіть число" : why.trim().length < 3 ? "Напишіть, звідки число" : undefined}
          onClick={() => value != null && onSave(ids, value, why.trim())}>{busy ? "Зберігаю…" : "Зберегти мої дані"}</button>
      </div>
    </div>
  );
}

/** «Звідки число»: угоди людини за тиждень із того самого розкриття, що й Звіт; підсумок звіряється з числом. */
function DealsPanel({ drill, week, onClose }: { drill: Drill; week: NominationWeek; onClose: () => void }) {
  const [res, setRes] = useState<DayItems | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    let alive = true;
    setRes(null); setErr(null); setAll(false);
    fetchDayItems({ managerId: drill.managerId, date: week.weekFrom, to: week.weekTo, kind: drill.kind })
      .then((r) => { if (alive) setRes(r); })
      .catch((e) => { if (!alive) return; const st = (e as { response?: { status?: number } })?.response?.status; setErr(st === 403 ? "Розкриття угод потребує доступу до вкладки «Звіт»." : errorOf(e)); });
    return () => { alive = false; };
  }, [drill.managerId, drill.kind, week.weekFrom, week.weekTo]);
  const items = res ? [...res.items].sort((a, b) => b.price - a.price) : [];
  const shown = all ? items : items.slice(0, 8);
  const got = !res ? null : drill.nomination === "cars" ? res.total.count : drill.nomination === "maxDeal" ? (items[0]?.price ?? 0) : res.total.sum;
  const match = got != null && drill.value != null && Math.abs(got - drill.value) < 1;
  const title = drill.nomination === "cars" ? `Звідки ${drill.value ?? "—"} авто` : `Звідки ${fmtValue(drill.unit, drill.value)}`;
  return (
    <aside className="nm-aside nm-card" aria-label="Звідки число">
      <div className="nm-aside-h">
        <div><b>{title}</b><div className="nm-muted">{drill.name} · {week.defs.find((d) => d.key === drill.nomination)?.label.toLowerCase()} · {dm(week.weekFrom)}–{dm(week.weekTo)}</div></div>
        <button className="nm-nav" aria-label="Закрити" onClick={onClose}>×</button>
      </div>
      <div className="nm-rule">{drill.kind === "dispatched" ? "Угоди з датою завантаження в цьому тижні — як «Авто» на Звіті." : "Угоди «Факту»: оплата отримана або успішно реалізовано за тиждень."} Номер відкриває угоду в Kommo.</div>
      {week.state === "frozen" ? <div className="nm-muted">Склад — за CRM зараз; зафіксоване число — {fmtValue(drill.unit, drill.value)}.</div> : null}
      {err ? <div className="nm-err">{err}</div> : !res ? <div className="nm-muted">Завантаження…</div> : (
        <>
          <div className="nm-deals">
            {shown.map((it, i) => (
              <div key={`${it.kommoId ?? i}`} className="nm-deal">
                <span>{it.url ? <a href={it.url} target="_blank" rel="noreferrer">{it.kommoId}</a> : it.kommoId ?? "—"} <span className="nm-muted">· {it.name}{it.state ? ` · ${it.state}` : ""}</span></span>
                <b>{formatAmountFull(it.price)}</b>
              </div>
            ))}
            {items.length > shown.length ? <button className="nm-link" onClick={() => setAll(true)}>ще {items.length - shown.length} угод — показати всі</button> : null}
            {items.length === 0 ? <div className="nm-muted">Угод немає.</div> : null}
          </div>
          <div className={`nm-sum${match ? "" : " off"}`}>
            <span>Разом {res.total.count} угод{drill.kind === "received" ? ` · ${formatAmountFull(res.total.sum)}` : ""}</span>
            <span>{match ? "= число в номінації" : `не зійшлося з числом у номінації (${fmtValue(drill.unit, drill.value)})`}</span>
          </div>
          {drill.kind === "received" ? <div className="nm-muted">Угоди, завантажені раніше, тут є, бо в «Факт» вони зайшли цього тижня. «Авто» рахує інакше — за датою завантаження.</div> : null}
        </>
      )}
    </aside>
  );
}


/**
 * 🎞 Ручні слайди презентації — ШАБЛОНИ зі слайдів Даші (новий працівник, день народження, новини,
 * конкурс тижня, анонс, довільний). Поля й тексти за замовчуванням приходять із сервера
 * (`SLIDE_TEMPLATES`), тож форма й перевірка не розходяться. Видалення скасовне кнопкою «Відновити».
 */
function ManualSlidesCard({ weekFrom }: { weekFrom: string }) {
  const [d, setD] = useState<ManualSlidesResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<ManualSlide | null>(null);
  const [kind, setKind] = useState<ManualSlideKind | null>(null);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [removed, setRemoved] = useState<ManualSlide | null>(null);
  const [busy, setBusy] = useState(false);
  // 📷 Люди реєстру для поля «Фото» (право сейфу). Немає права — поле показує, що список недоступний.
  const [people, setPeople] = useState<PersonPhoto[] | null>(null);
  const [peopleErr, setPeopleErr] = useState(false);
  useEffect(() => {
    fetchPeoplePhotos().then((p) => setPeople(p.filter((x) => x.status !== "dismissed"))).catch(() => setPeopleErr(true));
  }, []);

  useEffect(() => { setErr(null); setRemoved(null); fetchManualSlides(weekFrom).then(setD).catch((e) => setErr(errorOf(e))); }, [weekFrom]);
  const tpl = d?.templates.find((t) => t.key === kind) ?? null;
  const reset = () => { setEditing(null); setKind(null); setVals({}); };
  const pick = (k: ManualSlideKind) => {
    const t = d?.templates.find((x) => x.key === k);
    setEditing(null); setKind(k);
    setVals(Object.fromEntries((t?.fields ?? []).map((f) => [f.key, f.default ?? ""])));
  };
  const startEdit = (s: ManualSlide) => { setEditing(s); setKind(s.kind); setVals({ ...(s.fields ?? {}) }); };
  const run = async (fn: () => Promise<ManualSlidesResp>) => {
    setBusy(true); setErr(null);
    try { setD(await fn()); return true; } catch (e) { setErr(errorOf(e)); return false; } finally { setBusy(false); }
  };
  const missing = tpl ? tpl.fields.filter((f) => f.required && !(vals[f.key] ?? "").trim()).map((f) => f.label) : [];
  const save = async () => {
    if (!kind) return;
    const p = { weekFrom, kind, fields: vals, position: editing?.position ?? (d?.slides.length ?? 0) };
    if (await run(() => (editing ? updateManualSlide(editing.id, p) : createManualSlide(p)))) reset();
  };
  const label = (k: ManualSlideKind) => d?.templates.find((x) => x.key === k)?.label ?? k;

  return (
    <div className="nm-card">
      <div className="nm-banner"><b>Ручні слайди презентації</b>
        <span className="nm-muted">Шаблони — як у презентації зустрічі: оберіть шаблон, заповніть поля, слайд зʼявиться після титулу. Числа з CRM сюди не пишуться.</span>
        {err ? <span className="nm-err">{err}</span> : null}</div>
      <div className="nm-slides-list">
        {d && d.slides.length === 0 ? <span className="nm-muted">Цього тижня ручних слайдів немає.</span> : null}
        {d?.slides.map((s) => (
          <div className="nm-slide-row" key={s.id}>
            <span className="nm-pill wait">{label(s.kind)}</span><span className="t">{s.title}</span>
            <button className="nm-btn" disabled={busy} onClick={() => startEdit(s)}>Змінити</button>
            <button className="nm-btn" disabled={busy} onClick={() => { setRemoved(s); void run(() => deleteManualSlide(s.id)); }}>Видалити</button>
          </div>
        ))}
        {removed ? <div className="nm-slide-row"><span className="nm-muted">Видалено «{removed.title}».</span>
          <button className="nm-btn" disabled={busy} onClick={() => { const id = removed.id; setRemoved(null); void run(() => restoreManualSlide(id)); }}>Відновити</button></div> : null}
      </div>
      <div className="nm-slides-list">
        <span className="nm-muted">{editing ? `Змінюєте: ${editing.title}` : "Додати слайд за шаблоном:"}</span>
        {!editing ? <div className="nm-btns">
          {(d?.templates ?? []).map((t) => (
            <button key={t.key} className={`nm-btn${kind === t.key ? " p" : ""}`} onClick={() => pick(t.key)}>{t.label}</button>
          ))}
        </div> : null}
      </div>
      {tpl ? (
        <div className="nm-form">
          {tpl.fields.map((f) => f.type === "employee" ? (
            <label className="nm-field" key={f.key}>
              <span>{f.label}</span>
              <span className="nm-pick">
                {(() => {
                  const p = people?.find((x) => String(x.employeeId) === vals[f.key]);
                  return <EmployeePhoto photo={p?.hasPhoto ? { id: p.employeeId, v: p.v } : null} name={p?.name ?? vals.person ?? "?"} size={34} />;
                })()}
                {peopleErr ? <span className="nm-muted">Список людей недоступний — потрібне право сейфу. Слайд буде з ініціалами.</span> : (
                  <select className="nm-inp" id={`nm-ms-${f.key}`} value={vals[f.key] ?? ""} disabled={!people}
                    onChange={(e) => {
                      const id = e.target.value, p = people?.find((x) => String(x.employeeId) === id);
                      // Новачку підставляємо ПІБ, якщо поле ще порожнє; іменинника пишуть у родовому відмінку — його не чіпаємо.
                      setVals((v) => ({ ...v, [f.key]: id, ...(kind === "newcomer" && p && !(v.person ?? "").trim() ? { person: p.name } : {}) }));
                    }}>
                    <option value="">— без фото (ініціали) —</option>
                    {vals[f.key] && people && !people.some((x) => String(x.employeeId) === vals[f.key])
                      ? <option value={vals[f.key]}>людина #{vals[f.key]} (звільнена або прибрана з реєстру)</option> : null}
                    {(people ?? []).map((p) => <option key={p.employeeId} value={String(p.employeeId)}>{p.name}{p.hasPhoto ? "" : " · фото ще немає"}</option>)}
                  </select>
                )}
              </span>
            </label>
          ) : (
            <label className="nm-field" key={f.key} style={f.multiline ? { gridColumn: "1 / -1" } : undefined}>
              <span>{f.label}{f.required ? " *" : ""}</span>
              {f.multiline
                ? <textarea className="nm-inp" id={`nm-ms-${f.key}`} value={vals[f.key] ?? ""} maxLength={f.max} placeholder={f.placeholder}
                    onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))} />
                : <input className="nm-inp" id={`nm-ms-${f.key}`} value={vals[f.key] ?? ""} maxLength={f.max} placeholder={f.placeholder}
                    onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))} />}
            </label>
          ))}
          <div className="nm-btns" style={{ gridColumn: "1 / -1" }}>
            <button className="nm-btn p" disabled={busy || missing.length > 0} onClick={() => void save()}
              title={missing.length ? `Заповніть: ${missing.join(", ")}` : undefined}>{editing ? "Зберегти слайд" : "Додати слайд"}</button>
            <button className="nm-btn" onClick={reset}>Скасувати</button>
            {missing.length ? <span className="nm-muted">Заповніть: {missing.join(", ")}</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

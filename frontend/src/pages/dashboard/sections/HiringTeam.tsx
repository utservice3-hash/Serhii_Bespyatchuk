import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  fetchTeamVaultStatus, createTeamVaultLink, unlinkTeamVault, fetchTeamPeople, fetchTeamPerson,
  sendTeamSecretCode, revealTeamSecret, resetTeamPassword, hiringError,
  type SecretsStatus, type TeamPerson, type TeamSecretItem,
} from "../../../api";
import type { Toast } from "./HiringShared";
import { StatusBar, RevealDialog, type LinkApi, type RevealApi } from "./HiringSecrets";

/**
 * 👥 «НАЙМ → СПІВРОБІТНИКИ» ДЛЯ ТІМЛІДА (29.09.2026, макет «Паролі команди»).
 *
 * Люди СВОЄЇ команди за CRM, їхній профіль (лише перегляд) і паролі з сейфу, включно з паролем
 * дашборда. Хто «свій» — вирішує сервер (`teamMemberVerdict`); тут нічого не фільтрується.
 * Значення приходить лише після коду з Telegram «UTS Сейф», живе 30 с у стані цього вікна.
 */

// 🔴 Константи модуля, не літерали в JSX: `RevealDialog` тримає двері в `useMemo`, і новий обʼєкт
// щорендеру слав би код у Telegram по колу.
const LINK_API: LinkApi = { link: createTeamVaultLink, unlink: unlinkTeamVault };
const REVEAL_API: RevealApi = { send: sendTeamSecretCode, reveal: revealTeamSecret };

const SERVICE_LABEL: Record<string, string> = {
  dashboard: "Дашборд", kommo: "Kommo", ringostat: "Ringostat", trans_eu: "trans.eu", lardi: "Lardi-Trans",
  della: "Della", yaware: "Yaware", mail: "Пошта", other: "Інше",
};
const titleOf = (i: TeamSecretItem) => (i.service === "other" ? (i.label ?? "Інше") : SERVICE_LABEL[i.service] ?? i.service);
const d = (iso: string | null) => (iso ? iso.slice(0, 10).split("-").reverse().join(".") : "—");

export function HiringTeam({ toast }: { toast: Toast }) {
  const [status, setStatus] = useState<SecretsStatus | null>(null);
  const [rows, setRows] = useState<TeamPerson[] | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<{ id: number; tab: "profile" | "access" } | null>(null);

  const loadStatus = useCallback(() => { fetchTeamVaultStatus().then(setStatus).catch((e) => setErr(hiringError(e))); }, []);
  const load = useCallback(() => {
    fetchTeamPeople().then((r) => { setRows(r.rows); setReason(r.reason); setErr(null); }).catch((e) => setErr(hiringError(e)));
  }, []);
  useEffect(() => { loadStatus(); load(); }, [loadStatus, load]);

  if (err) return <div className="chart-card"><b>Не вдалося завантажити команду.</b> <span className="hr-muted">{err}</span></div>;
  if (!rows || !status) return <p className="loading-text">Завантаження…</p>;
  const openRow = open ? rows.find((r) => r.userId === open.id) ?? null : null;

  return (
    <div>
      <StatusBar status={status} onChanged={loadStatus} toast={toast} api={LINK_API} />
      <div className="kpi-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12, marginBottom: 14 }}>
        <div className="kpi-card"><div className="kpi-label">У команді</div><div className="kpi-value">{rows.length}</div><div className="hr-muted">за командою в CRM, без вас</div></div>
        <div className="kpi-card"><div className="kpi-label">Паролів у сейфі</div><div className="kpi-value">{rows.reduce((a, r) => a + r.passwords, 0)}</div><div className="hr-muted">Kommo, пошта, Ringostat, дашборд…</div></div>
        <div className="kpi-card"><div className="kpi-label">Без пароля дашборда в сейфі</div>
          <div className="kpi-value" style={{ color: rows.some((r) => !r.dashboardKnown) ? "var(--warn)" : undefined }}>{rows.filter((r) => !r.dashboardKnown).length}</div>
          <div className="hr-muted">виданий раніше — скиньте, щоб зберегти</div></div>
      </div>
      {rows.length === 0 ? (
        <div className="chart-card"><b>У вашій команді нікого не знайдено.</b> <span className="hr-muted">{reason ?? "Команду беремо з CRM: менеджери з акаунтом у дашборді, без вас."}</span></div>
      ) : (
        <div className="chart-card" style={{ padding: 0, overflowX: "auto" }}>
          <table className="data-table emp-table">
            <thead><tr><th>Співробітник</th><th>Посада</th><th>Телефон</th><th>Прийнято</th><th>Пароль дашборда</th><th className="num">Доступи</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.userId} onClick={() => setOpen({ id: r.userId, tab: "profile" })} style={{ cursor: "pointer" }}>
                  <td><b>{r.name}</b><div className="hr-muted">{r.login}</div></td>
                  <td>{r.position ?? <span className="hr-muted">не вказано</span>}</td>
                  <td>{r.phone ?? <span className="hr-muted">не вказано</span>}</td>
                  <td>{d(r.hiredAt)}</td>
                  <td>{r.dashboardKnown ? <span className="emp-pill ok">у сейфі</span> : <span className="emp-pill warn">невідомий</span>}</td>
                  <td className="num"><button className="emp-vault" onClick={(e) => { e.stopPropagation(); setOpen({ id: r.userId, tab: "access" }); }}>🔐 {r.passwords}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="hr-muted" style={{ fontSize: 12.5, marginTop: 8 }}>
        Лише активні менеджери вашої команди за CRM. Дані — перегляд; змінює їх HR. Кожен показ пароля — код із Telegram «UTS Сейф», 30 секунд, запис у журнал.
      </p>
      {openRow && open && <TeamDrawer person={openRow} tab={open.tab} status={status} toast={toast}
        onTab={(t) => setOpen({ id: openRow.userId, tab: t })} onClose={() => setOpen(null)} onChanged={load} onStatus={loadStatus} />}
    </div>
  );
}

function TeamDrawer({ person, tab, status, toast, onTab, onClose, onChanged, onStatus }: {
  person: TeamPerson; tab: "profile" | "access"; status: SecretsStatus; toast: Toast;
  onTab: (t: "profile" | "access") => void; onClose: () => void; onChanged: () => void; onStatus: () => void;
}) {
  const [items, setItems] = useState<TeamSecretItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [asking, setAsking] = useState<TeamSecretItem | null>(null);
  const [reveal, setReveal] = useState<{ id: number; value: string; left: number } | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchTeamPerson(person.userId).then((r) => { setItems(r.items); setErr(null); }).catch((e) => setErr(hiringError(e)));
  }, [person.userId]);
  useEffect(load, [load]);
  useEffect(() => {
    if (!reveal) return;
    if (reveal.left <= 0) { setReveal(null); return; }
    const t = window.setTimeout(() => setReveal((r) => (r ? { ...r, left: r.left - 1 } : r)), 1000);
    return () => window.clearTimeout(t);
  }, [reveal]);

  const canShow = status.keyConfigured && status.botConfigured && status.linked;
  const showWhy = !status.keyConfigured ? "Сейф не налаштовано" : !status.botConfigured ? "Бот «UTS Сейф» не підключений" : !status.linked ? "Спершу привʼяжіть Telegram «UTS Сейф»" : undefined;
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast("Скопійовано"); } catch { toast("Не вдалося скопіювати — виділіть вручну", { error: true }); }
  };
  const doReset = async () => {
    try { const r = await resetTeamPassword(person.userId); setConfirmReset(false); setFresh(r.password); load(); onChanged(); }
    catch (e) { setConfirmReset(false); toast(hiringError(e), { error: true }); }
  };
  const hasDashboard = (items ?? []).some((i) => i.service === "dashboard");

  return createPortal(
    <div className="hr-overlay" onClick={onClose}>
      <div className="hr-drawer emp-drawer" role="dialog" aria-label={`Співробітник: ${person.name}`} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{person.name}</div>
            <div className="hr-muted">{person.position ?? "посада не вказана"} · {person.login}</div>
          </div>
          <button className="hr-btn" onClick={onClose}>Закрити</button>
        </div>
        <div className="hr-seg2" style={{ margin: "14px 0 4px" }}>
          <button className={tab === "profile" ? "on" : ""} onClick={() => onTab("profile")}>Профіль</button>
          <button className={tab === "access" ? "on" : ""} onClick={() => onTab("access")}>🔐 Доступи · {items?.length ?? person.passwords}</button>
        </div>
        {tab === "profile" ? (
          <div className="emp-form" style={{ display: "grid", gridTemplateColumns: "160px minmax(0, 1fr)", gap: "10px 16px", fontSize: 14, marginTop: 12 }}>
            <span className="hr-muted">Посада</span><span>{person.position ?? "не вказано"}</span>
            <span className="hr-muted">Телефон</span><span>{person.phone ?? "не вказано"}</span>
            <span className="hr-muted">Пошта</span><span>{person.email ?? "не вказано"}</span>
            <span className="hr-muted">Telegram</span><span>{person.telegram ?? "не вказано"}</span>
            <span className="hr-muted">День народження</span><span>{d(person.birthDate)}</span>
            <span className="hr-muted">Прийнято</span><span>{d(person.hiredAt)}</span>
            <span className="hr-muted" style={{ gridColumn: "1 / -1", marginTop: 6 }}>Лише перегляд. Документи людини й звільнення — у HR.</span>
          </div>
        ) : (
          <div style={{ marginTop: 10 }}>
            {err && <p style={{ color: "var(--danger)" }}>{err}</p>}
            {!hasDashboard && items && (
              <div className="hr-note" style={{ background: "var(--warn-bg)", color: "var(--warn)", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <span><b>Пароль дашборда невідомий</b> — його видали до сейфу. Скиньте, щоб отримати новий і зберегти.</span>
                <button className="hr-btn xs" onClick={() => setConfirmReset(true)}>Скинути пароль дашборда</button>
              </div>
            )}
            {items && items.length === 0 && <div className="hr-muted" style={{ marginTop: 8 }}>У сейфі для цієї людини паролів немає.</div>}
            <ul className="sv-list">
              {(items ?? []).map((i) => {
                const shown = reveal?.id === i.id ? reveal : null;
                return (
                  <li key={i.id}>
                    <span className="sv-ico" aria-hidden="true">{(titleOf(i)[0] ?? "•").toUpperCase()}</span>
                    <span>
                      <b>{titleOf(i)}</b>
                      <div className="hr-muted">{i.login ?? "логін не вказано"}</div>
                      <div className={`sv-secret ${shown ? "open" : ""}`} aria-live="polite">{shown ? shown.value : "••••••••••"}</div>
                    </span>
                    <span className="sv-acts">
                      {shown ? (<>
                        <span className="sv-count">{shown.left} с</span>
                        <button className="hr-btn xs" onClick={() => void copy(shown.value)}>Копіювати</button>
                        <button className="hr-btn xs" onClick={() => setReveal(null)}>Сховати</button>
                      </>) : (
                        <button className="hr-btn xs p" disabled={!canShow} title={showWhy} onClick={() => setAsking(i)}>Показати</button>
                      )}
                      {i.service === "dashboard" && <button className="hr-btn xs" onClick={() => setConfirmReset(true)}>Скинути</button>}
                    </span>
                  </li>
                );
              })}
            </ul>
            {!canShow && showWhy && <div className="hr-muted" style={{ marginTop: 6 }}>«Показати» недоступне — {showWhy}.</div>}
            <div className="hr-muted" style={{ fontSize: 12, marginTop: 8 }}>Скинути можна лише пароль дашборда. Паролі Kommo, пошти та інших сервісів змінює HR.</div>
          </div>
        )}
        {asking && <RevealDialog item={{ ...asking, last4: null }} whose={person.name} api={REVEAL_API} onClose={() => setAsking(null)}
          onNeedLink={() => { setAsking(null); onStatus(); }}
          onShown={(value) => { setReveal({ id: asking.id, value, left: 30 }); setAsking(null); }} />}
        {confirmReset && (
          <div className="hr-modal-back" onClick={() => setConfirmReset(false)}>
            <div className="hr-modal" role="dialog" aria-label="Скинути пароль дашборда" onClick={(e) => e.stopPropagation()}>
              <h3 style={{ margin: "0 0 4px" }}>Скинути пароль дашборда?</h3>
              <p className="hr-muted" style={{ fontSize: 13, margin: "0 0 10px" }}>{person.name}</p>
              <ul style={{ margin: "0 0 12px", paddingLeft: 18, fontSize: 14, lineHeight: 1.5 }}>
                <li>Старий пароль перестане діяти одразу.</li>
                <li>Новий згенерується й збережеться в сейфі.</li>
                <li>Вам покажемо його один раз — передайте людині.</li>
              </ul>
              <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                <button className="hr-btn" onClick={() => setConfirmReset(false)}>Скасувати</button>
                <button className="hr-btn p" style={{ background: "var(--danger)", borderColor: "var(--danger)" }} onClick={() => void doReset()}>Скинути пароль</button>
              </div>
            </div>
          </div>
        )}
        {fresh && (
          <div className="hr-modal-back">
            <div className="hr-modal" role="dialog" aria-label="Новий пароль дашборда">
              <h3 style={{ margin: "0 0 4px" }}>Новий пароль дашборда</h3>
              <p className="hr-muted" style={{ fontSize: 13, margin: "0 0 10px" }}>{person.name} · {person.login}</p>
              <div className="sv-secret open" style={{ fontSize: 20 }}>{fresh}</div>
              <p className="hr-muted" style={{ fontSize: 12.5 }}>Збережено в сейфі. Зараз показуємо один раз; далі — через «Показати» з кодом. Скидання записано в журнал.</p>
              <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                <button className="hr-btn" onClick={() => void copy(fresh)}>Копіювати</button>
                <button className="hr-btn p" onClick={() => setFresh(null)}>Готово</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

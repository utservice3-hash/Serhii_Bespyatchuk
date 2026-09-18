import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  fetchHiringTraining, fetchHiringTrainingDetail, createHiringInvite, extendHiringAccess, restoreHiringAccess,
  promoteHiringCandidate, answerHiringQuestion, inviteUrl, hiringError, issueHiringPassword,
  type HiringMeta, type HiringTrainingRow, type HiringTrainingRules, type HiringTrainingDetail, type HiringTrainingHealth, type HiringCloseReason,
} from "../../../api";
import { RefusalDialog, StatusPill, type Toast } from "./HiringShared";

/**
 * 🎓 «НАЙМ · НА НАВЧАННІ», прохід 2a (17.09.2026) — за макетом v12, який прийняв Роман.
 * Рекрутер бачить усіх, тімлід — свою команду (межу тримає сервер). Рішення «менеджер» і відповіді
 * на питання — тімлід або адмін-рівень (`canDecide` із сервера). Екзамену ще немає (прохід 2c), тож
 * умова «менеджера» до того — усі кроки навчання пройдено.
 */

const HEALTH: Record<HiringTrainingHealth, [string, string]> = {
  ok: ["йде за планом", "pl"],
  stuck: ["застряг", "dg"],
  no_login: ["не заходив(ла)", "dg"],
  done: ["усі кроки пройдено", "ok"],
  closed: ["доступ закрито", "gr"],
  manager: ["став менеджером", "ok"],
  no_account: ["акаунт не створено", "wn"],
};
const CLOSED: Record<HiringCloseReason, string> = {
  no_login: "не зайшов(ла) за 48 год",
  expired: "навчання не завершено вчасно",
  refused: "відмова",
  manager: "став менеджером",
};

const HOUR = 3_600_000;
const kyiv = (iso: string | null, withTime = true) => iso
  ? new Date(iso).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}) })
  : "—";
const hoursAgo = (iso: string | null) => (iso ? Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / HOUR)) : null);
const lastSeen = (r: HiringTrainingRow) => {
  const a = r.last_activity_at && (!r.first_login_at || r.last_activity_at > r.first_login_at) ? r.last_activity_at : r.first_login_at;
  return a;
};

function healthText(r: HiringTrainingRow): [string, string] {
  const [t, tone] = HEALTH[r.health];
  if (r.health === "stuck") return [`застряг · ${hoursAgo(lastSeen(r))} год без руху`, tone];
  return [t, tone];
}

/** Доступ: скільки лишилось або чому закрито. */
function accessText(r: HiringTrainingRow): [string, string] {
  if (r.health === "no_account") return ["—", "gr"];
  if (r.access_closed_reason === "manager") return [`роль «Менеджер» з ${kyiv(r.access_closed_at, false)}`, "ok"];
  if (r.access_closed_at) return [`закрито ${kyiv(r.access_closed_at, false)} · ${CLOSED[r.access_closed_reason!]}`, "gr"];
  if (!r.deadline) return ["—", "gr"];
  const left = Math.round((new Date(r.deadline).getTime() - Date.now()) / HOUR);
  if (left <= 0) return ["закриється найближчим часом", "dg"];
  if (!r.first_login_at) return [`не заходив(ла) · закриття через ${left} год`, left <= 24 ? "dg" : "wn"];
  return [`доступ ще ${left} год`, left <= 12 ? "dg" : left <= 30 ? "wn" : "gr"];
}

function Bar({ pct, big }: { pct: number; big?: boolean }) {
  return (
    <span className="hr-pbar">
      <span className={`hr-bar ${big ? "big" : ""}`}><i style={{ width: `${pct}%` }} /></span>
      <b className="num">{pct}%</b>
    </span>
  );
}

export function HiringTraining({ meta, toast, onChanged }: { meta: HiringMeta; toast: Toast; onChanged: () => void }) {
  const [data, setData] = useState<{ rows: HiringTrainingRow[]; rules: HiringTrainingRules; canDecide: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [showClosed, setShowClosed] = useState(false);

  const load = useCallback(() => {
    fetchHiringTraining().then((d) => { setData(d); setErr(null); }).catch((e) => setErr(hiringError(e)));
  }, []);
  useEffect(load, [load]);

  if (err) return <div className="hr-card"><div className="hr-sect" style={{ border: 0 }}><b>Не вдалося завантажити.</b> <span className="hr-muted">{err}</span></div></div>;
  if (!data) return <p className="loading-text">Завантаження…</p>;

  const lead = meta.access === "lead";
  const live = data.rows.filter((r) => !r.access_closed_at);
  const rows = showClosed ? data.rows : live;
  const learning = live.filter((r) => r.health !== "no_account");
  const attention = live.filter((r) => r.health === "stuck" || r.health === "no_login");
  const ready = live.filter((r) => r.health === "done");
  const questions = live.reduce((n, r) => n + r.open_questions, 0);
  const soon = live.filter((r) => r.deadline && new Date(r.deadline).getTime() - Date.now() <= 24 * HOUR && r.health !== "done").length;
  const avg = learning.length ? Math.round(learning.reduce((a, r) => a + r.percent, 0) / learning.length) : 0;
  const emptyCourse = data.rows.length > 0 && data.rows.every((r) => r.total === 0);
  const closedCount = data.rows.length - live.length;

  return (
    <>
      <div className="hr-card">
        <div className="hd">
          <div>
            <h3>На навчанні</h3>
            <div className="hr-muted">{lead
              ? "Кандидати вашої команди на навчанні: прогрес, питання, рішення «менеджер» чи відмова."
              : "Усі кандидати на навчанні. Тімлід кожної команди бачить своїх і вирішує після навчання."}</div>
          </div>
          {closedCount > 0 && (
            <label className="hr-muted" style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
              <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> показати із закритим доступом ({closedCount})
            </label>
          )}
        </div>
        <div className="hr-tiles">
          <div className="hr-tile"><div className="lb">На навчанні</div><div className="vl">{learning.length}</div><div className="sb">середній прогрес {avg}%</div></div>
          <div className="hr-tile"><div className="lb">Потребують уваги</div><div className="vl" style={{ color: attention.length ? "var(--danger)" : undefined }}>{attention.length}</div><div className="sb">не заходили або понад {data.rules.stuckHours} год без руху</div></div>
          <div className="hr-tile"><div className="lb">Пройшли все навчання</div><div className="vl" style={{ color: ready.length ? "var(--ok)" : undefined }}>{ready.length}</div><div className="sb">чекають рішення тімліда</div></div>
          <div className="hr-tile"><div className="lb">Питань без відповіді</div><div className="vl">{questions}</div><div className="sb">закриття доступу за добу: {soon}</div></div>
        </div>
        {emptyCourse && (
          <div className="hr-note" style={{ margin: "0 16px 12px", background: "var(--warn-bg)", color: "var(--warn)" }}>
            У «Навчанні» немає опублікованого курсу для кандидатів — кроків 0, прогрес рахувати нема з чого, і «Перевести в менеджери» недоступне.
          </div>
        )}
        {rows.length === 0 ? (
          <div className="hr-sect hr-muted">Нікого на навчанні. Кандидат зʼявляється тут, щойно тімлід переводить його в «кандидат + команда».</div>
        ) : (
          <div className="hr-tw">
            <table className="hr-table">
              <thead><tr><th>Кандидат</th><th>Команда</th><th>День</th><th>Прогрес</th><th>Зараз на кроці</th><th>Остання активність</th><th>Стан</th><th>Доступ</th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const h = healthText(r), a = accessText(r), seen = lastSeen(r);
                  return (
                    <tr key={r.id} className="row" style={{ opacity: r.access_closed_at ? 0.6 : 1 }} onClick={() => setOpenId(r.id)}>
                      <td><b>{r.full_name || "ПІБ не вказано"}</b><div className="hr-muted">{r.phone ?? ""}{r.open_questions ? <> · <span className="hr-pill wn">питань: {r.open_questions}</span></> : null}</div></td>
                      <td>{r.team_name ?? <span className="hr-muted">без команди</span>}</td>
                      <td className="num">{r.first_login_at ? `${Math.max(r.day, 1)} / ${r.days}` : "—"}</td>
                      <td style={{ minWidth: 130 }}>{r.health === "no_account" ? <span className="hr-muted">—</span> : <><Bar pct={r.percent} /><div className="hr-muted">{r.done} із {r.total}</div></>}</td>
                      <td>{r.health === "no_account" ? <span className="hr-muted">—</span> : r.current_step ?? <span className="hr-muted">{r.total ? "усі кроки пройдено" : "кроків немає"}</span>}</td>
                      <td>{seen ? <>{kyiv(seen)} <span className="hr-muted">· {hoursAgo(seen)} год тому</span></> : <span className="hr-muted">не заходив(ла)</span>}</td>
                      <td><span className={`hr-pill ${h[1]}`}>{h[0]}</span></td>
                      <td><span className={`hr-pill ${a[1]}`}>{a[0]}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="hr-sect hr-muted">
          «Застряг» — понад {data.rules.stuckHours} год без жодної відмітки в навчанні. Клік по рядку відкриває прогрес.
        </div>
      </div>

      <details className="hr-card" style={{ padding: "10px 16px" }}>
        <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Як це працює · правила на затвердження Сергієм</summary>
        <ul style={{ margin: "8px 0 4px", paddingLeft: 18, lineHeight: 1.6, fontSize: 13 }}>
          <li><b>Акаунт</b> створюється сам, коли тімлід переводить кандидата в «кандидат + команда». Роль — «Кандидат»: лише «Навчання» і «Документи».</li>
          <li><b>Вхід</b> — «Показати логін і пароль»: пароль видно один раз, рекрутер копіює й надсилає сам; новий пароль гасить старий. Запасний спосіб — посилання-запрошення (чинне {data.rules.inviteHours} год, спрацьовує один раз).</li>
          <li><b>Строк:</b> без жодного входу за {data.rules.noLoginHours} год — доступ закривається. Після першого входу — {data.rules.trainingDays} дні за Києвом, рахуючи день входу. «Продовжити доступ на 1 день» — рекрутер або тімлід.</li>
          <li><b>Перший вхід</b> переводить «кандидат + команда» → «на навчанні»: так щоденний звіт бачить старт навчання того дня, коли людина зайшла.</li>
          <li><b>Рішення:</b> «Перевести в менеджери» — тімлід або керівник, коли пройдено всі кроки (після проходу 2c — після екзамену); роль акаунта стає «Менеджер». «Відмовити» закриває доступ.</li>
        </ul>
      </details>

      {openId != null && <TrainingDrawer meta={meta} id={openId} toast={toast} onClose={() => setOpenId(null)} onChanged={() => { load(); onChanged(); }} />}
    </>
  );
}

/**
 * Видача входу кандидату. Основний спосіб — логін і пароль, показані Івану ОДИН раз (рішення
 * власника 18.09.2026, як казав Сергій на зустрічі 15.09). Посилання-запрошення лишається
 * запасним: кандидат сам ставить пароль. Нова видача будь-яким способом гасить попередню.
 */
function InviteBox({ id, toast, onChanged, disabled }: { id: number; toast: Toast; onChanged: () => void; disabled: string | null }) {
  const [link, setLink] = useState<{ url: string; expiresAt: string; login: string } | null>(null);
  const [cred, setCred] = useState<{ login: string; password: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const makePassword = async () => {
    if (cred && !window.confirm("Видати новий пароль? Попередній перестане працювати.")) return;
    setBusy(true);
    try { setCred(await issueHiringPassword(id)); setLink(null); onChanged(); }
    catch (e) { toast(hiringError(e), { error: true }); }
    setBusy(false);
  };
  const copyCred = async () => {
    if (!cred) return;
    try { await navigator.clipboard.writeText(`Логін: ${cred.login}\nПароль: ${cred.password}\nВхід: ${window.location.origin}/login`); toast("Логін і пароль скопійовано — надішліть кандидату"); }
    catch { toast("Не вдалося скопіювати — виділіть вручну", { error: true }); }
  };
  const make = async () => {
    setBusy(true);
    try {
      const r = await createHiringInvite(id);
      setCred(null);
      setLink({ url: inviteUrl(r.token), expiresAt: r.expiresAt, login: r.login });
      onChanged();
    } catch (e) { toast(hiringError(e), { error: true }); }
    setBusy(false);
  };
  const copy = async () => {
    if (!link) return;
    try { await navigator.clipboard.writeText(link.url); toast("Посилання скопійовано — надішліть кандидату"); }
    catch { toast("Не вдалося скопіювати — виділіть посилання вручну", { error: true }); }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {cred && (
        <div className="hr-invite">
          <div className="hr-cred">
            <div><span className="hr-muted">Логін</span> <b>{cred.login}</b></div>
            <div><span className="hr-muted">Пароль</span> <b className="mono">{cred.password}</b></div>
          </div>
          <button className="hr-btn p" onClick={() => void copyCred()}>Копіювати</button>
          <div className="hr-muted" style={{ flexBasis: "100%" }}>Пароль показано один раз і більше ніде не зберігається. Загубили — натисніть «Новий пароль».</div>
        </div>
      )}
      {link ? (
        <div className="hr-invite">
          <input className="hr-inp" readOnly value={link.url} onFocus={(e) => e.target.select()} aria-label="Посилання-запрошення" />
          <button className="hr-btn p" onClick={() => void copy()}>Копіювати</button>
          <div className="hr-muted" style={{ flexBasis: "100%" }}>Логін: <b>{link.login}</b> · чинне до {kyiv(link.expiresAt)} · спрацює один раз. Посилання більше ніде не показується — скопіюйте зараз.</div>
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button className="hr-btn p" disabled={busy || !!disabled} title={disabled ?? undefined} onClick={() => void makePassword()}>
          {busy ? "…" : cred ? "Новий пароль" : "Показати логін і пароль"}
        </button>
        {!link && (
          <button className="hr-btn" disabled={busy || !!disabled} title={disabled ?? "Кандидат сам встановить пароль за посиланням"} onClick={() => void make()}>
            Посилання-запрошення
          </button>
        )}
      </div>
    </div>
  );
}

function inviteLine(r: HiringTrainingRow): string {
  const i = r.invite;
  // Пароль, виданий пізніше за останнє запрошення, — головний спосіб входу.
  if (r.password_issued_at && (!i || r.password_issued_at > (i.used_at ?? i.revoked_at ?? i.expires_at)))
    return `логін і пароль видано ${kyiv(r.password_issued_at)}`;
  if (!i) return "вхід ще не видавали";
  if (i.used_at) return `пароль встановлено ${kyiv(i.used_at)}`;
  if (i.revoked_at) return "останнє запрошення погашено";
  if (new Date(i.expires_at).getTime() <= Date.now()) return `запрошення прострочене (${kyiv(i.expires_at)})`;
  return `запрошення чинне до ${kyiv(i.expires_at)}, ще не відкрите`;
}

/** Блок у картці кандидата: акаунт, запрошення, прогрес коротко й вхід у повний прогрес. */
export function TrainingAccessBlock({ meta, id, toast, onChanged }: { meta: HiringMeta; id: number; toast: Toast; onChanged: () => void }) {
  const [d, setD] = useState<HiringTrainingDetail | null | "none">(null);
  const [open, setOpen] = useState(false);
  const load = useCallback(() => {
    fetchHiringTrainingDetail(id).then(setD).catch((e) => setD((e as { response?: { status?: number } }).response?.status === 404 ? "none" : null));
  }, [id]);
  useEffect(load, [load]);
  if (d === null || d === "none") return null;
  const r = d.row, h = healthText(r), a = accessText(r);
  const inviteBlock = r.access_closed_at ? "Доступ закрито" : r.status !== "candidate" && r.status !== "training" ? "Запрошення — для «кандидат + команда» і «на навчанні»" : null;
  return (
    <div className="hr-sect" style={{ padding: "14px 0 0", marginTop: 14 }}>
      <h4>Навчання й доступ</h4>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
        <span className={`hr-pill ${h[1]}`}>{h[0]}</span><span className={`hr-pill ${a[1]}`}>{a[0]}</span>
      </div>
      {r.health !== "no_account" && <><Bar pct={r.percent} /><div className="hr-muted" style={{ margin: "2px 0 6px" }}>{r.done} із {r.total} кроків · логін {r.login} · {inviteLine(r)}</div></>}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "flex-start" }}>
        <InviteBox id={id} toast={toast} onChanged={() => { load(); onChanged(); }} disabled={inviteBlock} />
        <button className="hr-btn" onClick={() => setOpen(true)}>Відкрити прогрес ›</button>
      </div>
      {open && <TrainingDrawer meta={meta} id={id} toast={toast} onClose={() => setOpen(false)} onChanged={() => { load(); onChanged(); }} />}
    </div>
  );
}

const STEP_MARK: Record<HiringTrainingDetail["steps"][number]["state"], string> = { done: "✓", opened: "•", available: "•", locked: "🔒" };

export function TrainingDrawer({ meta, id, toast, onClose, onChanged }: {
  meta: HiringMeta; id: number; toast: Toast; onClose: () => void; onChanged: () => void;
}) {
  const [d, setD] = useState<HiringTrainingDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [promoting, setPromoting] = useState(false);
  const [refusing, setRefusing] = useState(false);
  const [answers, setAnswers] = useState<Record<number, string>>({});

  const load = useCallback(() => {
    fetchHiringTrainingDetail(id).then((x) => { setD(x); setErr(null); }).catch((e) => setErr(hiringError(e)));
  }, [id]);
  useEffect(load, [load]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); toast(ok); load(); onChanged(); }
    catch (e) { toast(hiringError(e), { error: true }); load(); }
  };

  const r = d?.row;
  const open = r && !r.access_closed_at && r.health !== "no_account";
  const canPromote = !!r && open && r.status === "training" && r.total > 0 && r.done >= r.total;
  const promoteWhy = !r ? "" : r.status !== "training" ? "Спершу кандидат має увійти в навчання (статус «на навчанні»)"
    : r.total === 0 ? "У навчанні немає курсу для кандидатів" : r.done < r.total ? `Пройдено ${r.done} із ${r.total} кроків — спершу все навчання` : "";
  const modules = d ? [...new Set(d.steps.map((s) => s.module))] : [];

  return createPortal(
    <div className="hr-overlay" onClick={onClose}>
      <div className="hr-drawer" role="dialog" aria-label="Прогрес навчання" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
          <div>
            <b style={{ fontSize: 17 }}>{r ? r.full_name || "ПІБ не вказано" : "…"}</b>
            {r && <div className="hr-muted">{r.team_name ?? "без команди"}{r.phone ? ` · ${r.phone}` : ""}{r.telegram ? ` · ${r.telegram}` : ""}</div>}
          </div>
          <button className="hr-btn" onClick={onClose}>Закрити</button>
        </div>
        {err && <p style={{ color: "var(--danger)" }}>{err}</p>}
        {d && r && (
          <>
            <div style={{ margin: "8px 0 12px", display: "flex", gap: 6, flexWrap: "wrap" }}>
              <StatusPill meta={meta} status={r.status} />
              <span className={`hr-pill ${healthText(r)[1]}`}>{healthText(r)[0]}</span>
              <span className={`hr-pill ${accessText(r)[1]}`}>{accessText(r)[0]}</span>
            </div>
            {r.health !== "no_account" && (
              <>
                <Bar pct={r.percent} big />
                <div className="hr-muted" style={{ marginTop: 4 }}>
                  {r.done} із {r.total} обовʼязкових кроків · перший вхід {r.first_login_at ? kyiv(r.first_login_at) : "ще не було"} · остання активність {lastSeen(r) ? `${hoursAgo(lastSeen(r))} год тому` : "—"}
                  {r.first_login_at && <> · день {Math.max(r.day, 1)} із {r.days}</>}
                </div>
              </>
            )}

            <div className="hr-sect" style={{ padding: "14px 0 0", marginTop: 14 }}>
              <h4>Доступ</h4>
              <div className="hr-muted" style={{ marginBottom: 6 }}>
                {r.login ? <>Логін <b>{r.login}</b> · {inviteLine(r)}</> : "Акаунт ще не створено: він зʼявиться при статусі «кандидат + команда» або з першим запрошенням."}
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "flex-start" }}>
                <InviteBox id={id} toast={toast} onChanged={() => { load(); onChanged(); }}
                  disabled={r.access_closed_at ? "Доступ закрито — спершу «Відновити доступ»" : r.status !== "candidate" && r.status !== "training" ? "Запрошення — для «кандидат + команда» і «на навчанні»" : null} />
                {open && <button className="hr-btn" onClick={() => void run(() => extendHiringAccess(id), "Доступ продовжено на 1 день")}>Продовжити доступ на 1 день</button>}
                {d.canRestore && r.access_closed_at && (r.access_closed_reason === "no_login" || r.access_closed_reason === "expired") && (
                  <button className="hr-btn" onClick={() => void run(() => restoreHiringAccess(id), "Доступ відновлено щонайменше на добу")}>Відновити доступ</button>
                )}
              </div>
            </div>

            <div className="hr-sect" style={{ padding: "14px 0 0", marginTop: 14 }}>
              <h4>Рішення</h4>
              {r.access_closed_reason === "manager" ? <div className="hr-note" style={{ marginTop: 0, background: "var(--ok-bg)", color: "var(--ok)" }}>Переведено в менеджери. Скасувати — «↩ Повернути» в картці кандидата.</div>
                : !open ? <div className="hr-muted">Доступ закрито — рішення недоступне.</div>
                : !d.canDecide ? <div className="hr-muted">Рішення «менеджер» чи відмова — за тімлідом команди.{canPromote ? " Навчання пройдено: тімлід бачить це на своїй дошці." : ""}</div>
                : (
                  <>
                    {canPromote
                      ? <div className="hr-note" style={{ marginTop: 0, background: "var(--ok-bg)", color: "var(--ok)", marginBottom: 8 }}>Усі кроки пройдено. Ваше рішення:</div>
                      : <div className="hr-note" style={{ marginTop: 0, background: "var(--warn-bg)", color: "var(--warn)", marginBottom: 8 }}>{promoteWhy}. «Менеджер» стане доступним після цього.</div>}
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <button className="hr-btn ok" disabled={!canPromote} title={canPromote ? undefined : promoteWhy} onClick={() => setPromoting(true)}>Перевести в менеджери</button>
                      <button className="hr-btn dg" onClick={() => setRefusing(true)}>Відмовити…</button>
                    </div>
                  </>
                )}
            </div>

            <div className="hr-sect" style={{ padding: "14px 0 0", marginTop: 14 }}>
              <h4>Кроки навчання</h4>
              {d.steps.length === 0 ? <div className="hr-muted">У «Навчанні» немає опублікованого курсу для кандидатів.</div> : modules.map((m) => {
                const own = d.steps.filter((s) => s.module === m);
                const req = own.filter((s) => s.required);
                return (
                  <div key={m} style={{ marginBottom: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 600, margin: "6px 0 4px" }}>
                      <span>{m || "Без модуля"}</span><span className="hr-muted">{req.filter((s) => s.state === "done").length} із {req.length}</span>
                    </div>
                    <ul className="hr-steps">
                      {own.map((s) => (
                        <li key={s.id} className={s.state}>
                          <span className="ic">{s.state === "done" ? STEP_MARK.done : s.state === "locked" ? STEP_MARK.locked : s.index}</span>
                          <span>{s.title}{!s.required && <span className="hr-muted"> · необовʼязковий</span>}</span>
                          <span className="hr-muted">{s.state === "done" ? `опрацьовано ${kyiv(s.finished_at)}` : s.state === "opened" ? `відкрито ${kyiv(s.opened_at)}` : s.state === "available" ? "наступний" : "закрито"}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
              <div className="hr-muted">Екзамен і відповіді на нього зʼявляться в проході 2c.</div>
            </div>

            <div className="hr-sect" style={{ padding: "14px 0 0", marginTop: 14 }}>
              <h4>Питання тімліду</h4>
              {d.questions.length === 0 ? <div className="hr-muted">Питань не було. Кандидат ставить їх прямо з кроку навчання.</div> : d.questions.map((q) => (
                <div key={q.id} className="hr-qa">
                  <div>{q.question} <span className="hr-muted">· {kyiv(q.asked_at)}{q.material_title ? ` · крок «${q.material_title}»` : ""}</span></div>
                  {q.answer
                    ? <div className="a">{q.answer} <span className="hr-muted">— {q.answered_by ?? "тімлід"}, {kyiv(q.answered_at)}</span></div>
                    : d.canDecide && open
                      ? <div style={{ marginTop: 6 }}>
                          <textarea className="hr-inp" rows={2} style={{ width: "100%", boxSizing: "border-box" }} placeholder="Ваша відповідь" aria-label="Відповідь на питання"
                            value={answers[q.id] ?? ""} onChange={(e) => setAnswers((x) => ({ ...x, [q.id]: e.target.value }))} />
                          <button className="hr-btn xs" style={{ marginTop: 4 }} disabled={!(answers[q.id] ?? "").trim()}
                            onClick={() => void run(() => answerHiringQuestion(id, q.id, (answers[q.id] ?? "").trim()), "Відповідь збережено")}>Відповісти</button>
                        </div>
                      : <div className="hr-muted" style={{ marginTop: 4 }}>чекає відповіді тімліда</div>}
                </div>
              ))}
            </div>

            <div className="hr-sect" style={{ padding: "14px 0 0", marginTop: 14 }}>
              <h4>Історія доступу й навчання</h4>
              {d.events.length === 0 ? <div className="hr-muted">Подій ще немає.</div> : (
                <ul className="hr-hist">
                  {d.events.map((e) => <li key={e.id}><b>{kyiv(e.at)}</b> · {e.actor ?? "система"} · {e.comment ?? ""}</li>)}
                </ul>
              )}
            </div>
          </>
        )}
        {promoting && r && <PromoteDialog name={r.full_name ?? ""} done={r.done} total={r.total} onClose={() => setPromoting(false)}
          onSubmit={(c) => run(() => promoteHiringCandidate(id, c), `${r.full_name ?? "Кандидат"} — менеджер. Роль акаунта змінено`).then(() => setPromoting(false))} />}
        {refusing && r && <RefusalDialog meta={meta} candidateId={id} candidateName={r.full_name ?? ""} from={r.status}
          onClose={() => setRefusing(false)} onDone={() => { setRefusing(false); load(); onChanged(); }} onReasonsChanged={onChanged} toast={toast} />}
      </div>
    </div>,
    document.body,
  );
}

function PromoteDialog({ name, done, total, onClose, onSubmit }: { name: string; done: number; total: number; onClose: () => void; onSubmit: (comment: string) => Promise<void> }) {
  const [comment, setComment] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return createPortal(
    <div className="hr-modal-back" onClick={onClose}>
      <div className="hr-modal" role="dialog" aria-label="Перевести в менеджери" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 6px" }}>Перевести в менеджери</h3>
        <p className="hr-muted" style={{ fontSize: 13 }}>{name} пройшов(ла) {done} із {total} кроків. Акаунт отримає роль «Менеджер» і доступ до дашборда своєї команди. Скасувати можна з картки кандидата.</p>
        <textarea className="hr-inp" rows={3} style={{ width: "100%", boxSizing: "border-box" }} placeholder="Коментар (обовʼязково): чому готовий(а) до роботи" value={comment} onChange={(e) => setComment(e.target.value)} />
        {err && <div style={{ color: "var(--danger)", fontSize: 12, marginTop: 4 }}>{err}</div>}
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 10 }}>
          <button className="hr-btn" onClick={onClose}>Скасувати</button>
          <button className="hr-btn ok" disabled={busy} onClick={() => {
            if (!comment.trim()) { setErr("Напишіть коментар"); return; }
            setBusy(true); void onSubmit(comment.trim()).finally(() => setBusy(false));
          }}>Перевести</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

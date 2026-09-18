import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  fetchSecretsStatus, createSecretsLink, unlinkSecretsBot, fetchSecretPeople, fetchSecretPerson, createSecret, updateSecret,
  deleteSecret, restoreSecret, sendSecretCode, revealSecret, hiringError,
  type SecretsStatus, type SecretPerson, type SecretPersonVault, type SecretItem,
} from "../../../api";
import type { Toast } from "./HiringShared";

/**
 * 🔐 «НАЙМ → ДОСТУПИ» — сейф паролів і карток співробітників (18.09.2026, макет «Сейф доступів UTS»).
 *
 * Вкладку видно лише тим, кому сервер відповідає на /secrets/status (право `view_employee_secrets`:
 * адміни, Юля, Іван). Значення приходить лише після коду з Telegram «UTS Сейф», показується 30 с
 * і живе ТІЛЬКИ в стані цього вікна — у localStorage, URL чи журнал не потрапляє.
 */

const SERVICES: [string, string][] = [
  ["kommo", "Kommo"], ["ringostat", "Ringostat"], ["trans_eu", "trans.eu"], ["lardi", "Lardi-Trans"],
  ["della", "Della"], ["yaware", "Yaware"], ["mail", "Пошта"], ["dashboard", "Дашборд"], ["other", "Інше"],
];
const SERVICE_LABEL = Object.fromEntries(SERVICES);
const ACTION: Record<string, string> = {
  "secret.reveal": "переглянув(ла)", "secret.create": "додав(ла)", "secret.update": "змінив(ла)",
  "secret.delete": "видалив(ла)", "secret.restore": "відновив(ла)",
};
const kyiv = (iso: string | null) => (iso ? new Date(iso).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
const titleOf = (i: SecretItem) => i.kind === "card" ? `Картка •••• ${i.last4 ?? "????"}` : i.service === "other" ? (i.label ?? "Інше") : SERVICE_LABEL[i.service] ?? i.service;

export function HiringSecrets({ toast }: { toast: Toast }) {
  const [status, setStatus] = useState<SecretsStatus | null>(null);
  const [people, setPeople] = useState<SecretPerson[] | null>(null);
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchSecretsStatus().then(setStatus).catch((e) => setErr(hiringError(e)));
    fetchSecretPeople().then(setPeople).catch((e) => setErr(hiringError(e)));
  }, []);
  useEffect(load, [load]);

  const rows = useMemo(() => (people ?? []).filter((p) => !q.trim() || `${p.name} ${p.email} ${p.team_name ?? ""}`.toLowerCase().includes(q.trim().toLowerCase())), [people, q]);
  if (err) return <div className="hr-card"><div className="hr-sect" style={{ border: 0 }}><b>Сейф недоступний.</b> <span className="hr-muted">{err}</span></div></div>;
  if (!people || !status) return <p className="loading-text">Завантаження…</p>;
  const withData = people.filter((p) => p.passwords + p.cards > 0).length;

  return (
    <>
      <StatusBar status={status} onChanged={load} toast={toast} />
      <div className="hr-card">
        <div className="hd">
          <div><h3>Доступи співробітників</h3><div className="hr-muted">Логіни видно тут; пароль і повний номер картки — лише кнопкою «Показати» з кодом у Telegram «UTS Сейф». Кожен показ записується в журнал.</div></div>
          <input className="hr-inp" placeholder="Пошук: ПІБ, пошта, команда" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Пошук співробітника" style={{ minWidth: 240 }} />
        </div>
        <div className="hr-tiles" style={{ gridTemplateColumns: "repeat(3, minmax(0,1fr))" }}>
          <div className="hr-tile"><div className="lb">Співробітників</div><div className="vl">{people.length}</div><div className="sb">активні акаунти дашборда</div></div>
          <div className="hr-tile"><div className="lb">З доступами в сейфі</div><div className="vl">{withData}</div><div className="sb">без жодного запису: {people.length - withData}</div></div>
          <div className="hr-tile"><div className="lb">Записів</div><div className="vl">{people.reduce((a, p) => a + p.passwords + p.cards, 0)}</div><div className="sb">паролів {people.reduce((a, p) => a + p.passwords, 0)} · карток {people.reduce((a, p) => a + p.cards, 0)}</div></div>
        </div>
        <div className="hr-tw">
          <table className="hr-table">
            <thead><tr><th>Співробітник</th><th>Команда</th><th className="num">Паролів</th><th className="num">Карток</th><th>Остання зміна</th></tr></thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="row" onClick={() => setOpenId(p.id)}>
                  <td><b>{p.name}</b><div className="hr-muted">{p.email}</div></td>
                  <td>{p.team_name ?? <span className="hr-muted">—</span>}</td>
                  <td className="num">{p.passwords || <span className="hr-muted">0</span>}</td>
                  <td className="num">{p.cards || <span className="hr-muted">0</span>}</td>
                  <td>{p.updated_at ? kyiv(p.updated_at) : <span className="hr-muted">записів немає</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {openId != null && <PersonDrawer id={openId} status={status} toast={toast} onClose={() => { setOpenId(null); load(); }} onStatus={load} />}
    </>
  );
}

/** Ключ, бот і МОЯ привʼязка Telegram «UTS Сейф» — без неї «Показати» не спрацює. */
function StatusBar({ status, onChanged, toast }: { status: SecretsStatus; onChanged: () => void; toast: Toast }) {
  const [link, setLink] = useState<{ code: string; url: string | null; bot: string | null } | null>(null);
  const poll = useRef<number | null>(null);
  useEffect(() => () => { if (poll.current) window.clearInterval(poll.current); }, []);
  useEffect(() => { if (status.linked && poll.current) { window.clearInterval(poll.current); poll.current = null; setLink(null); toast("Telegram «UTS Сейф» привʼязано"); } }, [status.linked, toast]);

  const start = async () => {
    try {
      const r = await createSecretsLink();
      setLink({ code: r.code, url: r.url, bot: r.botUsername });
      if (r.url) window.open(r.url, "_blank", "noopener");
      if (poll.current) window.clearInterval(poll.current);
      poll.current = window.setInterval(onChanged, 3000);
    } catch (e) { toast(hiringError(e), { error: true }); }
  };

  if (!status.keyConfigured) return <div className="hr-note" style={{ background: "var(--danger-bg)", color: "var(--danger)", margin: "0 0 12px" }}>Сейф не налаштовано: на сервері немає ключа шифрування. Записи не додаються й не показуються, доки адміністратор його не додасть.</div>;
  if (!status.botConfigured) return <div className="hr-note" style={{ background: "var(--warn-bg)", color: "var(--warn)", margin: "0 0 12px" }}>Бот «UTS Сейф» ще не підключений на сервері — додавати записи можна, а «Показати» запрацює після підключення.</div>;
  if (status.linked) return (
    <div className="hr-note" style={{ margin: "0 0 12px", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
      <span>✅ Ваш Telegram привʼязано до «UTS Сейф»{status.botUsername ? ` (@${status.botUsername})` : ""} з {kyiv(status.linkedAt)} — коди приходитимуть туди.</span>
      <button className="hr-btn xs" onClick={() => { if (window.confirm("Відвʼязати Telegram від «UTS Сейф»? Без нього «Показати» не працюватиме.")) void unlinkSecretsBot().then(onChanged); }}>Відвʼязати</button>
    </div>
  );
  return (
    <div className="hr-note" style={{ background: "var(--warn-bg)", color: "var(--warn)", margin: "0 0 12px" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <b>Спершу привʼяжіть Telegram до бота «UTS Сейф»</b> — без цього код для «Показати» не прийде.
        <button className="hr-btn p" onClick={() => void start()}>Привʼязати Telegram</button>
      </div>
      {link && <div style={{ marginTop: 8, color: "var(--text)" }}>
        Відкрився чат {link.bot ? <b>@{link.bot}</b> : "бота"} — натисніть «Старт». Або надішліть боту код <b style={{ fontFamily: "ui-monospace, Menlo, monospace", letterSpacing: ".1em" }}>{link.code}</b> (діє 10 хвилин).
        {link.url && <> <a className="hr-link" href={link.url} target="_blank" rel="noopener noreferrer">Відкрити бота ↗</a></>}
      </div>}
    </div>
  );
}

function PersonDrawer({ id, status, toast, onClose, onStatus }: { id: number; status: SecretsStatus; toast: Toast; onClose: () => void; onStatus: () => void }) {
  const [v, setV] = useState<SecretPersonVault | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ item: SecretItem; value: string; left: number } | null>(null);
  const [asking, setAsking] = useState<SecretItem | null>(null);
  const [editing, setEditing] = useState<SecretItem | "new" | null>(null);

  const load = useCallback(() => { fetchSecretPerson(id).then((x) => { setV(x); setErr(null); }).catch((e) => setErr(hiringError(e))); }, [id]);
  useEffect(load, [load]);
  // Показане значення живе 30 с і зникає саме; закриття картки теж його стирає.
  useEffect(() => {
    if (!reveal) return;
    if (reveal.left <= 0) { setReveal(null); return; }
    const t = window.setTimeout(() => setReveal((r) => (r ? { ...r, left: r.left - 1 } : r)), 1000);
    return () => window.clearTimeout(t);
  }, [reveal]);

  const live = v?.items.filter((i) => !i.deleted_at) ?? [];
  const removed = v?.items.filter((i) => i.deleted_at) ?? [];
  const canShow = status.keyConfigured && status.botConfigured && status.linked;
  const showWhy = !status.keyConfigured ? "Сейф не налаштовано" : !status.botConfigured ? "Бот «UTS Сейф» не підключений" : !status.linked ? "Спершу привʼяжіть Telegram «UTS Сейф»" : undefined;

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast("Скопійовано"); } catch { toast("Не вдалося скопіювати — виділіть вручну", { error: true }); }
  };

  return createPortal(
    <div className="hr-overlay" onClick={onClose}>
      <div className="hr-drawer" role="dialog" aria-label="Доступи співробітника" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
          <div><b style={{ fontSize: 17 }}>{v?.person.name ?? "…"}</b>{v && <div className="hr-muted">{v.person.email}{v.person.team_name ? ` · ${v.person.team_name}` : ""}</div>}</div>
          <button className="hr-btn" onClick={onClose}>Закрити</button>
        </div>
        {err && <p style={{ color: "var(--danger)" }}>{err}</p>}
        {v && (
          <>
            <div className="hr-sect" style={{ padding: "14px 0 0" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <h4 style={{ margin: 0 }}>Доступи</h4>
                <button className="hr-btn xs p" disabled={!status.keyConfigured} onClick={() => setEditing("new")}>+ Додати</button>
              </div>
              {live.length === 0 ? <div className="hr-muted" style={{ marginTop: 8 }}>Записів немає. Додайте пароль до сервісу або картку для виплат.</div> : (
                <ul className="sv-list">
                  {live.map((i) => {
                    const shown = reveal?.item.id === i.id ? reveal : null;
                    return (
                      <li key={i.id}>
                        <span className="sv-ico" aria-hidden="true">{i.kind === "card" ? "₴" : (titleOf(i)[0] ?? "•").toUpperCase()}</span>
                        <span>
                          <b>{titleOf(i)}</b>
                          <div className="hr-muted">{i.login ?? (i.kind === "card" ? "картка для виплат" : "логін не вказано")}</div>
                          <div className={`sv-secret ${shown ? "open" : ""}`} aria-live="polite">{shown ? shown.value : i.kind === "card" ? `•••• •••• •••• ${i.last4 ?? ""}` : "••••••••••"}</div>
                          <div className="hr-muted" style={{ fontSize: 11.5 }}>змінено {kyiv(i.updated_at)}{i.updated_by ? ` · ${i.updated_by}` : ""}{i.versions > 1 ? ` · версій: ${i.versions}` : ""}</div>
                        </span>
                        <span className="sv-acts">
                          {shown ? (<>
                            <span className="sv-count">{shown.left} с</span>
                            <button className="hr-btn xs" onClick={() => void copy(shown.value)}>Копіювати</button>
                            <button className="hr-btn xs" onClick={() => setReveal(null)}>Сховати</button>
                          </>) : (
                            <button className="hr-btn xs p" disabled={!canShow} title={showWhy} onClick={() => setAsking(i)}>Показати</button>
                          )}
                          <button className="hr-btn xs" disabled={!status.keyConfigured} onClick={() => setEditing(i)}>Змінити</button>
                          <button className="hr-btn xs" onClick={() => void deleteSecret(i.id).then(() => { load(); toast(`«${titleOf(i)}» видалено`, { action: { label: "Відновити", run: () => void restoreSecret(i.id).then(load) } }); }).catch((e) => toast(hiringError(e), { error: true }))}>Видалити</button>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              {!canShow && showWhy && <div className="hr-muted" style={{ marginTop: 6 }}>«Показати» недоступне: {showWhy.toLowerCase()}.</div>}
            </div>

            {removed.length > 0 && (
              <div className="hr-sect" style={{ padding: "14px 0 0", marginTop: 14 }}>
                <h4>Видалені</h4>
                <ul className="hr-hist">{removed.map((i) => <li key={i.id}>{titleOf(i)} · видалено {kyiv(i.deleted_at)} <button className="hr-btn xs" onClick={() => void restoreSecret(i.id).then(load).catch((e) => toast(hiringError(e), { error: true }))}>Відновити</button></li>)}</ul>
              </div>
            )}

            <div className="hr-sect" style={{ padding: "14px 0 0", marginTop: 14 }}>
              <h4>Журнал</h4>
              {v.journal.length === 0 ? <div className="hr-muted">Подій ще немає.</div> : (
                <ul className="hr-hist">
                  {v.journal.map((j) => <li key={j.id} style={j.action === "secret.reveal" ? { color: "var(--text)" } : undefined}><b>{kyiv(j.at)}</b> · {j.actor ?? "—"} {ACTION[j.action] ?? j.action}{j.service ? ` · ${j.service}` : ""}{j.reason ? <span className="hr-muted"> · {j.reason}</span> : null}</li>)}
                </ul>
              )}
            </div>
          </>
        )}
        {asking && <RevealDialog item={asking} whose={v?.person.name ?? ""} onClose={() => setAsking(null)} onNeedLink={() => { setAsking(null); onStatus(); }}
          onShown={(value) => { setReveal({ item: asking, value, left: 30 }); setAsking(null); load(); }} />}
        {editing && <EditDialog item={editing === "new" ? null : editing} userId={id} onClose={() => setEditing(null)}
          onSaved={(msg) => { setEditing(null); load(); toast(msg); }} />}
      </div>
    </div>,
    document.body,
  );
}

function RevealDialog({ item, whose, onClose, onShown, onNeedLink }: { item: SecretItem; whose: string; onClose: () => void; onShown: (v: string) => void; onNeedLink: () => void }) {
  const [code, setCode] = useState("");
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const send = useCallback(async () => {
    setBusy(true); setMsg(null);
    try { await sendSecretCode(item.id); setSent(true); }
    catch (e) {
      const d = (e as { response?: { data?: { needLink?: boolean } } }).response?.data;
      if (d?.needLink) { onNeedLink(); return; }
      setMsg(hiringError(e));
    }
    setBusy(false);
  }, [item.id, onNeedLink]);
  useEffect(() => { void send(); }, [send]);
  const submit = async () => {
    if (!/^\d{6}$/.test(code.trim())) { setMsg("Введіть 6 цифр коду з Telegram"); return; }
    setBusy(true); setMsg(null);
    try { const r = await revealSecret(item.id, code.trim(), reason.trim()); onShown(r.value); }
    catch (e) { setMsg(hiringError(e)); setBusy(false); }
  };
  return createPortal(
    <div className="hr-modal-back" onClick={onClose}>
      <div className="hr-modal" role="dialog" aria-label="Показати доступ" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 4px" }}>Показати: {titleOf(item)}</h3>
        <p className="hr-muted" style={{ fontSize: 13, margin: "0 0 10px" }}>{whose} · показ запишеться в журнал.</p>
        <div className="hr-note" style={{ marginTop: 0 }}>{sent ? "Код надіслано в Telegram «UTS Сейф». Діє 5 хвилин, 3 спроби." : busy ? "Надсилаю код…" : "Код ще не надіслано."}</div>
        <input className="hr-inp sv-code" inputMode="numeric" maxLength={6} autoFocus placeholder="000000" aria-label="Код із Telegram"
          value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} />
        <input className="hr-inp" style={{ width: "100%", boxSizing: "border-box", marginTop: 8 }} placeholder="Навіщо (необовʼязково): напр. видача ноутбука" aria-label="Причина"
          value={reason} onChange={(e) => setReason(e.target.value)} />
        {msg && <div style={{ color: "var(--danger)", fontSize: 12.5, marginTop: 6 }}>{msg}</div>}
        <div style={{ display: "flex", gap: 6, justifyContent: "space-between", marginTop: 12, flexWrap: "wrap" }}>
          <button className="hr-btn xs" disabled={busy} onClick={() => void send()}>Надіслати код ще раз</button>
          <span style={{ display: "flex", gap: 6 }}>
            <button className="hr-btn" onClick={onClose}>Скасувати</button>
            <button className="hr-btn p" disabled={busy || !sent} onClick={() => void submit()}>Показати</button>
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function EditDialog({ item, userId, onClose, onSaved }: { item: SecretItem | null; userId: number; onClose: () => void; onSaved: (msg: string) => void }) {
  const [kind, setKind] = useState<"password" | "card">(item?.kind ?? "password");
  const [service, setService] = useState(item?.service ?? "kommo");
  const [label, setLabel] = useState(item?.label ?? "");
  const [login, setLogin] = useState(item?.login ?? "");
  const [value, setValue] = useState("");
  const [see, setSee] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      if (item) {
        await updateSecret(item.id, { login: kind === "password" ? login : undefined, value: value || undefined });
        onSaved(value ? `«${titleOf(item)}»: нове значення збережено, попереднє — в історії` : "Логін змінено");
      } else {
        if (!value) { setMsg(kind === "card" ? "Введіть номер картки" : "Введіть пароль"); setBusy(false); return; }
        await createSecret(userId, kind === "card" ? { kind, value } : { kind, service, label: service === "other" ? label : undefined, login, value });
        onSaved("Збережено в сейфі");
      }
    } catch (e) { setMsg(hiringError(e)); setBusy(false); }
  };
  return createPortal(
    <div className="hr-modal-back" onClick={onClose}>
      <div className="hr-modal" role="dialog" aria-label={item ? "Змінити доступ" : "Додати доступ"} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 10px" }}>{item ? `Змінити: ${titleOf(item)}` : "Додати в сейф"}</h3>
        {!item && (
          <div className="hr-seg2" style={{ marginBottom: 10 }}>
            <button className={kind === "password" ? "on" : ""} onClick={() => setKind("password")}>Пароль до сервісу</button>
            <button className={kind === "card" ? "on" : ""} onClick={() => setKind("card")}>Картка для виплат</button>
          </div>
        )}
        <div style={{ display: "grid", gap: 8 }}>
          {kind === "password" && !item && (
            <select className="hr-inp" value={service} onChange={(e) => setService(e.target.value)} aria-label="Сервіс">
              {SERVICES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          )}
          {kind === "password" && !item && service === "other" && <input className="hr-inp" placeholder="Назва сервісу" value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Назва сервісу" />}
          {kind === "password" && <input className="hr-inp" placeholder="Логін (видно всім із правом сейфу)" value={login} onChange={(e) => setLogin(e.target.value)} aria-label="Логін" autoComplete="off" />}
          <div style={{ display: "flex", gap: 6 }}>
            <input className="hr-inp" style={{ flex: 1 }} type={see ? "text" : "password"} autoComplete="new-password" aria-label={kind === "card" ? "Номер картки" : "Пароль"}
              placeholder={item ? (kind === "card" ? "Новий номер картки (порожньо — не міняти)" : "Новий пароль (порожньо — не міняти)") : kind === "card" ? "Номер картки" : "Пароль"}
              value={value} onChange={(e) => setValue(e.target.value)} />
            <button className="hr-btn xs" type="button" onClick={() => setSee((x) => !x)}>{see ? "Сховати" : "Показати"}</button>
          </div>
          <div className="hr-muted" style={{ fontSize: 12 }}>Значення шифрується одразу. Після збереження його можна побачити лише через «Показати» з кодом.</div>
        </div>
        {msg && <div style={{ color: "var(--danger)", fontSize: 12.5, marginTop: 6 }}>{msg}</div>}
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 12 }}>
          <button className="hr-btn" onClick={onClose}>Скасувати</button>
          <button className="hr-btn p" disabled={busy} onClick={() => void save()}>Зберегти</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

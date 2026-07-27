import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchBankAccounts, fetchBankIncoming, fetchBankOutgoing, saveBankAccount, fetchBankBalances,
  fetchBankHiddenPayees, addBankHiddenPayee, deleteBankHiddenPayee,
  type BankAccount, type BankSummary, type BankTx, type BankHiddenPayee, type BankBalance,
} from "../../../api";
import { getAuthPayload } from "../../../auth";
import { usePolling } from "../../../hooks/usePolling";
import { InfoHint } from "../widgets";

const RED = "#c8102e", MUTED = "var(--text-muted)";
const err = (e: unknown) => (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "Помилка";
const roleName: Record<string, string> = { admin: "адмін", kvp: "КВП", team_lead: "тімлід", manager: "менеджер" };
// колір бейджа рахунку по company
const ACC_COLOR: Record<string, { bg: string; fg: string; short: string }> = {
  uts: { bg: "rgba(47,111,219,0.14)", fg: "#2f6fdb", short: "ЮТС" },
  automuv: { bg: "rgba(124,58,237,0.14)", fg: "#7c3aed", short: "АМ" },
  fop_privat: { bg: "rgba(22,163,74,0.14)", fg: "#16a34a", short: "ФОП·П" },
  fop_mono: { bg: "rgba(217,119,6,0.14)", fg: "#d97706", short: "ФОП·М" },
};
const fmtUah = (n: number) => {
  const a = Math.abs(n);
  const s = a >= 1e6 ? (n / 1e6).toFixed(2) + " млн" : a >= 1e3 ? Math.round(n).toLocaleString("uk-UA").replace(/,/g, " ") : String(Math.round(n));
  return s + " ₴";
};
const fmtAmt = (amount: string, ccy: string) => {
  const n = Number(amount);
  const s = Math.abs(n).toLocaleString("uk-UA", { minimumFractionDigits: ccy === "UAH" ? 0 : 2, maximumFractionDigits: 2 }).replace(/,/g, " ");
  return ccy === "UAH" ? s : `${s} ${ccy}`;
};
const shortDate = (iso: string) => { const d = new Date(iso); const p = (x: number) => String(x).padStart(2, "0"); return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const MONTHS = ["січ", "лют", "бер", "кві", "тра", "чер", "лип", "сер", "вер", "жов", "лис", "гру"];
function AccBadge({ company }: { company: string }) {
  const c = ACC_COLOR[company] ?? { bg: "var(--hover-bg)", fg: "var(--text)", short: company };
  return <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 7, background: c.bg, color: c.fg, whiteSpace: "nowrap" }}>{c.short}</span>;
}

export default function BankSection() {
  const auth = useMemo(() => getAuthPayload(), []);
  const perms = auth?.perms ?? [];
  const canManageAccounts = perms.includes("manage_bank_accounts");
  const canManageHidden = perms.includes("manage_bank_hidden");
  const canSeeHidden = perms.includes("view_hidden_payments");
  const canViewBalances = perms.includes("view_balances");
  const [balancesOpen, setBalancesOpen] = useState(false);

  const PAGE = 100;
  const [mode, setMode] = useState<"in" | "out" | "receivables">("in");
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [accFilter, setAccFilter] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const [ccy, setCcy] = useState("");
  const [rows, setRows] = useState<BankTx[]>([]);
  const [summary, setSummary] = useState<BankSummary | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // діапазон дат керує ЛИШЕ підсумками; таблиця гортається по всій утриманій історії. Дефолт — місяць.
  const [range, setRange] = useState(() => { const to = new Date(); const from = new Date(); from.setDate(to.getDate() - 29); return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) }; });

  const loadAccounts = () => fetchBankAccounts().then(setAccounts).catch(() => setAccounts([]));
  useEffect(() => { loadAccounts(); }, []);

  const filters = useMemo(() => ({ from: range.from, to: range.to, account: accFilter ?? undefined, currency: ccy || undefined, q: q || undefined }), [range.from, range.to, accFilter, ccy, q]);
  const feedFn = mode === "in" ? fetchBankIncoming : fetchBankOutgoing;

  // Перша сторінка (скидання): підсумки за період + перша порція історії.
  const loadFirst = useCallback(() => {
    if (mode === "receivables") { setRows([]); setSummary(null); setCursor(null); setHasMore(false); setLoading(false); return; }
    setLoading(true);
    feedFn({ ...filters, limit: PAGE }).then((d) => {
      setRows(d.rows); setSummary(d.summary ?? null);
      setCursor(d.nextCursor); setHasMore(!!d.nextCursor);
    }).catch(() => { setRows([]); setSummary(null); setCursor(null); setHasMore(false); }).finally(() => setLoading(false));
  }, [mode, feedFn, filters]);
  useEffect(() => { loadFirst(); }, [loadFirst]);

  // Довантаження наступної сторінки (keyset-курсор) — append донизу.
  const loadMore = useCallback(() => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    feedFn({ ...filters, cursor, limit: PAGE }).then((d) => {
      setRows((prev) => { const seen = new Set(prev.map((r) => r.id)); return [...prev, ...d.rows.filter((r) => !seen.has(r.id))]; });
      setCursor(d.nextCursor); setHasMore(!!d.nextCursor);
    }).catch(() => setHasMore(false)).finally(() => setLoadingMore(false));
  }, [cursor, loadingMore, feedFn, filters]);

  // Полінг: перечитує ПЕРШУ сторінку, доклеює лише нові рядки згори (overflow-anchor тримає скрол).
  usePolling(useCallback(() => {
    if (mode === "receivables") return;
    feedFn({ ...filters, limit: PAGE }).then((d) => {
      if (d.summary) setSummary(d.summary);
      setRows((prev) => { const seen = new Set(prev.map((r) => r.id)); const fresh = d.rows.filter((r) => !seen.has(r.id)); return fresh.length ? [...fresh, ...prev] : prev; });
    }).catch(() => {});
  }, [mode, feedFn, filters]), 30000);

  // Infinite scroll: спостерігач за сентинелем внизу списку.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver((entries) => { if (entries[0]?.isIntersecting) loadMore(); }, { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadMore]);

  const shiftRange = (dir: number) => setRange((r) => {
    const from = new Date(r.from), to = new Date(r.to);
    const len = Math.round((+to - +from) / 86400000) + 1;
    from.setDate(from.getDate() + dir * len); to.setDate(to.getDate() + dir * len);
    return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
  });
  const rangeLabel = (() => { const f = new Date(range.from), t = new Date(range.to); return `${f.getDate()}–${t.getDate()} ${MONTHS[t.getMonth()]} ${t.getFullYear()}`; })();

  const active = accounts.filter((a) => a.is_active);
  const byCo = summary?.byCompany ?? {};
  const fopSum = (byCo.fop_privat ?? 0) + (byCo.fop_mono ?? 0);
  const currencies = [...new Set([...(accounts.map((a) => a.currency)), ...rows.map((r) => r.currency)])];

  return (
    <div>
      <div className="page-header" style={{ marginBottom: 4 }}>
        <h1 className="page-title">💳 Виписки · надходження та платежі</h1>
      </div>
      <p style={{ color: MUTED, fontSize: 13.5, lineHeight: 1.5, marginTop: 0, maxWidth: 1000 }}>
        Реальні дані з банківських API компаній (ТОВ ЮТС, ТОВ Автомув, ФОП Беспятчук). <b>Виписку бачать усі.</b> Вхідні — повністю для всіх.
        Вихідні теж для всіх, ОКРІМ отримувачів зі списку «прихованих» — їхні вихідні платежі бачить <b>лише адмін</b>. Джерело — банк (не CRM), оновлення ~15 хв.
      </p>

      {/* Панель керування */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", margin: "12px 0 16px" }}>
        <div style={{ display: "inline-flex", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
          {([["in", "📥 Вхідні"], ["out", "📤 Вихідні"], ["receivables", "📊 Дебіторка"]] as const).map(([m, lbl]) => (
            <button key={m} onClick={() => setMode(m)} style={{ fontSize: 13.5, fontWeight: 700, padding: "8px 14px", cursor: "pointer", border: "none", background: mode === m ? "#1f2330" : "var(--card-bg)", color: mode === m ? "#fff" : "var(--text)" }}>{lbl}</button>
          ))}
        </div>
        <div style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
          <Chip on={accFilter === null} onClick={() => setAccFilter(null)}>Усі рахунки</Chip>
          {active.map((a) => <Chip key={a.id} on={accFilter === a.id} onClick={() => setAccFilter(a.id)}>{a.label}</Chip>)}
        </div>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 4, border: "1px solid var(--border)", borderRadius: 9, padding: "4px 6px" }}>
          <button onClick={() => shiftRange(-1)} style={arrowBtn}>◀</button>
          <span style={{ fontSize: 13, fontWeight: 700, minWidth: 120, textAlign: "center" }}>{rangeLabel}</span>
          <button onClick={() => shiftRange(1)} style={arrowBtn}>▶</button>
        </div>
        {canViewBalances && (
          <button onClick={() => setBalancesOpen(true)} style={{ marginLeft: "auto", padding: "8px 14px", borderRadius: 10, border: "1px solid " + RED, background: "rgba(200,16,46,0.06)", color: RED, fontWeight: 700, fontSize: 13.5, cursor: "pointer" }}>💰 Баланси</button>
        )}
        <span style={{ marginLeft: canViewBalances ? 0 : "auto", fontSize: 12.5, color: MUTED }}>Ти: <b style={{ color: "var(--text)" }}>{roleName[auth?.role ?? ""] ?? auth?.roleKey ?? "—"}</b> · {canSeeHidden ? "бачиш усе" : "без прихованих"}</span>
      </div>
      {balancesOpen && canViewBalances && <BalancesModal onClose={() => setBalancesOpen(false)} />}

      {mode === "receivables" ? (
        <div className="chart-card" style={{ textAlign: "center", padding: "48px 20px", color: MUTED }}>
          <div style={{ fontSize: 34, marginBottom: 8 }}>🚧</div>
          <b style={{ fontSize: 16, color: "var(--text)" }}>Дебіторка по компаніях — скоро</b>
          <p style={{ maxWidth: 560, margin: "8px auto 0", fontSize: 13.5 }}>Реальний розріз по юрособах (ЮТС / Автомув / ФОП) буде, коли заведемо ознаку юрособи в джерелі. Без вигаданих цифр.</p>
        </div>
      ) : (
        <>
          {/* Стрип підсумків (UAH) */}
          <div className="chart-card" style={{ display: "flex", gap: 26, flexWrap: "wrap", alignItems: "center", padding: "16px 20px" }}>
            <Stat big label={mode === "in" ? "надійшло за період" : "виплачено за період"} value={fmtUah(summary?.total ?? 0)} hint="Σ у гривні за ВИБРАНИЙ ПЕРІОД (валютні конвертовано за курсом банку/НБУ). Таблиця нижче гортається по всій історії." />
            <Stat label="транзакцій за період" value={String(summary?.count ?? 0)} hint="Кількість транзакцій за вибраний період. Таблиця показує всю утриману історію." />
            <Stat label="ТОВ ЮТС" value={fmtUah(byCo.uts ?? 0)} hint="Σ по рахунку ТОВ ЮТС за період, UAH. Джерело — банк." />
            <Stat label="ТОВ Автомув" value={fmtUah(byCo.automuv ?? 0)} hint="Σ по рахунку ТОВ Автомув за період, UAH. Джерело — банк." />
            <Stat label="ФОП Беспятчук" value={fmtUah(fopSum)} hint="Σ по рахунках ФОП (Приват+Моно) за період, UAH. Джерело — банк." />
            <Stat label="найбільший платіж" value={fmtUah(summary?.maxPayment ?? 0)} hint="Найбільша транзакція за період, UAH." />
            {(canManageAccounts || canManageHidden) && (
              <button onClick={() => setSettingsOpen((v) => !v)} style={{ marginLeft: "auto", padding: "9px 15px", borderRadius: 9, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", cursor: "pointer", fontWeight: 700 }}>⚙️ Налаштування виписки</button>
            )}
          </div>

          {/* Таблиця */}
          <div className="chart-card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
              <h2 className="chart-title" style={{ marginBottom: 0 }}>{mode === "in" ? "📥 Вхідні надходження" : "📤 Вихідні платежі"}</h2>
              <span style={{ fontSize: 12.5, color: MUTED }}>{mode === "in" ? "видно всім" : canSeeHidden ? "адмін-вигляд: 🔒 приховані позначені" : "приховані отримувачі відсутні (лише адмін)"} · дані з банку, оновлення ~15 хв</span>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="🔎 контрагент / підстава / ID" style={{ ...inp, width: 240 }} />
              <select value={accFilter ?? ""} onChange={(e) => setAccFilter(e.target.value ? Number(e.target.value) : null)} style={inp}><option value="">Рахунок: усі</option>{active.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select>
              <select value={ccy} onChange={(e) => setCcy(e.target.value)} style={inp}><option value="">Валюта: усі</option>{currencies.map((c) => <option key={c} value={c}>{c}</option>)}</select>
            </div>
            {loading ? <p className="loading-text">Завантаження…</p> : rows.length === 0 ? <p className="loading-text">Немає транзакцій в утриманій історії.</p> : (
              <table className="data-table">
                <thead><tr><th>Дата · час</th><th>Рахунок</th><th>{mode === "in" ? "Контрагент (платник)" : "Отримувач"}</th><th>Підстава</th><th>Сума</th><th>UAH</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} style={{ background: r.hidden ? "rgba(217,119,6,0.09)" : r.unmatched_account ? "rgba(220,38,38,0.06)" : undefined, borderLeft: r.unmatched_account ? "3px solid #dc2626" : undefined }}>
                      <td style={{ whiteSpace: "nowrap" }}>{shortDate(r.booked_at)}</td>
                      <td><AccBadge company={r.company} />{r.unmatched_account && <span title="нерозпізнаний рахунок" style={{ marginLeft: 6, color: "#dc2626", fontSize: 11 }}>⚠</span>}</td>
                      <td>{r.counterparty_name ?? "—"} {r.hidden && <span title="лише адмін" style={{ fontSize: 10.5, fontWeight: 700, padding: "1px 6px", borderRadius: 6, background: "rgba(217,119,6,0.18)", color: "#b45309" }}>🔒 лише адмін</span>}</td>
                      <td style={{ color: MUTED, fontSize: 12.5 }}>{r.purpose ?? "—"}</td>
                      <td style={{ whiteSpace: "nowrap", fontWeight: 600 }}>{fmtAmt(r.amount, r.currency)}</td>
                      <td style={{ whiteSpace: "nowrap", fontWeight: 700, color: mode === "in" ? "#16a34a" : "#dc2626" }}>{mode === "in" ? "" : "−"}{Math.abs(Number(r.amount_uah)).toLocaleString("uk-UA").replace(/,/g, " ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {/* сентинель infinite-scroll + індикатор довантаження / кінець історії */}
            {!loading && rows.length > 0 && (
              <div ref={sentinelRef} style={{ textAlign: "center", padding: "12px 0 2px", color: MUTED, fontSize: 12.5 }}>
                {loadingMore ? "Завантаження ще…" : hasMore ? "Гортай нижче — довантажиться ще" : `Кінець історії · показано ${rows.length} транзакцій`}
              </div>
            )}
            {mode === "out" && !canSeeHidden && <p style={{ fontSize: 12, color: MUTED, marginTop: 10 }}>👁 У вашому вигляді приховані отримувачі <b>повністю відсутні</b> (їх нема ні в списку, ні в підсумках) — сервер їх не віддає на КОЖНІЙ сторінці.</p>}
          </div>
        </>
      )}

      {settingsOpen && (canManageAccounts || canManageHidden) && (
        <SettingsBlock accounts={accounts} canAccounts={canManageAccounts} canHidden={canManageHidden} onAccountsChange={loadAccounts} />
      )}
    </div>
  );
}

// ─────────────────────────── Налаштування виписки ───────────────────────────
function SettingsBlock({ accounts, canAccounts, canHidden, onAccountsChange }: { accounts: BankAccount[]; canAccounts: boolean; canHidden: boolean; onAccountsChange: () => void }) {
  return (
    <>
      {canAccounts && <AccountsBlock accounts={accounts} onChange={onAccountsChange} />}
      {canHidden && <HiddenBlock />}
    </>
  );
}

function AccountsBlock({ accounts, onChange }: { accounts: BankAccount[]; onChange: () => void }) {
  const [editId, setEditId] = useState<number | null>(null);
  const [draft, setDraft] = useState<Partial<BankAccount>>({});
  const [msg, setMsg] = useState("");
  const startEdit = (a: BankAccount) => { setEditId(a.id); setDraft({ ...a }); };
  const save = async () => {
    try { await saveBankAccount(editId, { legalName: draft.legal_name ?? undefined, edrpouIpn: draft.edrpou_ipn ?? undefined, iban: draft.iban ?? undefined, bankName: draft.bank_name ?? undefined, mfo: draft.mfo ?? undefined, purpose: draft.purpose ?? undefined } as never); setEditId(null); await onChange(); setMsg("✓ Збережено"); }
    catch (e) { setMsg("✗ " + err(e)); }
  };
  const toggleActive = async (a: BankAccount) => { try { await saveBankAccount(a.id, { isActive: !a.is_active } as never); await onChange(); } catch (e) { alert(err(e)); } };
  return (
    <div className="chart-card" style={{ marginTop: 16 }}>
      <h2 className="chart-title">⚙️ Налаштування виписки · Реквізити компаній</h2>
      <p style={{ fontSize: 12.5, color: MUTED, marginTop: -4 }}>Активні реквізити — які компанії/рахунки підключені. 🔑 API-ключ кожного рахунку зберігається лише в серверному env (не в базі й не в інтерфейсі) — тут видно лише, підключений він (API ✓) чи ні. «Вимкнути» ховає рахунок з виписки, історію лишає.</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(340px,1fr))", gap: 14 }}>
        {accounts.map((a) => (
          <div key={a.id} style={{ border: "1px solid var(--border)", borderRadius: 14, padding: 16, opacity: a.is_active ? 1 : 0.6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
              <AccBadge company={a.company} />
              <b style={{ fontSize: 15 }}>{a.legal_name ?? a.label}</b>
              <span style={{ fontSize: 11.5, fontWeight: 700, padding: "2px 8px", borderRadius: 999, background: a.api_connected ? "rgba(22,163,74,0.14)" : "rgba(220,38,38,0.12)", color: a.api_connected ? "#16a34a" : "#dc2626" }}>API {a.api_connected ? "✓" : "✗"}</span>
              <label style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, cursor: "pointer" }}>
                <input type="checkbox" checked={a.is_active} onChange={() => toggleActive(a)} /> {a.is_active ? "активна" : "вимкнена"}
              </label>
            </div>
            {editId === a.id ? (
              <div style={{ display: "grid", gap: 8 }}>
                {([["legal_name", "Юр. назва"], ["edrpou_ipn", "ЄДРПОУ / ІПН"], ["iban", "IBAN"], ["bank_name", "Банк"], ["mfo", "МФО"], ["purpose", "Призначення"]] as const).map(([k, lbl]) => (
                  <label key={k} style={{ fontSize: 12 }}>{lbl}<input value={(draft[k] as string) ?? ""} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} style={{ ...inp, width: "100%", boxSizing: "border-box", marginTop: 2 }} /></label>
                ))}
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={save} style={{ padding: "7px 14px", borderRadius: 8, border: "none", background: "#16a34a", color: "#fff", fontWeight: 700, cursor: "pointer" }}>Зберегти</button>
                  <button onClick={() => setEditId(null)} style={{ padding: "7px 14px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: MUTED, cursor: "pointer" }}>Скасувати</button>
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 13, lineHeight: 1.9 }}>
                <Req label="ЄДРПОУ/ІПН" v={a.edrpou_ipn} /><Req label="IBAN" v={a.iban} /><Req label="Банк · МФО" v={a.bank_name ? `${a.bank_name}${a.mfo ? " · " + a.mfo : ""}` : null} /><Req label="Призначення" v={a.purpose} />
                <button onClick={() => startEdit(a)} style={{ marginTop: 8, padding: "5px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "#2f6fdb", cursor: "pointer", fontSize: 12.5 }}>✎ Редагувати</button>
              </div>
            )}
          </div>
        ))}
      </div>
      {msg && <div style={{ fontSize: 13, marginTop: 10, color: msg.startsWith("✓") ? "#16a34a" : "#dc2626" }}>{msg}</div>}
      <p style={{ fontSize: 12, color: MUTED, marginTop: 12 }}>🔑 Щоб додати рахунок — задай назву env-змінної з ключем (напр. <code>PRIVAT_TOKEN_UTS</code>) у серверному оточенні; поля для самого ключа тут навмисно немає.</p>
    </div>
  );
}
function Req({ label, v }: { label: string; v: string | null }) { return <div><span style={{ color: MUTED, display: "inline-block", minWidth: 110 }}>{label}</span><b>{v ?? "—"}</b></div>; }

function HiddenBlock() {
  const [payees, setPayees] = useState<BankHiddenPayee[]>([]);
  const [pattern, setPattern] = useState(""), [mt, setMt] = useState<"exact" | "glob">("exact");
  const load = () => fetchBankHiddenPayees().then(setPayees).catch(() => setPayees([]));
  useEffect(() => { load(); }, []);
  const add = async () => { if (!pattern.trim()) return; try { await addBankHiddenPayee(pattern.trim(), mt); setPattern(""); await load(); } catch (e) { alert(err(e)); } };
  const del = async (id: number) => { try { await deleteBankHiddenPayee(id); await load(); } catch (e) { alert(err(e)); } };
  return (
    <div className="chart-card" style={{ marginTop: 16 }}>
      <h2 className="chart-title">🙈 Приховані отримувачі <span style={{ fontSize: 12, fontWeight: 400, color: MUTED }}>(їхні вихідні бачить лише адмін)</span></h2>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {payees.map((p) => (
          <span key={p.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 650, padding: "5px 10px", borderRadius: 999, background: "rgba(217,119,6,0.1)", border: "1px solid rgba(217,119,6,0.3)" }}>
            {p.match_type === "glob" ? "＊" : ""}{p.pattern} <button onClick={() => del(p.id)} style={{ border: "none", background: "none", cursor: "pointer", color: MUTED }}>✕</button>
          </span>
        ))}
        <input value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="назва або *шаблон*" style={{ ...inp, width: 200 }} />
        <select value={mt} onChange={(e) => setMt(e.target.value as "exact" | "glob")} style={inp}><option value="exact">точна</option><option value="glob">шаблон (*)</option></select>
        <button onClick={add} style={{ padding: "7px 14px", borderRadius: 8, border: "1px dashed " + RED, background: "transparent", color: RED, fontWeight: 700, cursor: "pointer" }}>＋ Додати отримувача / шаблон</button>
      </div>
    </div>
  );
}

// ─────────────────────────── Баланси рахунків (лише view_balances) ───────────────────────────
function BalancesModal({ onClose }: { onClose: () => void }) {
  const [balances, setBalances] = useState<BankBalance[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { fetchBankBalances().then(setBalances).catch((e) => setError(err(e))); }, []);
  const fmtBal = (amt: string | null, ccy: string | null) => {
    if (amt == null) return "—";
    const n = Number(amt);
    if (!Number.isFinite(n)) return "—";
    const [int, dec] = Math.abs(n).toFixed(2).split(".");
    const grp = int.replace(/\B(?=(\d{3})+(?!\d))/g, " "); // групування пробілом
    return `${n < 0 ? "−" : ""}${grp},${dec} ${ccy ?? "UAH"}`;
  };
  const upd = (iso: string | null) => { if (!iso) return "—"; const d = new Date(iso); const p = (x: number) => String(x).padStart(2, "0"); return `оновлено ${p(d.getHours())}:${p(d.getMinutes())}`; };
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} className="chart-card" style={{ maxWidth: 520, width: "100%", maxHeight: "84vh", overflowY: "auto", margin: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <h2 className="chart-title" style={{ marginBottom: 0 }}>💰 Баланси рахунків</h2>
          <button onClick={onClose} style={{ border: "none", background: "none", cursor: "pointer", fontSize: 20, color: MUTED }}>✕</button>
        </div>
        <p style={{ fontSize: 12.5, color: MUTED, marginTop: 0 }}>Поточний залишок по кожному активному рахунку. Джерело — банк-API (mono client-info / privat closing-balance), оновлюється на синку. «—» = ключ/доступ відсутній.</p>
        {error ? <p style={{ color: "#dc2626", fontSize: 13 }}>{error}</p> : !balances ? <p className="loading-text">Завантаження…</p> : (
          <div style={{ display: "grid", gap: 10 }}>
            {balances.map((b) => (
              <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 12, border: "1px solid var(--border)", borderRadius: 12, padding: "12px 14px" }}>
                <AccBadge company={b.company} />
                <b style={{ fontSize: 14 }}>{b.label}</b>
                <div style={{ marginLeft: "auto", textAlign: "right" }}>
                  <div style={{ fontSize: 17, fontWeight: 800, color: b.balance_amount == null ? MUTED : "#16a34a" }}>{fmtBal(b.balance_amount, b.balance_currency)}</div>
                  <div style={{ fontSize: 11, color: MUTED }}>{upd(b.balance_updated_at)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────── дрібні ───────────────────────────
const inp: React.CSSProperties = { padding: "7px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", fontSize: 13 };
const arrowBtn: React.CSSProperties = { border: "none", background: "none", cursor: "pointer", fontSize: 13, color: "var(--text)", padding: "2px 6px" };
function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button onClick={onClick} style={{ fontSize: 12.5, fontWeight: 700, padding: "7px 12px", borderRadius: 20, cursor: "pointer", border: "1px solid " + (on ? "#2f6fdb" : "var(--border)"), background: on ? "rgba(47,111,219,0.1)" : "var(--card-bg)", color: on ? "#2f6fdb" : "var(--text)" }}>{children}</button>;
}
function Stat({ label, value, hint, big }: { label: string; value: string; hint: string; big?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: big ? 22 : 18, fontWeight: 800, color: big ? "#16a34a" : "var(--text)" }}>{value}</div>
      <div style={{ fontSize: 11.5, color: MUTED, display: "inline-flex", alignItems: "center", gap: 3 }}>{label} <InfoHint text={hint} /></div>
    </div>
  );
}

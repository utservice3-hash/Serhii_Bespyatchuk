import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchBankAccounts, fetchBankIncoming, fetchBankOutgoing, saveBankAccount, fetchBankBalances, fetchBankRequisites, fetchBankCashflow,
  fetchBankHiddenPayees, addBankHiddenPayee, deleteBankHiddenPayee,
  type BankAccount, type BankSummary, type BankTx, type BankHiddenPayee, type BankBalance, type BankRequisite, type CashflowMonth,
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
// детерміноване групування пробілом (без locale/.replace(/,/g) — там була помилка з комою)
const fmtUah = (n: number) => {
  const a = Math.abs(n);
  if (a >= 1e6) return (a / 1e6).toFixed(2).replace(".", ",") + " млн ₴";
  return String(Math.round(a)).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " ₴";
};
// групування пробілом + кома як десятковий; десяткові показуємо, коли forceDec або є копійки
const fmtMoney = (n: number, forceDec = false) => {
  const [int, dec] = Math.abs(n).toFixed(2).split(".");
  const grp = int.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return forceDec || dec !== "00" ? `${grp},${dec}` : grp;
};
const MONTHS = ["січ", "лют", "бер", "кві", "тра", "чер", "лип", "сер", "вер", "жов", "лис", "гру"];
function AccBadge({ company }: { company: string }) {
  const c = ACC_COLOR[company] ?? { bg: "var(--hover-bg)", fg: "var(--text)", short: company };
  return <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 7, background: c.bg, color: c.fg, whiteSpace: "nowrap" }}>{c.short}</span>;
}

// Двохрядковий запис: зліва дата·час стовпчиком; рядок1 — контрагент жирним + сума справа
// (UAH-екв. лише для валютних); рядок2 приглушено — рахунок-бейдж · підстава (ellipsis + title).
function TxRow({ r, mode }: { r: BankTx; mode: "in" | "out" }) {
  const inMode = mode === "in";
  const color = inMode ? "#16a34a" : "#dc2626";
  const sign = inMode ? "" : "−";
  const isUah = (r.currency ?? "UAH") === "UAH";
  const d = new Date(r.booked_at);
  const p = (x: number) => String(x).padStart(2, "0");
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12, padding: "10px 4px",
      borderBottom: "1px solid var(--border)",
      background: r.hidden ? "rgba(217,119,6,0.07)" : r.unmatched_account ? "rgba(220,38,38,0.05)" : undefined,
      borderLeft: r.unmatched_account ? "3px solid #dc2626" : "3px solid transparent",
    }}>
      <div style={{ width: 50, flexShrink: 0, textAlign: "center", lineHeight: 1.15 }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>{p(d.getDate())}.{p(d.getMonth() + 1)}</div>
        <div style={{ fontSize: 11, color: MUTED }}>{p(d.getHours())}:{p(d.getMinutes())}</div>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "baseline", gap: 6 }}>
            <span style={{ fontWeight: 700, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.counterparty_name ?? "—"}</span>
            {r.hidden && <span title="лише адмін" style={{ flexShrink: 0, fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 6, background: "rgba(217,119,6,0.18)", color: "#b45309", whiteSpace: "nowrap" }}>🔒 лише адмін</span>}
          </div>
          <div style={{ flexShrink: 0, textAlign: "right" }}>
            <div style={{ fontWeight: 800, fontSize: 14.5, color, whiteSpace: "nowrap" }}>{sign}{fmtMoney(Number(r.amount), !isUah)} {isUah ? "₴" : r.currency}</div>
            {!isUah && <div style={{ fontSize: 11, color: MUTED, whiteSpace: "nowrap" }}>≈ {sign}{fmtMoney(Number(r.amount_uah))} ₴</div>}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 3, minWidth: 0 }}>
          <AccBadge company={r.company} />
          {r.unmatched_account && <span title="нерозпізнаний рахунок" style={{ color: "#dc2626", fontSize: 11, flexShrink: 0 }}>⚠</span>}
          <span title={r.purpose ?? ""} style={{ fontSize: 12.5, color: MUTED, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{r.purpose ?? "—"}</span>
        </div>
      </div>
    </div>
  );
}

export default function BankSection() {
  const auth = useMemo(() => getAuthPayload(), []);
  const perms = auth?.perms ?? [];
  const canManageAccounts = perms.includes("manage_bank_accounts");
  const canManageHidden = perms.includes("manage_bank_hidden");
  const canSeeHidden = perms.includes("view_hidden_payments");
  const canViewBalances = perms.includes("view_balances");
  const canViewTotals = perms.includes("view_bank_totals"); // косметика; сервер гейтить summary
  const canViewCashflow = perms.includes("view_cashflow");
  const [balancesOpen, setBalancesOpen] = useState(false);
  const [cashflowOpen, setCashflowOpen] = useState(false);
  const [periodOpen, setPeriodOpen] = useState(false); // поповер календаря
  const [requisitesOpen, setRequisitesOpen] = useState(false); // «Реквізити» — усі ролі

  const PAGE = 100;
  const [mode, setMode] = useState<"in" | "out">("in");
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [companyFilter, setCompanyFilter] = useState<string | null>(null); // фільтр по КОМПАНІЇ (усі її валюти)
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

  const filters = useMemo(() => ({ from: range.from, to: range.to, company: companyFilter ?? undefined, currency: ccy || undefined, q: q || undefined }), [range.from, range.to, companyFilter, ccy, q]);
  const feedFn = mode === "in" ? fetchBankIncoming : fetchBankOutgoing;

  // Перша сторінка (скидання): підсумки за період + перша порція історії.
  const loadFirst = useCallback(() => {
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

  // Ставимо період на конкретний місяць (клік по стовпчику кешфлоу / пресети календаря).
  const setRangeMonth = (ym: string) => { const [y, m] = ym.split("-").map(Number); const last = new Date(y, m, 0).getDate(); setRange({ from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, "0")}` }); };
  const rangeLabel = (() => {
    const [fy, fm, fd] = range.from.split("-").map(Number), [ty, tm, td] = range.to.split("-").map(Number);
    const lastOfTo = new Date(ty, tm, 0).getDate();
    if (fd === 1 && td === lastOfTo) { // місяць-вирівняний діапазон → назви місяців
      if (fy === ty && fm === tm) return `${MONTHS[tm - 1]} ${ty}`;
      return `${MONTHS[fm - 1]}${fy !== ty ? " " + fy : ""} – ${MONTHS[tm - 1]} ${ty}`;
    }
    return `${fd}–${td} ${MONTHS[tm - 1]} ${ty}`;
  })();

  const active = accounts.filter((a) => a.is_active);
  // ОДИН чип на компанію (усі валюти під нею). Назва — з UAH-рахунку, інакше label без « · CCY».
  const companies = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of active) {
      const clean = a.label.replace(/\s*·\s*[A-Z]{3}$/, "");
      if (!m.has(a.company) || a.currency === "UAH") m.set(a.company, a.currency === "UAH" ? clean : (m.get(a.company) ?? clean));
    }
    return [...m.entries()].map(([company, label]) => ({ company, label }));
  }, [active]);
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
          {([["in", "📥 Вхідні"], ["out", "📤 Вихідні"]] as const).map(([m, lbl]) => (
            <button key={m} onClick={() => setMode(m)} style={{ fontSize: 13.5, fontWeight: 700, padding: "8px 14px", cursor: "pointer", border: "none", background: mode === m ? "#1f2330" : "var(--card-bg)", color: mode === m ? "#fff" : "var(--text)" }}>{lbl}</button>
          ))}
        </div>
        <div style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
          <Chip on={companyFilter === null} onClick={() => setCompanyFilter(null)}>Усі рахунки</Chip>
          {companies.map((c) => <Chip key={c.company} on={companyFilter === c.company} onClick={() => setCompanyFilter(c.company)}>{c.label}</Chip>)}
        </div>
        {canViewTotals && (
          <div style={{ position: "relative" }}>
            <button onClick={() => setPeriodOpen((v) => !v)} title="Період керує лише підсумками; список гортається по всій історії"
              style={{ display: "inline-flex", alignItems: "center", gap: 8, border: "1px solid var(--border)", borderRadius: 9, padding: "8px 14px", background: "var(--card-bg)", color: "var(--text)", cursor: "pointer", fontWeight: 700, fontSize: 13.5 }}>
              🗓 {rangeLabel} <span style={{ opacity: 0.5 }}>▾</span>
            </button>
            {periodOpen && <PeriodPicker from={range.from} to={range.to} onApply={(r) => { setRange(r); setPeriodOpen(false); }} onClose={() => setPeriodOpen(false)} />}
          </div>
        )}
        <div style={{ marginLeft: "auto", display: "inline-flex", gap: 8, alignItems: "center" }}>
          {/* «Реквізити» — доступні УСІМ ролям (без гейта прав) */}
          <button onClick={() => setRequisitesOpen(true)} style={{ padding: "8px 14px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", fontWeight: 700, fontSize: 13.5, cursor: "pointer" }}>📄 Реквізити</button>
          {canViewCashflow && (
            <button onClick={() => setCashflowOpen(true)} style={{ padding: "8px 14px", borderRadius: 10, border: "1px solid #2f6fdb", background: "rgba(47,111,219,0.08)", color: "#2f6fdb", fontWeight: 700, fontSize: 13.5, cursor: "pointer" }}>📊 Кешфлоу</button>
          )}
          {canViewBalances && (
            <button onClick={() => setBalancesOpen(true)} style={{ padding: "8px 14px", borderRadius: 10, border: "1px solid " + RED, background: "rgba(200,16,46,0.06)", color: RED, fontWeight: 700, fontSize: 13.5, cursor: "pointer" }}>💰 Баланси</button>
          )}
          {(canManageAccounts || canManageHidden) && (
            <button onClick={() => setSettingsOpen((v) => !v)} style={{ padding: "8px 14px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", cursor: "pointer", fontWeight: 700, fontSize: 13.5 }}>⚙️ Налаштування</button>
          )}
          <span style={{ fontSize: 12.5, color: MUTED }}>Ти: <b style={{ color: "var(--text)" }}>{roleName[auth?.role ?? ""] ?? auth?.roleKey ?? "—"}</b> · {canSeeHidden ? "бачиш усе" : "без прихованих"}</span>
        </div>
      </div>
      {balancesOpen && canViewBalances && <BalancesModal onClose={() => setBalancesOpen(false)} from={range.from} to={range.to} />}
      {cashflowOpen && canViewCashflow && <CashflowModal onClose={() => setCashflowOpen(false)} onPickMonth={(ym) => { setRangeMonth(ym); setCashflowOpen(false); }} />}
      {requisitesOpen && <RequisitesModal onClose={() => setRequisitesOpen(false)} />}

      {/* Стрип підсумків — ЛИШЕ якщо сервер віддав summary (право view_bank_totals). Немає → картки нема. */}
      {summary && (
        <div className="chart-card" style={{ display: "flex", gap: 26, flexWrap: "wrap", alignItems: "center", padding: "16px 20px" }}>
          <Stat big label={mode === "in" ? "надійшло за період" : "виплачено за період"} value={fmtUah(summary.total)} hint="Σ у гривні за ВИБРАНИЙ ПЕРІОД (валютні конвертовано за курсом банку/НБУ). Список нижче гортається по всій історії." />
          <Stat label="транзакцій за період" value={String(summary.count)} hint="Кількість транзакцій за вибраний період. Список показує всю утриману історію." />
          <Stat label="ТОВ ЮТС" value={fmtUah(byCo.uts ?? 0)} hint="Σ по рахунку ТОВ ЮТС за період, UAH. Джерело — банк." />
          <Stat label="ТОВ Автомув" value={fmtUah(byCo.automuv ?? 0)} hint="Σ по рахунку ТОВ Автомув за період, UAH. Джерело — банк." />
          <Stat label="ФОП Беспятчук" value={fmtUah(fopSum)} hint="Σ по рахунках ФОП (Приват+Моно) за період, UAH. Джерело — банк." />
          <Stat label="найбільший платіж" value={fmtUah(summary.maxPayment)} hint="Найбільша транзакція за період, UAH." />
          <span style={{ marginLeft: "auto", alignSelf: "flex-start", fontSize: 11.5, fontWeight: 700, padding: "3px 9px", borderRadius: 999, background: "rgba(217,119,6,0.14)", color: "#b45309", whiteSpace: "nowrap" }}>🔒 лише адмін</span>
        </div>
      )}

      {/* Список записів (двохрядкові) */}
      <div className="chart-card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
          <h2 className="chart-title" style={{ marginBottom: 0 }}>{mode === "in" ? "📥 Вхідні надходження" : "📤 Вихідні платежі"}</h2>
          <span style={{ fontSize: 12.5, color: MUTED }}>{mode === "in" ? "видно всім" : canSeeHidden ? "адмін-вигляд: 🔒 приховані позначені" : "приховані отримувачі відсутні (лише адмін)"} · дані з банку, оновлення ~15 хв</span>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="🔎 контрагент / підстава / ID" style={{ ...inp, width: 240 }} />
          <select value={companyFilter ?? ""} onChange={(e) => setCompanyFilter(e.target.value || null)} style={inp}><option value="">Компанія: усі</option>{companies.map((c) => <option key={c.company} value={c.company}>{c.label}</option>)}</select>
          <select value={ccy} onChange={(e) => setCcy(e.target.value)} style={inp}><option value="">Валюта: усі</option>{currencies.map((c) => <option key={c} value={c}>{c}</option>)}</select>
        </div>
        {loading ? <p className="loading-text">Завантаження…</p> : rows.length === 0 ? <p className="loading-text">Немає транзакцій в утриманій історії.</p> : (
          <div>
            {rows.map((r) => <TxRow key={r.id} r={r} mode={mode} />)}
          </div>
        )}
        {/* сентинель infinite-scroll + індикатор довантаження / кінець історії */}
        {!loading && rows.length > 0 && (
          <div ref={sentinelRef} style={{ textAlign: "center", padding: "14px 0 2px", color: MUTED, fontSize: 12.5 }}>
            {loadingMore ? "Завантаження ще…" : hasMore ? "Гортай нижче — довантажиться ще" : `Кінець історії · показано ${rows.length} транзакцій`}
          </div>
        )}
        {mode === "out" && !canSeeHidden && <p style={{ fontSize: 12, color: MUTED, marginTop: 10 }}>👁 У вашому вигляді приховані отримувачі <b>повністю відсутні</b> (їх нема ні в списку, ні в підсумках) — сервер їх не віддає на КОЖНІЙ сторінці.</p>}
      </div>

      {/* Налаштування — МОДАЛКА (раніше рендерилось під нескінченною стрічкою → недосяжно) */}
      {settingsOpen && (canManageAccounts || canManageHidden) && (
        <div onClick={() => setSettingsOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", zIndex: 1000, padding: "40px 16px", overflowY: "auto" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ maxWidth: 1000, width: "100%", position: "relative" }}>
            <button onClick={() => setSettingsOpen(false)} title="Закрити" style={{ position: "absolute", top: 10, right: 10, zIndex: 2, border: "1px solid var(--border)", background: "var(--card-bg)", borderRadius: 8, width: 34, height: 34, cursor: "pointer", fontSize: 18, color: MUTED }}>✕</button>
            <SettingsBlock accounts={accounts} canAccounts={canManageAccounts} canHidden={canManageHidden} onAccountsChange={loadAccounts} />
          </div>
        </div>
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
    try { await saveBankAccount(editId, { legalName: draft.legal_name ?? undefined, edrpouIpn: draft.edrpou_ipn ?? undefined, vatIpn: draft.vat_ipn ?? undefined, iban: draft.iban ?? undefined, bankName: draft.bank_name ?? undefined, mfo: draft.mfo ?? undefined, bankEdrpou: draft.bank_edrpou ?? undefined, legalAddress: draft.legal_address ?? undefined, director: draft.director ?? undefined, purpose: draft.purpose ?? undefined } as never); setEditId(null); await onChange(); setMsg("✓ Збережено"); }
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
                {([["legal_name", "Юр. назва"], ["edrpou_ipn", "ЄДРПОУ"], ["vat_ipn", "ІПН (ПДВ)"], ["iban", "IBAN"], ["bank_name", "Банк"], ["mfo", "МФО"], ["bank_edrpou", "ЄДРПОУ банку"], ["legal_address", "Юр. адреса"], ["director", "Директор"], ["purpose", "Призначення"]] as const).map(([k, lbl]) => (
                  <label key={k} style={{ fontSize: 12 }}>{lbl}<input value={(draft[k] as string) ?? ""} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} style={{ ...inp, width: "100%", boxSizing: "border-box", marginTop: 2 }} /></label>
                ))}
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={save} style={{ padding: "7px 14px", borderRadius: 8, border: "none", background: "#16a34a", color: "#fff", fontWeight: 700, cursor: "pointer" }}>Зберегти</button>
                  <button onClick={() => setEditId(null)} style={{ padding: "7px 14px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: MUTED, cursor: "pointer" }}>Скасувати</button>
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 13, lineHeight: 1.9 }}>
                <Req label="ЄДРПОУ" v={a.edrpou_ipn} /><Req label="ІПН (ПДВ)" v={a.vat_ipn ?? null} /><Req label="IBAN" v={a.iban} /><Req label="Банк · МФО" v={a.bank_name ? `${a.bank_name}${a.mfo ? " · " + a.mfo : ""}${a.bank_edrpou ? " · ЄДРПОУ банку " + a.bank_edrpou : ""}` : null} /><Req label="Юр. адреса" v={a.legal_address ?? null} /><Req label="Директор" v={a.director ?? null} /><Req label="Призначення" v={a.purpose} />
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
function BalancesModal({ onClose, from, to }: { onClose: () => void; from: string; to: string }) {
  const [balances, setBalances] = useState<BankBalance[] | null>(null);
  const [period, setPeriod] = useState<{ from: string; to: string } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { fetchBankBalances(from, to).then((d) => { setBalances(d.balances); setPeriod(d.period ?? null); }).catch((e) => setError(err(e))); }, [from, to]);
  const periodLabel = period ? `${period.from} — ${period.to}` : `${from} — ${to}`;
  const fmtGain = (n: number) => `${n > 0 ? "↑ +" : n < 0 ? "↓ −" : ""}${fmtMoney(Math.abs(n))} ₴`;
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
        <p style={{ fontSize: 12.5, color: MUTED, marginTop: 0 }}>Поточний залишок по кожному активному рахунку. Джерело — банк-API (mono client-info / privat closing-balance), оновлюється на синку. «—» = ключ/доступ відсутній. Курсова різниця — за період <b style={{ color: "var(--text)" }}>{periodLabel}</b>.</p>
        {error ? <p style={{ color: "#dc2626", fontSize: 13 }}>{error}</p> : !balances ? <p className="loading-text">Завантаження…</p> : (
          <div style={{ display: "grid", gap: 10 }}>
            {balances.map((b) => (
              <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 12, border: "1px solid var(--border)", borderRadius: 12, padding: "12px 14px" }}>
                <AccBadge company={b.company} />
                <b style={{ fontSize: 14 }}>{b.label}</b>
                <div style={{ marginLeft: "auto", textAlign: "right" }}>
                  <div style={{ fontSize: 17, fontWeight: 800, color: b.balance_amount == null ? MUTED : "#16a34a" }}>{fmtBal(b.balance_amount, b.balance_currency)}</div>
                  {b.balance_currency && b.balance_currency !== "UAH" && b.balance_uah != null && (
                    <div style={{ fontSize: 11.5, color: MUTED }}>≈ {fmtMoney(b.balance_uah, true)} ₴</div>
                  )}
                  {b.balance_currency && b.balance_currency !== "UAH" && b.fx_gain_period != null && (
                    <div style={{ fontSize: 11, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 3, justifyContent: "flex-end", color: b.fx_gain_period > 0 ? "#16a34a" : b.fx_gain_period < 0 ? "#dc2626" : MUTED }}>
                      {fmtGain(b.fx_gain_period)} · курсова різниця за період
                      <InfoHint text="Різниця між курсом на момент надходження і сьогоднішнім, по валютних надходженнях за період. Нереалізована — фіксується лише при конвертації в гривню." />
                    </div>
                  )}
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

// ─────────────────────────── Реквізити компаній (усі ролі, перегляд+копіювання) ───────────────────────────
const ccyTag = (c: string) => (c && c !== "UAH" ? ` (${c})` : "");
function reqToText(r: BankRequisite): string {
  const L: string[] = [r.legal_name ?? r.label];
  if (r.edrpou_ipn) L.push(`ЄДРПОУ: ${r.edrpou_ipn}`);
  if (r.vat_ipn) L.push(`ІПН (ПДВ): ${r.vat_ipn}`);
  if (r.iban) L.push(`IBAN${ccyTag(r.currency)}: ${r.iban}`);
  const bank = [r.bank_name, r.mfo ? `МФО ${r.mfo}` : null, r.bank_edrpou ? `ЄДРПОУ банку ${r.bank_edrpou}` : null].filter(Boolean).join(", ");
  if (bank) L.push(`Банк: ${bank}`);
  if (r.legal_address) L.push(`Юр. адреса: ${r.legal_address}`);
  if (r.director) L.push(`Директор: ${r.director}`);
  return L.join("\n");
}
function RequisitesModal({ onClose }: { onClose: () => void }) {
  const [reqs, setReqs] = useState<BankRequisite[] | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  useEffect(() => { fetchBankRequisites().then(setReqs).catch((e) => setError(err(e))); }, []);
  const copy = (text: string, tag: string) => { navigator.clipboard?.writeText(text).then(() => { setCopied(tag); setTimeout(() => setCopied((c) => (c === tag ? "" : c)), 1500); }).catch(() => {}); };
  const btn = (active: boolean): React.CSSProperties => ({ padding: "5px 11px", borderRadius: 8, border: "1px solid var(--border)", background: active ? "rgba(22,163,74,0.14)" : "var(--card-bg)", color: active ? "#16a34a" : "#2f6fdb", cursor: "pointer", fontSize: 12.5, fontWeight: 700, whiteSpace: "nowrap" });
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", zIndex: 1000, padding: "40px 16px", overflowY: "auto" }}>
      <div onClick={(e) => e.stopPropagation()} className="chart-card" style={{ maxWidth: 760, width: "100%", margin: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <h2 className="chart-title" style={{ marginBottom: 0 }}>📄 Реквізити компаній</h2>
          <button onClick={onClose} title="Закрити" style={{ border: "none", background: "none", cursor: "pointer", fontSize: 20, color: MUTED }}>✕</button>
        </div>
        <p style={{ fontSize: 12.5, color: MUTED, marginTop: 0 }}>Публічні реквізити для вставки в рахунок/лист. Доступно всім. Копіюй блок або IBAN однією кнопкою.</p>
        {error ? <p style={{ color: "#dc2626", fontSize: 13 }}>{error}</p> : !reqs ? <p className="loading-text">Завантаження…</p> : (
          <>
            <div style={{ display: "grid", gap: 12 }}>
              {reqs.map((r) => (
                <div key={r.id} style={{ border: "1px solid var(--border)", borderRadius: 12, padding: "13px 15px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
                    <AccBadge company={r.company} />
                    <b style={{ fontSize: 14.5 }}>{r.legal_name ?? r.label}</b>
                    {r.currency && r.currency !== "UAH" && <span style={{ fontSize: 11, fontWeight: 800, padding: "2px 8px", borderRadius: 7, background: "rgba(47,111,219,0.14)", color: "#2f6fdb" }}>{r.currency}</span>}
                    <button onClick={() => copy(reqToText(r), `r${r.id}`)} style={{ ...btn(copied === `r${r.id}`), marginLeft: "auto" }}>{copied === `r${r.id}` ? "✓ Скопійовано" : "⧉ Копіювати"}</button>
                  </div>
                  <div style={{ fontSize: 13, lineHeight: 1.85 }}>
                    <ReqLine label="ЄДРПОУ" v={r.edrpou_ipn} />
                    <ReqLine label="ІПН (ПДВ)" v={r.vat_ipn} />
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ color: MUTED, display: "inline-block", minWidth: 130 }}>IBAN{ccyTag(r.currency)}</span>
                      <b style={{ fontFamily: "monospace", fontSize: 13 }}>{r.iban ?? "—"}</b>
                      {r.iban && <button onClick={() => copy(r.iban!, `i${r.id}`)} style={btn(copied === `i${r.id}`)}>{copied === `i${r.id}` ? "✓" : "⧉ IBAN"}</button>}
                    </div>
                    <ReqLine label="Банк · МФО" v={r.bank_name ? `${r.bank_name}${r.mfo ? " · МФО " + r.mfo : ""}${r.bank_edrpou ? " · ЄДРПОУ банку " + r.bank_edrpou : ""}` : null} />
                    <ReqLine label="Юр. адреса" v={r.legal_address} />
                    <ReqLine label="Директор" v={r.director} />
                  </div>
                </div>
              ))}
            </div>
            <button onClick={() => copy(reqs.map(reqToText).join("\n\n"), "all")} style={{ ...btn(copied === "all"), width: "100%", marginTop: 14, padding: "10px", fontSize: 13.5 }}>{copied === "all" ? "✓ Скопійовано всі реквізити" : "⧉ Копіювати всі реквізити"}</button>
          </>
        )}
      </div>
    </div>
  );
}
function ReqLine({ label, v }: { label: string; v: string | null | undefined }) {
  if (!v) return null;
  return <div><span style={{ color: MUTED, display: "inline-block", minWidth: 130 }}>{label}</span><b>{v}</b></div>;
}

// ─────────────────────────── Кешфлоу помісячно (view_cashflow) ───────────────────────────
function CashflowModal({ onClose, onPickMonth }: { onClose: () => void; onPickMonth: (ym: string) => void }) {
  const [data, setData] = useState<CashflowMonth[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { fetchBankCashflow(12).then(setData).catch((e) => setError(err(e))); }, []);
  const now = new Date();
  const curYm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const max = data && data.length ? Math.max(1, ...data.flatMap((d) => [d.incoming_uah, d.outgoing_uah])) : 1;
  const H = 150;
  const barH = (v: number) => Math.max(v > 0 ? 3 : 0, Math.round((v / max) * H));
  const monLbl = (ym: string) => { const [y, m] = ym.split("-").map(Number); return `${MONTHS[m - 1]} ${String(y).slice(2)}`; };
  // компактне сальдо (щоб не наповзало у вузькій колонці): +1,3млн / +840к / +120
  const net = (n: number) => { const a = Math.abs(n), s = n >= 0 ? "+" : "−"; return a >= 1e6 ? `${s}${(a / 1e6).toFixed(1).replace(".", ",")}млн` : a >= 1e3 ? `${s}${Math.round(a / 1e3)}к` : `${s}${Math.round(a)}`; };
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} className="chart-card" style={{ maxWidth: 780, width: "100%", margin: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
          <h2 className="chart-title" style={{ marginBottom: 0 }}>📊 Кешфлоу · рух коштів помісячно</h2>
          <button onClick={onClose} style={{ border: "none", background: "none", cursor: "pointer", fontSize: 20, color: MUTED }}>✕</button>
        </div>
        <p style={{ fontSize: 12.5, color: MUTED, marginTop: 0 }}>Надходження мінус витрати (без банк-комісій) по місяцях, у гривні. Клік по місяцю → період виписки на цей місяць.</p>
        <div style={{ display: "flex", gap: 16, fontSize: 12, color: MUTED, marginBottom: 8 }}>
          <span><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: "#16a34a", marginRight: 5 }} />Надходження</span>
          <span><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: "#dc2626", marginRight: 5 }} />Витрати</span>
          <span>Сальдо — число під місяцем · суми у ₴</span>
        </div>
        {error ? <p style={{ color: "#dc2626", fontSize: 13 }}>{error}</p> : !data ? <p className="loading-text">Завантаження…</p> : (
          <div style={{ display: "flex", alignItems: "flex-end", gap: 4, overflowX: "auto", paddingBottom: 4 }}>
            {data.map((d) => {
              const active = d.month === curYm;
              return (
                <button key={d.month} onClick={() => onPickMonth(d.month)} title="Відкрити цей місяць у виписці"
                  style={{ flex: "1 0 52px", minWidth: 52, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, border: active ? "1px solid #2f6fdb" : "1px solid transparent", background: active ? "rgba(47,111,219,0.07)" : "transparent", borderRadius: 10, padding: "6px 2px", cursor: "pointer" }}>
                  <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: H }}>
                    <div title={`Надходження ${fmtUah(d.incoming_uah)}`} style={{ width: 11, height: barH(d.incoming_uah), background: "#16a34a", borderRadius: "3px 3px 0 0" }} />
                    <div title={`Витрати ${fmtUah(d.outgoing_uah)}`} style={{ width: 11, height: barH(d.outgoing_uah), background: "#dc2626", borderRadius: "3px 3px 0 0" }} />
                  </div>
                  <div style={{ fontSize: 10.5, fontWeight: 800, color: d.net_uah >= 0 ? "#16a34a" : "#dc2626", whiteSpace: "nowrap" }}>{net(d.net_uah)}</div>
                  <div style={{ fontSize: 11, color: active ? "#2f6fdb" : MUTED, fontWeight: active ? 700 : 400 }}>{monLbl(d.month)}</div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────── Календарний вибір періоду (поповер) ───────────────────────────
function PeriodPicker({ from, to, onApply, onClose }: { from: string; to: string; onApply: (r: { from: string; to: string }) => void; onClose: () => void }) {
  const ym = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;
  const now = new Date();
  const Y = now.getFullYear(), M = now.getMonth() + 1;
  const [dFrom, setDFrom] = useState(from.slice(0, 7));
  const [dTo, setDTo] = useState(to.slice(0, 7));
  const [anchor, setAnchor] = useState<string | null>(null);
  const [gridYear, setGridYear] = useState(Number(to.slice(0, 4)));
  const set = (a: string, b: string) => { setDFrom(a); setDTo(b); setAnchor(null); setGridYear(Number(b.slice(0, 4))); };
  const clickMonth = (m: string) => {
    if (!anchor) { setAnchor(m); setDFrom(m); setDTo(m); }
    else { const [a, b] = anchor <= m ? [anchor, m] : [m, anchor]; setDFrom(a); setDTo(b); setAnchor(null); }
  };
  const apply = () => { const [ty, tm] = dTo.split("-").map(Number); const last = new Date(ty, tm, 0).getDate(); onApply({ from: `${dFrom}-01`, to: `${dTo}-${String(last).padStart(2, "0")}` }); };
  const presets: [string, () => void][] = [
    ["Цей місяць", () => set(ym(Y, M), ym(Y, M))],
    ["Минулий", () => { const d = new Date(Y, M - 2, 1); set(ym(d.getFullYear(), d.getMonth() + 1), ym(d.getFullYear(), d.getMonth() + 1)); }],
    ["Останні 3 міс", () => { const d = new Date(Y, M - 3, 1); set(ym(d.getFullYear(), d.getMonth() + 1), ym(Y, M)); }],
    ["Квартал", () => { const s = Math.floor((M - 1) / 3) * 3 + 1; set(ym(Y, s), ym(Y, s + 2)); }],
    ["Рік", () => set(ym(Y, 1), ym(Y, 12))],
  ];
  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 90 }} />
      <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 100, width: 320, background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 12, boxShadow: "0 8px 28px rgba(0,0,0,0.18)", padding: 12 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
          {presets.map(([lbl, fn]) => <button key={lbl} onClick={fn} style={{ fontSize: 12, fontWeight: 700, padding: "5px 10px", borderRadius: 999, border: "1px solid var(--border)", background: "var(--card-bg)", color: "#2f6fdb", cursor: "pointer" }}>{lbl}</button>)}
          <span style={{ fontSize: 11, color: MUTED, alignSelf: "center" }}>або обери місяць/діапазон ↓</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <button onClick={() => setGridYear((y) => y - 1)} style={arrowBtn}>◀</button>
          <b style={{ fontSize: 14 }}>{gridYear}</b>
          <button onClick={() => setGridYear((y) => y + 1)} style={arrowBtn}>▶</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 6 }}>
          {MONTHS.map((mn, i) => {
            const cell = ym(gridYear, i + 1);
            const inRange = cell >= dFrom && cell <= dTo;
            const edge = cell === dFrom || cell === dTo;
            return (
              <button key={cell} onClick={() => clickMonth(cell)}
                style={{ fontSize: 12.5, fontWeight: edge ? 800 : 600, padding: "8px 0", borderRadius: 8, cursor: "pointer",
                  border: "1px solid " + (edge ? "#2f6fdb" : "var(--border)"),
                  background: edge ? "#2f6fdb" : inRange ? "rgba(47,111,219,0.12)" : "var(--card-bg)",
                  color: edge ? "#fff" : "var(--text)" }}>{mn}</button>
            );
          })}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12 }}>
          <span style={{ fontSize: 11.5, color: MUTED }}>{dFrom === dTo ? dFrom : `${dFrom} – ${dTo}`}</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => { set(ym(Y, M), ym(Y, M)); }} style={{ fontSize: 12.5, padding: "6px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: MUTED, cursor: "pointer" }}>Скинути</button>
            <button onClick={apply} style={{ fontSize: 12.5, fontWeight: 700, padding: "6px 14px", borderRadius: 8, border: "none", background: "#2f6fdb", color: "#fff", cursor: "pointer" }}>Застосувати</button>
          </div>
        </div>
      </div>
    </>
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

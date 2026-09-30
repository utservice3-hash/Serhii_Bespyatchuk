import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useToast } from "../../../components/Toasts";
import { useSearchParams } from "react-router-dom";
import {
  fetchBaMeta, fetchBaClaims, fetchBaClaim, createBaClaim, updateBaClaim, archiveBaClaim,
  fetchBaCases, fetchBaCase, createBaCase, updateBaCase, archiveBaCase, hiringError,
  type BaMeta, type BaClaim, type BaClaimCard, type BaCase, type BaCaseCard, type BaClaimStatus, type BaCaseStatus,
} from "../../../api";
import { money, fmtDate, useEscape, Docs, History, type Toast } from "./BaShared";
import { BaEquipment } from "./BaEquipment";
import { BaTtn } from "./BaTtn";
import "./hiring.css";

/**
 * 🗂 «БІЗНЕС-АСИСТЕНТ», прохід 1 (ТЗ задачі 4314, 28.09.2026): Претензії й Судовий реєстр.
 * Макет затвердив Роман 24.09.2026 (artifact 369P5uNAPdL8L7tSf8dCfN). Розділ бачать роль
 * «бізнес-асистент» і керівництво — межу тримає сервер (вкладка `ba`), тут лише рендер.
 * «Облік техніки» й «ТТН-моніторинг» — наступні проходи; до того їхні вкладки пояснюють, чого
 * чекають (той самий прийом, що в «Наймі»: людина бачить повну картину, а не гадає).
 * Стилі — `hiring.css` (`.hr-*`): той самий вигляд карток, таблиць і шухляд.
 */
type Tab = "claims" | "cases" | "equip" | "ttn";

const LS_TAB = "ba.tab";
const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* приватне вікно */ } };


const CLAIM_TONE: Record<BaClaimStatus, string> = { problem: "dg", sent: "pl", answered: "wn", noreply: "wn", court: "dg", paid: "ok", closed: "gr" };
const CASE_TONE: Record<BaCaseStatus, string> = { prep: "gr", filed: "pl", going: "wn", done: "ok" };

export function BusinessAssistantSection() {
  const [meta, setMeta] = useState<BaMeta | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(() => (lsGet(LS_TAB) as Tab) || "claims");
  const [params, setParams] = useSearchParams();
  const [openClaim, setOpenClaim] = useState<number | "new" | null>(null);
  const [openCase, setOpenCase] = useState<number | "new" | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => { fetchBaMeta().then(setMeta).catch((e) => setErr(hiringError(e))); }, []);
  // Посилання з дебіторки: `/ba?claim=ID` відкриває картку претензії одразу.
  useEffect(() => {
    const id = Number(params.get("claim"));
    if (Number.isInteger(id) && id > 0) {
      setTab("claims"); setOpenClaim(id);
      params.delete("claim"); setParams(params, { replace: true });
    }
  }, [params, setParams]);

  // 🔔 Спільне повідомлення дашборда (`components/Toasts.tsx`) — раніше тут жила своя копія.
  const toast: Toast = useToast();
  const pick = (t: Tab) => { setTab(t); lsSet(LS_TAB, t); };
  const refresh = () => setNonce((n) => n + 1);

  if (err) return <div className="chart-card"><b>Розділ «Бізнес-асистент» недоступний.</b> <span className="hr-muted">{err}</span></div>;
  if (!meta) return <p className="loading-text">Завантаження…</p>;

  const tabs: [Tab, string, boolean][] = [["claims", "Претензії", false], ["cases", "Судовий реєстр", false], ["equip", "Облік техніки", false], ["ttn", "ТТН-моніторинг", false]];
  return (
    <div>
      <h1 className="page-title" style={{ marginBottom: 4 }}>Бізнес-асистент</h1>
      <p className="hr-muted" style={{ margin: "0 0 14px", fontSize: 13 }}>
        Претензії, судові справи, облік техніки й ТТН в одному місці. Розділ бачать бізнес-асистент і керівництво.
      </p>
      <div className="hr-tabs" role="tablist" aria-label="Блоки бізнес-асистента">
        {tabs.map(([k, l, soon]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => pick(k)}
            title={soon ? "Ще не зроблено — усередині пояснення чому" : undefined}>
            {l}{soon && <span style={{ marginLeft: 6, fontSize: 10, opacity: 0.75 }}>скоро</span>}
          </button>
        ))}
      </div>
      {tab === "claims" && <ClaimsTab meta={meta} nonce={nonce} onOpen={setOpenClaim} />}
      {tab === "cases" && <CasesTab meta={meta} nonce={nonce} onOpen={setOpenCase} onOpenClaim={(id) => { pick("claims"); setOpenClaim(id); }} />}
      {tab === "equip" && <BaEquipment meta={meta} toast={toast} />}
      {tab === "ttn" && <BaTtn meta={meta} toast={toast} />}

      {openClaim != null && (
        <ClaimDrawer meta={meta} id={openClaim} toast={toast} onClose={() => setOpenClaim(null)}
          onChanged={refresh} onCreated={(id) => setOpenClaim(id)}
          onOpenCase={(id) => { setOpenClaim(null); pick("cases"); setOpenCase(id); }} />
      )}
      {openCase != null && (
        <CaseDrawer meta={meta} id={openCase} toast={toast} onClose={() => setOpenCase(null)}
          onChanged={refresh} onCreated={(id) => setOpenCase(id)}
          onOpenClaim={(id) => { setOpenCase(null); pick("claims"); setOpenClaim(id); }} />
      )}
    </div>
  );
}


// ── Претензії ────────────────────────────────────────────────────────────────
type ClaimFilter = "all" | BaClaimStatus | "archive";
function ClaimsTab({ meta, nonce, onOpen }: { meta: BaMeta; nonce: number; onOpen: (id: number | "new") => void }) {
  const [rows, setRows] = useState<BaClaim[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState<ClaimFilter>("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"sent" | "sum" | "days">("sent");
  // Фільтр за датою відправки (ТЗ: «фільтрація … мінімум за статусом і датою»): місяць або «не відправлено».
  const [period, setPeriod] = useState<"all" | "none" | string>("all");
  useEffect(() => { fetchBaClaims().then(setRows).catch((e) => setErr(hiringError(e))); }, [nonce]);
  const sentMonths = useMemo(() => [...new Set((rows ?? []).map((c) => c.sentOn?.slice(0, 7)).filter((x): x is string => !!x))].sort().reverse(), [rows]);

  const shown = useMemo(() => (rows ?? []).filter((c) => {
    if (status === "archive" ? !c.archived : c.archived) return false;
    if (status !== "all" && status !== "archive" && c.status !== status) return false;
    if (period === "none" ? c.sentOn : period !== "all" && c.sentOn?.slice(0, 7) !== period) return false;
    return !q || c.company.toLowerCase().includes(q.toLowerCase());
  }).sort((a, b) => {
    if (sort === "sum") return (b.debtAmount ?? -1) - (a.debtAmount ?? -1);
    if (sort === "days") return (b.overdueDays ?? -1) - (a.overdueDays ?? -1);
    // ТЗ: «за датою відправки, нові зверху»; невідправлені — внизу (рішення Романа 29.09.2026, #985).
    if (!a.sentOn !== !b.sentOn) return a.sentOn ? -1 : 1;
    return (b.sentOn ?? "").localeCompare(a.sentOn ?? "") || b.id - a.id;
  }), [rows, status, q, sort, period]);

  if (err) return <div className="chart-card"><span className="hr-muted">{err}</span></div>;
  if (!rows) return <p className="loading-text">Завантаження…</p>;
  const active = rows.filter((c) => !c.archived);
  const chips: [ClaimFilter, string, number][] = [["all", "Усі", active.length],
    ...meta.claimStatuses.map((s) => [s.key, s.label, active.filter((c) => c.status === s.key).length] as [ClaimFilter, string, number]),
    ["archive", "Архів", rows.length - active.length]];
  return (
    <div className="hr-card">
      <div className="hd">
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "end" }}>
          <label className="hr-muted">Пошук компанії<br />
            <input className="hr-inp" type="search" placeholder="Назва компанії" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <label className="hr-muted">Дата відправки<br />
            <select className="hr-inp" value={period} onChange={(e) => setPeriod(e.target.value)}>
              <option value="all">Усі дати</option>
              {sentMonths.map((m) => <option key={m} value={m}>{`${m.slice(5, 7)}.${m.slice(0, 4)}`}</option>)}
              <option value="none">Ще не відправлено</option>
            </select>
          </label>
          <label className="hr-muted">Сортування<br />
            <select className="hr-inp" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
              <option value="sent">Дата відправки: нові зверху</option>
              <option value="sum">Сума боргу: більші зверху</option>
              <option value="days">Днів прострочення: більше зверху</option>
            </select>
          </label>
        </div>
        <button className="hr-btn p" onClick={() => onOpen("new")}>+ Претензія</button>
      </div>
      <div className="hr-sect" style={{ borderTop: 0, paddingBottom: 0 }}>
        <div className="hr-pills" role="group" aria-label="Фільтр за статусом">
          {chips.map(([k, l, n]) => <button key={k} className={status === k ? "on" : ""} aria-pressed={status === k} onClick={() => setStatus(k)}>{l} · {n}</button>)}
        </div>
      </div>
      <div className="hr-tw">
        <table className="hr-table">
          <thead><tr><th>Компанія-адресат</th><th className="num">Сума боргу</th><th className="num">Днів простр.</th><th>Дата відправки</th><th>Статус</th><th className="num">Документи</th><th>Джерело</th></tr></thead>
          <tbody>
            {shown.map((c) => (
              <tr key={c.id} className="row" tabIndex={0} onClick={() => onOpen(c.id)} onKeyDown={(e) => { if (e.key === "Enter") onOpen(c.id); }}>
                <td><b>{c.company}</b></td>
                <td className="num">{money(c.debtAmount)}</td>
                <td className="num">{c.overdueDays ?? "—"}</td>
                <td>{c.sentOn ? fmtDate(c.sentOn) : <span className="hr-muted">не відправлено</span>}</td>
                <td><span className={`hr-pill ${CLAIM_TONE[c.status]}`}>{c.statusLabel}</span>{c.caseId && <span className="hr-muted" style={{ marginLeft: 6 }}>· є справа</span>}</td>
                <td className="num">{c.files}</td>
                <td className="hr-muted">{c.source === "receivables" ? "з дебіторки" : "вручну"}</td>
              </tr>
            ))}
            {!shown.length && (
              <tr><td colSpan={7} className="hr-muted" style={{ padding: 16 }}>
                {rows.length ? "Нічого не знайдено за цим фільтром." : "Претензій ще немає. Вони зʼявляються кнопкою «Проблемний клієнт» у дебіторці або через «+ Претензія»."}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="hr-sect hr-muted">Сума боргу й дні прострочення беруться з «Активної дебіторки» в момент створення. Нові зверху, невідправлені — внизу.</div>
    </div>
  );
}

function ClaimDrawer({ meta, id, toast, onClose, onChanged, onCreated, onOpenCase }: {
  meta: BaMeta; id: number | "new"; toast: Toast; onClose: () => void; onChanged: () => void;
  onCreated: (id: number) => void; onOpenCase: (id: number) => void;
}) {
  const [card, setCard] = useState<BaClaimCard | null>(null);
  const [form, setForm] = useState({ company: "", debtAmount: "", overdueDays: "", sentOn: "", essence: "", status: "problem" as BaClaimStatus, result: "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    if (id === "new") return;
    fetchBaClaim(id).then((c) => {
      setCard(c);
      setForm({ company: c.company, debtAmount: c.debtAmount == null ? "" : String(c.debtAmount), overdueDays: c.overdueDays == null ? "" : String(c.overdueDays),
        sentOn: c.sentOn ?? "", essence: c.essence, status: c.status, result: c.result });
    }).catch((e) => setErr(hiringError(e)));
  }, [id]);
  useEffect(load, [load]);
  useEscape(onClose);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = async () => {
    if (!form.company.trim()) { setErr("Вкажіть компанію-адресата"); return; }
    setBusy(true); setErr(null);
    const body = { ...form, company: form.company.trim(), sentOn: form.sentOn || null, debtAmount: form.debtAmount || null, overdueDays: form.overdueDays || null };
    try {
      if (id === "new") {
        const nid = await createBaClaim(body);
        onChanged(); onCreated(nid);
        toast(form.status === "court" ? "Претензію створено, справа — у Судовому реєстрі" : "Претензію створено. Тепер можна додати документи.");
      } else {
        const r = await updateBaClaim(id, body);
        onChanged(); load();
        if (r.caseCreated) toast(`Справу створено в Судовому реєстрі, перенесено документів: ${card?.fileList.length ?? 0}`, { action: { label: "Відкрити справу", run: () => onOpenCase(r.caseCreated!) } });
        else toast("Збережено");
      }
    } catch (e) { setErr(hiringError(e)); } finally { setBusy(false); }
  };
  const archive = async (on: boolean) => {
    if (id === "new") return;
    try { await archiveBaClaim(id, on); onChanged(); load(); toast(on ? "Перенесено в архів" : "Повернуто з архіву"); } catch (e) { toast(hiringError(e), { error: true }); }
  };

  const loading = id !== "new" && !card && !err;
  return createPortal(
    <div className="hr-overlay" onClick={onClose}>
      <aside className="hr-drawer" role="dialog" aria-label="Картка претензії" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "start" }}>
          <div>
            <div className="hr-muted">Претензія · {id === "new" ? "нова, вручну" : card?.source === "receivables" ? "створена кнопкою «Проблемний клієнт» у дебіторці" : "створена вручну"}</div>
            <h2 style={{ margin: "2px 0 12px", fontSize: 19 }}>{id === "new" ? "Нова претензія" : card?.company ?? "…"}</h2>
          </div>
          <button className="hr-btn xs" onClick={onClose} aria-label="Закрити картку">×</button>
        </div>
        {loading ? <p className="loading-text">Завантаження…</p> : (<>
          {card?.archived && <div className="hr-note" style={{ background: "var(--warn-bg)", color: "var(--warn)", marginTop: 0, marginBottom: 10 }}>Претензія в архіві. Її можна повернути кнопкою внизу.</div>}
          <div className="hr-kv">
            <span className="k">Компанія-адресат</span><input className="hr-inp" value={form.company} onChange={set("company")} />
            <span className="k">Сума боргу, ₴</span><input className="hr-inp" inputMode="decimal" value={form.debtAmount} onChange={set("debtAmount")} />
            <span className="k">Днів прострочення</span><input className="hr-inp" inputMode="numeric" value={form.overdueDays} onChange={set("overdueDays")} />
            <span className="k">Дата відправки</span><input className="hr-inp" type="date" value={form.sentOn} onChange={set("sentOn")} />
            <span className="k">Суть претензії</span><textarea className="hr-inp" rows={3} value={form.essence} onChange={set("essence")} />
            <span className="k">Статус</span>
            <select className="hr-inp" value={form.status} onChange={set("status")}>
              {meta.claimStatuses.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
            <span className="k">Результат</span><input className="hr-inp" placeholder="Заповнюється після закриття" value={form.result} onChange={set("result")} />
          </div>
          {card?.source === "receivables" && <p className="hr-muted" style={{ margin: "6px 0 0" }}>Сума й дні взяті з «Активної дебіторки» в момент створення. Далі їх можна правити вручну.</p>}
          {card?.caseId
            ? <div className="hr-note">Справу створено в Судовому реєстрі, документи перенесено. <button className="hr-link" onClick={() => onOpenCase(card.caseId!)}>Відкрити справу</button></div>
            : form.status === "court" && <div className="hr-note">Після збереження зі статусом «Передано в суд» справа зʼявиться в Судовому реєстрі, і туди перенесуться всі документи претензії.</div>}
          {err && <div style={{ color: "var(--danger)", fontSize: 12, marginTop: 8 }}>{err}</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12, flexWrap: "wrap" }}>
            {card && (card.archived
              ? <button className="hr-btn" onClick={() => void archive(false)}>Повернути з архіву</button>
              : <button className="hr-btn" onClick={() => void archive(true)}>В архів</button>)}
            <button className="hr-btn" onClick={onClose}>Скасувати</button>
            <button className="hr-btn p" disabled={busy} onClick={() => void save()}>{id === "new" ? "Створити" : "Зберегти"}</button>
          </div>
          {card && <>
            <Docs kind="claims" ownerId={card.id} files={card.fileList} types={meta.claimDocTypes} maxBytes={meta.fileMaxBytes} toast={toast} onAdded={() => { load(); onChanged(); }} />
            <History events={card.events} />
          </>}
          {id === "new" && <p className="hr-muted" style={{ marginTop: 14 }}>Документи можна додати після створення претензії.</p>}
        </>)}
      </aside>
    </div>, document.body);
}

// ── Судовий реєстр ───────────────────────────────────────────────────────────
type CaseFilter = "all" | BaCaseStatus | "archive";
function CasesTab({ meta, nonce, onOpen, onOpenClaim }: { meta: BaMeta; nonce: number; onOpen: (id: number | "new") => void; onOpenClaim: (id: number) => void }) {
  const [rows, setRows] = useState<BaCase[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState<CaseFilter>("all");
  const [sort, setSort] = useState<"hearing" | "filed">("hearing");
  useEffect(() => { fetchBaCases().then(setRows).catch((e) => setErr(hiringError(e))); }, [nonce]);
  if (err) return <div className="chart-card"><span className="hr-muted">{err}</span></div>;
  if (!rows) return <p className="loading-text">Завантаження…</p>;
  const active = rows.filter((k) => !k.archived);
  const chips: [CaseFilter, string, number][] = [["all", "Усі", active.length],
    ...meta.caseStatuses.map((s) => [s.key, s.label, active.filter((k) => k.status === s.key).length] as [CaseFilter, string, number]),
    ["archive", "Архів", rows.length - active.length]];
  // «Засідання» — порядок сервера (найближчі зверху); «подання» — нові зверху, без дати внизу.
  const filtered = rows.filter((k) => (status === "archive" ? k.archived : !k.archived && (status === "all" || k.status === status)));
  const shown = sort === "hearing" ? filtered : [...filtered].sort((a, b) =>
    (!a.filedOn !== !b.filedOn ? (a.filedOn ? -1 : 1) : (b.filedOn ?? "").localeCompare(a.filedOn ?? "")) || b.id - a.id);
  return (
    <div className="hr-card">
      <div className="hd">
        <div className="hr-pills" role="group" aria-label="Фільтр за статусом" style={{ marginBottom: 0 }}>
          {chips.map(([k, l, n]) => <button key={k} className={status === k ? "on" : ""} aria-pressed={status === k} onClick={() => setStatus(k)}>{l} · {n}</button>)}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select className="hr-inp" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Сортування справ">
            <option value="hearing">Найближче засідання зверху</option>
            <option value="filed">Дата подання: нові зверху</option>
          </select>
          <button className="hr-btn p" onClick={() => onOpen("new")}>+ Справа</button>
        </div>
      </div>
      <div className="hr-tw">
        <table className="hr-table">
          <thead><tr><th>Назва справи</th><th>Позивач / відповідач</th><th>Номер справи</th><th>Подано</th><th>Наступне засідання</th><th>Статус</th><th className="num">Файли</th><th>Джерело</th></tr></thead>
          <tbody>
            {shown.map((k) => (
              <tr key={k.id} className="row" tabIndex={0} onClick={() => onOpen(k.id)} onKeyDown={(e) => { if (e.key === "Enter") onOpen(k.id); }}>
                <td><b>{k.title}</b></td>
                <td>{k.plaintiff || "—"}<br /><span className="hr-muted">{k.defendant || "—"}</span></td>
                <td>{k.caseNumber || <span className="hr-muted">ще не присвоєно</span>}</td>
                <td>{fmtDate(k.filedOn)}</td>
                <td><b>{fmtDate(k.nextHearingOn)}</b></td>
                <td><span className={`hr-pill ${CASE_TONE[k.status]}`}>{k.statusLabel}</span></td>
                <td className="num">{k.files}</td>
                <td>{k.claimId
                  ? <button className="hr-link" onClick={(e) => { e.stopPropagation(); onOpenClaim(k.claimId!); }}>з претензії</button>
                  : <span className="hr-muted">вручну</span>}</td>
              </tr>
            ))}
            {!shown.length && <tr><td colSpan={8} className="hr-muted" style={{ padding: 16 }}>{rows.length ? "Справ за цим фільтром немає." : "Справ ще немає. Вони зʼявляються з претензій зі статусом «Передано в суд» або через «+ Справа»."}</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="hr-sect hr-muted">Ведеться вручну. Номер справи заповнюється, коли його присвоїть суд. Найближчі засідання зверху.</div>
    </div>
  );
}

function CaseDrawer({ meta, id, toast, onClose, onChanged, onCreated, onOpenClaim }: {
  meta: BaMeta; id: number | "new"; toast: Toast; onClose: () => void; onChanged: () => void;
  onCreated: (id: number) => void; onOpenClaim: (id: number) => void;
}) {
  const [card, setCard] = useState<BaCaseCard | null>(null);
  const [form, setForm] = useState({ title: "", plaintiff: "ТОВ «ЮТС»", defendant: "", caseNumber: "", filedOn: "", nextHearingOn: "", status: "prep" as BaCaseStatus });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    if (id === "new") return;
    fetchBaCase(id).then((k) => {
      setCard(k);
      setForm({ title: k.title, plaintiff: k.plaintiff, defendant: k.defendant, caseNumber: k.caseNumber, filedOn: k.filedOn ?? "", nextHearingOn: k.nextHearingOn ?? "", status: k.status });
    }).catch((e) => setErr(hiringError(e)));
  }, [id]);
  useEffect(load, [load]);
  useEscape(onClose);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = async () => {
    if (!form.title.trim()) { setErr("Вкажіть назву справи"); return; }
    setBusy(true); setErr(null);
    const body = { ...form, title: form.title.trim(), filedOn: form.filedOn || null, nextHearingOn: form.nextHearingOn || null };
    try {
      if (id === "new") { const nid = await createBaCase(body); onChanged(); onCreated(nid); toast("Справу створено. Тепер можна додати файли."); }
      else { await updateBaCase(id, body); onChanged(); load(); toast("Збережено"); }
    } catch (e) { setErr(hiringError(e)); } finally { setBusy(false); }
  };
  const archive = async (on: boolean) => {
    if (id === "new") return;
    try { await archiveBaCase(id, on); onChanged(); load(); toast(on ? "Перенесено в архів" : "Повернуто з архіву"); } catch (e) { toast(hiringError(e), { error: true }); }
  };

  const loading = id !== "new" && !card && !err;
  return createPortal(
    <div className="hr-overlay" onClick={onClose}>
      <aside className="hr-drawer" role="dialog" aria-label="Судова справа" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "start" }}>
          <div>
            <div className="hr-muted">Судова справа · {id === "new" ? "нова, вручну" : card?.claimId ? "створена з претензії" : "створена вручну"}</div>
            <h2 style={{ margin: "2px 0 12px", fontSize: 19 }}>{id === "new" ? "Нова справа" : card?.title ?? "…"}</h2>
          </div>
          <button className="hr-btn xs" onClick={onClose} aria-label="Закрити картку">×</button>
        </div>
        {loading ? <p className="loading-text">Завантаження…</p> : (<>
          {card?.archived && <div className="hr-note" style={{ background: "var(--warn-bg)", color: "var(--warn)", marginTop: 0, marginBottom: 10 }}>Справа в архіві. Її можна повернути кнопкою внизу.</div>}
          {card?.claimId && <div className="hr-note" style={{ marginTop: 0, marginBottom: 10 }}>Справа прийшла з претензії разом із документами. <button className="hr-link" onClick={() => onOpenClaim(card.claimId!)}>Відкрити претензію</button></div>}
          <div className="hr-kv">
            <span className="k">Назва справи</span><input className="hr-inp" value={form.title} onChange={set("title")} />
            <span className="k">Позивач</span><input className="hr-inp" value={form.plaintiff} onChange={set("plaintiff")} />
            <span className="k">Відповідач</span><input className="hr-inp" value={form.defendant} onChange={set("defendant")} />
            <span className="k">Номер справи</span><input className="hr-inp" placeholder="Коли присвоїть суд" value={form.caseNumber} onChange={set("caseNumber")} />
            <span className="k">Дата подання позову</span><input className="hr-inp" type="date" value={form.filedOn} onChange={set("filedOn")} />
            <span className="k">Наступне засідання</span><input className="hr-inp" type="date" value={form.nextHearingOn} onChange={set("nextHearingOn")} />
            <span className="k">Статус</span>
            <select className="hr-inp" value={form.status} onChange={set("status")}>
              {meta.caseStatuses.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </div>
          {err && <div style={{ color: "var(--danger)", fontSize: 12, marginTop: 8 }}>{err}</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12, flexWrap: "wrap" }}>
            {card && (card.archived
              ? <button className="hr-btn" onClick={() => void archive(false)}>Повернути з архіву</button>
              : <button className="hr-btn" onClick={() => void archive(true)}>В архів</button>)}
            <button className="hr-btn" onClick={onClose}>Скасувати</button>
            <button className="hr-btn p" disabled={busy} onClick={() => void save()}>{id === "new" ? "Створити" : "Зберегти"}</button>
          </div>
          {card && <>
            <Docs kind="cases" ownerId={card.id} files={card.fileList} types={meta.caseDocTypes} maxBytes={meta.fileMaxBytes} toast={toast} onAdded={() => { load(); onChanged(); }} />
            <History events={card.events} />
          </>}
          {id === "new" && <p className="hr-muted" style={{ marginTop: 14 }}>Файли можна додати після створення справи.</p>}
        </>)}
      </aside>
    </div>, document.body);
}

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";
import {
  fetchBaMeta, fetchBaClaims, fetchBaClaim, createBaClaim, updateBaClaim, archiveBaClaim,
  fetchBaCases, fetchBaCase, createBaCase, updateBaCase, archiveBaCase, uploadBaFile, fetchBaFileBlobUrl, hiringError,
  type BaMeta, type BaClaim, type BaClaimCard, type BaCase, type BaCaseCard, type BaClaimStatus, type BaCaseStatus,
  type BaDocType, type BaFile, type BaEvent,
} from "../../../api";
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
type Toast = (text: string, opts?: { error?: boolean; action?: { label: string; run: () => void } }) => void;

const LS_TAB = "ba.tab";
const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* приватне вікно */ } };

const money = (n: number | null) => (n == null ? "—" : `${n.toLocaleString("uk-UA", { maximumFractionDigits: 2 })} ₴`);
const fmtDate = (d: string | null) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : "—");
const fmtTs = (ts: string) => new Date(ts).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

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
  const [toastState, setToastState] = useState<{ text: string; error?: boolean; action?: { label: string; run: () => void }; key: number } | null>(null);

  useEffect(() => { fetchBaMeta().then(setMeta).catch((e) => setErr(hiringError(e))); }, []);
  // Посилання з дебіторки: `/ba?claim=ID` відкриває картку претензії одразу.
  useEffect(() => {
    const id = Number(params.get("claim"));
    if (Number.isInteger(id) && id > 0) {
      setTab("claims"); setOpenClaim(id);
      params.delete("claim"); setParams(params, { replace: true });
    }
  }, [params, setParams]);

  const toast: Toast = useCallback((text, opts) => {
    const key = Date.now();
    setToastState({ text, ...opts, key });
    window.setTimeout(() => setToastState((t) => (t && t.key === key ? null : t)), opts?.action ? 8000 : 4000);
  }, []);
  const pick = (t: Tab) => { setTab(t); lsSet(LS_TAB, t); };
  const refresh = () => setNonce((n) => n + 1);

  if (err) return <div className="chart-card"><b>Розділ «Бізнес-асистент» недоступний.</b> <span className="hr-muted">{err}</span></div>;
  if (!meta) return <p className="loading-text">Завантаження…</p>;

  const tabs: [Tab, string, boolean][] = [["claims", "Претензії", false], ["cases", "Судовий реєстр", false], ["equip", "Облік техніки", true], ["ttn", "ТТН-моніторинг", true]];
  return (
    <div>
      <h1 className="page-title" style={{ marginBottom: 4 }}>Бізнес-асистент</h1>
      <p className="hr-muted" style={{ margin: "0 0 14px", fontSize: 13 }}>
        Претензії, судові справи, видана техніка й ТТН в одному місці. Розділ бачать бізнес-асистент і керівництво.
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
      {tab === "equip" && <PlannedCard title="Облік техніки" will={[
        "Хто яку техніку отримав: співробітник із реєстру дашборда, назва й інвентарний номер, дата видачі, договір (файл).",
        "Статус «На руках / Повернено» з датою повернення, яке можна скасувати.",
        "Підсвічування техніки, що лишилась у звільнених співробітників.",
      ]} waits="Відповіді Сергія: техніка видається лише менеджерам чи будь-якому співробітнику." />}
      {tab === "ttn" && <PlannedCard title="ТТН-моніторинг" will={[
        "Щомісячна таблиця по менеджерах: наявні ТТН, необхідні ТТН, % відповідності.",
        "Динаміка за 6 місяців по кожному менеджеру.",
      ]} waits="Відповіді Сергія: що таке «необхідні ТТН» — число з CRM (у Kommo є поле «ТТН») чи ручна норма." />}

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
      {toastState && createPortal(
        <div className={`hr-toast ${toastState.error ? "err" : ""}`} role="status">
          <span>{toastState.text}</span>
          {toastState.action && <button onClick={() => { toastState.action!.run(); setToastState(null); }}>{toastState.action.label}</button>}
        </div>, document.body)}
    </div>
  );
}

function PlannedCard({ title, will, waits }: { title: string; will: string[]; waits: string }) {
  return (
    <div className="hr-card">
      <div className="hd"><h3>{title} · наступний етап</h3></div>
      <div className="hr-sect" style={{ borderTop: 0 }}>
        <h4>Що тут буде</h4>
        <ul className="hr-hist">{will.map((w) => <li key={w}>{w}</li>)}</ul>
        <h4 style={{ marginTop: 12 }}>Чого чекаємо</h4>
        <p style={{ margin: 0, fontSize: 13 }}>{waits}</p>
      </div>
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
  useEffect(() => { fetchBaClaims().then(setRows).catch((e) => setErr(hiringError(e))); }, [nonce]);

  const shown = useMemo(() => (rows ?? []).filter((c) => {
    if (status === "archive" ? !c.archived : c.archived) return false;
    if (status !== "all" && status !== "archive" && c.status !== status) return false;
    return !q || c.company.toLowerCase().includes(q.toLowerCase());
  }).sort((a, b) => {
    if (sort === "sum") return (b.debtAmount ?? -1) - (a.debtAmount ?? -1);
    if (sort === "days") return (b.overdueDays ?? -1) - (a.overdueDays ?? -1);
    // Невідправлені — зверху: це робота, яку ще треба зробити.
    if (!a.sentOn !== !b.sentOn) return a.sentOn ? 1 : -1;
    return (b.sentOn ?? "").localeCompare(a.sentOn ?? "") || b.id - a.id;
  }), [rows, status, q, sort]);

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
      <div className="hr-sect hr-muted">Сума боргу й дні прострочення беруться з «Активної дебіторки» в момент створення. Невідправлені претензії стоять зверху.</div>
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
  useEffect(() => { fetchBaCases().then(setRows).catch((e) => setErr(hiringError(e))); }, [nonce]);
  if (err) return <div className="chart-card"><span className="hr-muted">{err}</span></div>;
  if (!rows) return <p className="loading-text">Завантаження…</p>;
  const active = rows.filter((k) => !k.archived);
  const chips: [CaseFilter, string, number][] = [["all", "Усі", active.length],
    ...meta.caseStatuses.map((s) => [s.key, s.label, active.filter((k) => k.status === s.key).length] as [CaseFilter, string, number]),
    ["archive", "Архів", rows.length - active.length]];
  // Порядок — з сервера: найближчі засідання зверху.
  const shown = rows.filter((k) => (status === "archive" ? k.archived : !k.archived && (status === "all" || k.status === status)));
  return (
    <div className="hr-card">
      <div className="hd">
        <div className="hr-pills" role="group" aria-label="Фільтр за статусом" style={{ marginBottom: 0 }}>
          {chips.map(([k, l, n]) => <button key={k} className={status === k ? "on" : ""} aria-pressed={status === k} onClick={() => setStatus(k)}>{l} · {n}</button>)}
        </div>
        <button className="hr-btn p" onClick={() => onOpen("new")}>+ Справа</button>
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

// ── Спільне ──────────────────────────────────────────────────────────────────
function useEscape(onClose: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
}

/** Документи картки: список, перегляд (blob з токеном), додавання з типом. Видалення немає — документ справи є доказом. */
function Docs({ kind, ownerId, files, types, maxBytes, toast, onAdded }: {
  kind: "claims" | "cases"; ownerId: number; files: BaFile[]; types: { key: BaDocType; label: string }[];
  maxBytes: number; toast: Toast; onAdded: () => void;
}) {
  const [docType, setDocType] = useState<BaDocType>(types[0]?.key ?? "other");
  const [file, setFile] = useState<File | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (!file) { toast("Оберіть файл", { error: true }); return; }
    if (file.size > maxBytes) { toast("Файл більший за 10 МБ", { error: true }); return; }
    setBusy(true);
    try { await uploadBaFile(kind, ownerId, file, docType); setFile(null); setInputKey((k) => k + 1); onAdded(); toast("Документ додано"); }
    catch (e) { toast(hiringError(e), { error: true }); } finally { setBusy(false); }
  };
  // Перегляд — на місці, а не новою вкладкою: вкладку, відкриту після очікування, блокувальник
  // гасить мовчки (так «не клікався» скрин у задачі 4310). DOCX браузер не показує — лише «Завантажити».
  const [preview, setPreview] = useState<{ url: string; name: string; mime: string } | null>(null);
  const view = async (f: BaFile) => {
    try { setPreview({ url: await fetchBaFileBlobUrl(kind, ownerId, f.id), name: f.name, mime: f.mime }); }
    catch (e) { toast(hiringError(e), { error: true }); }
  };
  const closePreview = () => { if (preview) URL.revokeObjectURL(preview.url); setPreview(null); };
  return (
    <div className="hr-sect" style={{ marginTop: 14, paddingLeft: 0, paddingRight: 0 }}>
      <h4>{kind === "claims" ? "Документи" : "Файли"} · {files.length}</h4>
      {!files.length && <p className="hr-muted" style={{ margin: "0 0 8px" }}>Документів ще немає.</p>}
      {files.map((f) => (
        <div key={f.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "5px 0", borderBottom: "1px solid var(--border)", fontSize: 13 }}>
          <span className="hr-pill gr">{f.docTypeLabel}</span>
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{f.name}{f.fromClaim && <span className="hr-muted"> · з претензії</span>}</span>
          <span className="hr-muted">{fmtTs(f.createdAt).slice(0, 10)}</span>
          <button className="hr-btn xs" onClick={() => void view(f)}>Переглянути</button>
        </div>
      ))}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 10 }}>
        <select className="hr-inp" value={docType} onChange={(e) => setDocType(e.target.value as BaDocType)} aria-label="Тип документа">
          {types.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
        <input key={inputKey} type="file" accept=".pdf,.docx,.png,.jpg,.jpeg,.webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-label="Файл" />
        <button className="hr-btn xs" disabled={busy || !file} onClick={() => void add()}>Додати документ</button>
      </div>
      <p className="hr-muted" style={{ margin: "6px 0 0" }}>PDF, DOCX, PNG, JPG або WEBP, до 10 МБ.</p>
      {preview && createPortal(
        <div className="hr-modal-back" onClick={closePreview}>
          <div className="hr-modal" style={{ maxWidth: 900, width: "94vw" }} role="dialog" aria-label={`Документ ${preview.name}`} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
              <b style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{preview.name}</b>
              <a className="hr-btn xs" href={preview.url} download={preview.name}>Завантажити</a>
              <button className="hr-btn xs" onClick={closePreview} aria-label="Закрити перегляд">×</button>
            </div>
            {preview.mime.startsWith("image/")
              ? <img src={preview.url} alt={preview.name} style={{ maxWidth: "100%", maxHeight: "75vh", display: "block", margin: "0 auto" }} />
              : preview.mime === "application/pdf"
                ? <iframe src={preview.url} title={preview.name} style={{ width: "100%", height: "75vh", border: 0 }} />
                : <p className="hr-muted" style={{ margin: 0 }}>Цей формат браузер не показує. Натисніть «Завантажити», щоб відкрити файл.</p>}
          </div>
        </div>, document.body)}
    </div>
  );
}

function History({ events }: { events: BaEvent[] }) {
  return (
    <div className="hr-sect" style={{ paddingLeft: 0, paddingRight: 0 }}>
      <h4>Історія</h4>
      {!events.length ? <p className="hr-muted" style={{ margin: 0 }}>Подій ще немає.</p> : (
        <ul className="hr-hist">
          {events.map((e, i) => <li key={i}><span className="hr-muted">{fmtTs(e.at)}{e.actor ? ` · ${e.actor}` : ""}</span><br />{e.what}</li>)}
        </ul>
      )}
    </div>
  );
}

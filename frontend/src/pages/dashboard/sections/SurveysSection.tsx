/**
 * 📋 ОПИТУВАННЯ КОМАНДИ — екран за затвердженим макетом Сергія (`opytuvannya.html`, еталони O-01…O-15 у
 * `mockup/screens`). Розмітка й класи — макетні (CSS згенеровано з макета й ізольовано під `.srvx`,
 * `surveys.css`); шрифти макета — лише тут і в конструкторі (`mockFonts.css`, зі свого сервера).
 *
 * Логіка — з пакета (`client/SurveysPage.tsx`), дані — з `/api/surveys`. Відмінності від макета — лише там, де
 * макет жив у браузері, а дашборд має сервер:
 *  - «Дивитись як» і «Скинути демо» прибрано: роль — з профілю, «адмін» опитувань = право `manage_surveys`;
 *  - «Команда тім-ліда» і «Окремі люди» — наші команди й люди (`/people`), а не демо-список;
 *  - CSV — через `api` з токеном (blob): голе посилання пішло б без заголовка й отримало 401;
 *  - «демо: настав дедлайн» прибрано: закриває планувальник (`tickSurveys`, раз на 5 хв).
 *
 * Інваріанти пакета (НЕ ламати — рішення Сергія): результати бачить лише той, хто керує; решта — тільки свої
 * опитування; анонімне — без імен навіть для адміна, зміна відповіді неможлива, розрізи від 3 відповідей;
 * повтор за розкладом ВИМКНЕНО за замовчуванням; після запуску питання заморожені (дублюйте як нове).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import {
  surveysBadge, svClose, svCreate, svDeleteTemplate, svExportCsv, svGet, svLaunch, svList, svMarkRead, svNotifications,
  svParse, svPeople, svReopen, svRemind, svRespond, svResults, svSaveTemplate, svTemplates, svUpdate,
  type SurveysBadge, type SvAnswer, type SvAudience, type SvDraft, type SvFull, type SvListRow, type SvNotification,
  type SvPerson, type SvQType, type SvQuestion, type SvRecur, type SvRemind, type SvResults, type SvTemplate,
} from "../../../api";
import { useToast } from "../../../components/Toasts";
import "./mockFonts.css";
import "./surveys.css";

/* ── Тексти й довідники макета ── */
const TYPE_LBL: Record<SvQType, string> = {
  single: "одна відповідь", multi: "кілька відповідей", scale: "шкала", enps: "eNPS (0–10)",
  matrix: "матриця: рядки × шкала", rank: "ранжування", text: "вільний текст",
};
const ENPS_TEXT = "Наскільки ймовірно, що ви порекомендуєте UTS як місце роботи друзям чи знайомим?";
const SAMPLE_TEXT = `Опитування: Пульс команди — жовтень
Три хвилини, анонімно. Допоможе зрозуміти, що поправити в роботі.

1. Як ви оцінюєте своє навантаження за останній місяць?
а) Замало — можу брати більше
б) Нормально
в) Забагато — не встигаю

2. Що варто покращити насамперед? (можна кілька)
- Процеси й регламенти
- Комунікацію з тім-лідом
- Інструменти (СРМ, дашборд)
- Оплату й мотивацію

3. Оцініть від 1 до 10, наскільки зрозумілі нові регламенти

4. Чи вистачає вам зворотного зв’язку від керівника? (так/ні)

5. Що б ви змінили в першу чергу? (необов’язково)

6. Наскільки ймовірно, що ви порекомендуєте UTS як місце роботи? Оцініть від 0 до 10

7. Оцініть від 1 до 5, наскільки вас влаштовує:
- Процеси й регламенти
- Інструменти (СРМ, дашборд)
- Комунікація з тім-лідом

8. Розставте за пріоритетом, що покращити першим:
- Оплата
- Навантаження
- Навчання`;
const PASTE_PH = `1. Як ви оцінюєте навантаження за останній місяць?
а) Замало
б) Нормально
в) Забагато

2. Що варто покращити насамперед? (можна кілька)
- Процеси
- Комунікацію з тім-лідом
- Інструменти

3. Оцініть від 1 до 10, наскільки зрозумілі нові регламенти
4. Ваші пропозиції`;
const FORMAT_HELP = `Питання: нумерація «1.» «1)» «Питання 1:» або просто рядок зі знаком «?»
Варіанти: «а)» «б)» «A.» «-» «•» «○» «☐» «1)» під питанням
Кілька відповідей: позначка «(кілька)» у питанні або «☐ / [ ]» перед варіантами
Шкала: «від 1 до 10», «оцініть 1–5» — варіанти не потрібні
Так/Ні: «(так/ні)» у питанні
Відкрита відповідь: питання без варіантів
eNPS: «наскільки ймовірно, що порекомендуєте… від 0 до 10» — індекс порахується сам
Матриця: питання зі шкалою «оцініть від 1 до 5» + рядки-варіанти під ним
Ранжування: «розставте за пріоритетом» + варіанти
Необов’язкове: «(необов’язково)» у питанні
Перший рядок без номера — назва опитування, наступні до першого питання — опис`;
const AUD_CHIPS: Array<[SvAudience["kind"], string]> = [
  ["all", "Уся команда"], ["leads", "Усі тім-ліди"], ["managers", "Усі менеджери"], ["team", "Команда тім-ліда…"], ["custom", "Окремі люди"],
];

/* ── Дрібні помічники ── */
const pad = (n: number) => String(n).padStart(2, "0");
function fmtDue(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit" }) + " " + d.toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });
}
const fmtDate = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";
const daysLeft = (iso: string) => Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
function recurLabel(r: SvRecur) {
  const per = { week: "щотижня", "2week": "раз на 2 тижні", month: "щомісяця" }[r.per];
  return `${per}, ${["", "пн", "вт", "ср", "чт", "пт"][+r.day]} о ${r.time}`;
}
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0]).join("").toUpperCase();
const shortName = (name: string) => { const p = name.split(/\s+/).filter(Boolean); return p.length > 1 ? `${p[0]} ${p[1][0]}.` : name; };
function errText(e: unknown): string {
  const d = (e as { response?: { data?: { error?: string } } })?.response?.data;
  return d?.error ?? (e instanceof Error ? e.message : "Не вдалося виконати дію");
}
const range = (a: number, b: number) => Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i);
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const newQ = (text: string): SvQuestion => ({ text, type: "text", options: [], rows: [], min: 1, max: 10, required: true, hint: "", image: null });

/** Текст із .docx у браузері без бібліотек — порт із пакета (`client/api.ts`). */
async function docxText(buf: ArrayBuffer): Promise<string> {
  const u8 = new Uint8Array(buf); const dv = new DataView(buf); const dec = new TextDecoder(); let off = 0;
  while (off < u8.length - 4) {
    if (dv.getUint32(off, true) !== 0x04034b50) break;
    const method = dv.getUint16(off + 8, true); const csize = dv.getUint32(off + 18, true);
    const nlen = dv.getUint16(off + 26, true), xlen = dv.getUint16(off + 28, true);
    const name = dec.decode(u8.subarray(off + 30, off + 30 + nlen)); const dstart = off + 30 + nlen + xlen;
    if (name === "word/document.xml") {
      let data: Uint8Array = u8.subarray(dstart, dstart + csize);
      if (method === 8) {
        const ds = new DecompressionStream("deflate-raw");
        data = new Uint8Array(await new Response(new Blob([data as BlobPart]).stream().pipeThrough(ds)).arrayBuffer());
      }
      return dec.decode(data).replace(/<w:p[ >]/g, "\n<").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    }
    off = dstart + csize;
  }
  throw new Error("document.xml не знайдено");
}
const readFileText = async (f: File) => /\.docx$/i.test(f.name) ? docxText(await f.arrayBuffer()) : f.text();

/** Картинка до питання: стиснути до 900px, JPEG .85 → dataURL (сервер приймає лише такий і до 700 КБ). */
function shrinkImage(file: File, maxW = 900): Promise<string> {
  return new Promise((res, rej) => {
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, maxW / img.width); const c = document.createElement("canvas");
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); res(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("bad image")); };
    img.src = url;
  });
}
function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob); const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ── Стан форми створення (як `app.C` у макеті) ── */
interface CState {
  id: number | null; title: string; desc: string; questions: SvQuestion[]; audience: SvAudience; anon: boolean;
  due: string; dueTime: string; remind: SvRemind; allowEdit: boolean; recur: SvRecur; raw: string; rawSum: string;
}
function blankC(): CState {
  return {
    id: null, title: "", desc: "", questions: [], audience: { kind: "all", ids: [] }, anon: false,
    due: localDate(new Date(Date.now() + 3 * 86400000)), dueTime: "18:00",
    remind: { on: true, days: 1, time: "10:00", dayOf: true }, allowEdit: true,
    recur: { on: false, per: "week", day: 1, time: "09:00", days: 2 }, raw: "", rawSum: "",
  };
}
function cFromSurvey(s: SvFull): CState {
  const d = new Date(s.due);
  return {
    ...blankC(), id: s.id, title: s.title, desc: s.description || "", questions: clone(s.questions).map((q) => ({ ...q, hint: q.hint || "" })),
    audience: { kind: "all", ids: [], ...(s.audience || {}) }, anon: s.anon,
    due: s.due ? localDate(d) : blankC().due, dueTime: s.due ? localTime(d) : "18:00",
    remind: { ...blankC().remind, ...(s.remind || {}) }, allowEdit: s.allow_edit !== false, recur: { ...blankC().recur, ...(s.recur || {}) },
  };
}
function draftOf(C: CState): SvDraft {
  const due = C.due ? new Date(`${C.due}T${C.dueTime || "18:00"}`).toISOString() : "";
  return {
    title: C.title.trim(), desc: C.desc, questions: C.questions.map(({ unsure: _u, ...q }) => q), audience: C.audience, anon: C.anon,
    due, remind: C.remind, allowEdit: C.allowEdit && !C.anon, recur: C.recur,
  };
}

type View = { v: "list" } | { v: "create" } | { v: "results"; id: number } | { v: "mine" } | { v: "fill"; id: number };

/* ═══════════════════════════ СТОРІНКА ═══════════════════════════ */
export function SurveysSection() {
  const [badge, setBadge] = useState<SurveysBadge | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [list, setList] = useState<SvListRow[]>([]);
  const [mine, setMine] = useState<SvListRow[]>([]);
  const [templates, setTemplates] = useState<SvTemplate[]>([]);
  const [people, setPeople] = useState<SvPerson[]>([]);
  const [teams, setTeams] = useState<Array<{ id: number; name: string }>>([]);
  const [notifs, setNotifs] = useState<SvNotification[]>([]);
  const [bellOpen, setBellOpen] = useState(false);
  const [C, setC] = useState<CState>(blankC);
  const bellRef = useRef<HTMLDivElement>(null);
  const admin = !!badge?.canManage;

  // 🔔 Спільний тост дашборда (стандарт 07.10.2026). Доти тут був свій — унизу по центру, 3,2 с,
  // і помилка зникала так само швидко, як «Збережено».
  const showToast = useToast();
  const toast = useCallback((m: string, bad?: boolean) => showToast(m, { error: !!bad }), [showToast]);

  const reload = useCallback(async () => {
    const b = await surveysBadge();
    setBadge(b);
    setList(await svList());
    setMine(b.canManage ? (b.assigned > 0 ? await svList(true) : []) : []);
    setNotifs(await svNotifications().catch(() => []));
    if (b.canManage) setTemplates(await svTemplates().catch(() => []));
    return b;
  }, []);
  useEffect(() => {
    reload().then((b) => {
      setView(b.canManage ? { v: "list" } : { v: "mine" });
      if (b.canManage) svPeople().then((p) => { setPeople(p.people); setTeams(p.teams); }).catch(() => undefined);
    }).catch((e) => toast(errText(e), true));
  }, [reload, toast]);
  useEffect(() => {
    if (!bellOpen) return;
    const off = (e: MouseEvent) => { if (!bellRef.current?.contains(e.target as Node)) setBellOpen(false); };
    document.addEventListener("mousedown", off);
    return () => document.removeEventListener("mousedown", off);
  }, [bellOpen]);

  const go = (v: View) => { setView(v); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const teamName = (id?: string) => teams.find((t) => String(t.id) === String(id))?.name;
  const audienceLabel = (a?: SvAudience) => {
    if (!a) return "";
    return { all: "уся команда", leads: "усі тім-ліди", managers: "усі менеджери",
      team: a.team ? `${teamName(a.team) ?? "команда"} (з тім-лідом)` : "команда", custom: `${(a.ids || []).length} обраних` }[a.kind];
  };

  /* Дії над опитуванням — одне місце, як `act()` у макеті. */
  const act = async (a: string, id: number) => {
    try {
      if (a === "results") return go({ v: "results", id });
      if (a === "edit" || a === "dup") {
        const s = await svGet(id); const c = cFromSurvey(s);
        if (a === "dup") { c.id = null; c.title = s.title + " (копія)"; c.due = blankC().due; }
        setC(c); return go({ v: "create" });
      }
      if (a === "launch") { const r = await svLaunch(id); toast(`Запущено — отримали ${r.assigned}.`); await reload(); return go({ v: "results", id }); }
      if (a === "remind") { const r = await svRemind(id); toast(r.sent ? `Нагадування надіслано ${r.sent} людям.` : "Усі вже відповіли."); await reload(); return; }
      if (a === "close") { const s = list.find((x) => x.id === id); await svClose(id); toast("Опитування закрито." + (s?.recur?.on ? " Наступний випуск створено за розкладом." : "")); await reload(); return go({ v: "results", id }); }
      if (a === "reopen") { const r = await svReopen(id); toast("Відкрито знову — дедлайн " + fmtDue(r.due)); await reload(); return go({ v: "results", id }); }
      if (a === "totpl") { const s = await svGet(id); await svSaveTemplate({ name: s.title, questions: s.questions, anon: s.anon }); setTemplates(await svTemplates()); toast("Збережено як шаблон."); return; }
      if (a === "export") { saveBlob(await svExportCsv(id), `opytuvannya-${id}.csv`); toast("CSV збережено — відкривається в Excel."); return; }
    } catch (e) { toast(errText(e), true); }
  };

  const openNotif = async (n: SvNotification) => {
    setBellOpen(false);
    if (!n.read_at) { await svMarkRead(n.id).catch(() => undefined); setNotifs((x) => x.map((y) => y.id === n.id ? { ...y, read_at: new Date().toISOString() } : y)); }
    if (admin && n.kind === "summary") go({ v: "results", id: n.survey_id });
    else if (!admin || mine.some((s) => s.id === n.survey_id)) go({ v: "fill", id: n.survey_id });
    else go({ v: "results", id: n.survey_id });
  };

  if (!view) return <div className="srvx"><div className="empty">Завантаження…</div></div>;
  const unread = notifs.filter((n) => !n.read_at).length;
  const mineCount = badge?.fresh ?? 0;
  const tabs: Array<[View["v"], string]> = admin
    ? [["list", "Опитування"], ["create", "Створити"], ...(badge && badge.assigned > 0 ? [["mine", "Мої опитування"] as [View["v"], string]] : [])]
    : [["mine", "Мої опитування"]];
  const cur = ({ results: "list", fill: "mine" } as Record<string, string>)[view.v] || view.v;

  return (
    <div className="srvx">
      <div className="top">
        <h1>Опитування команди</h1>
        <div className="grow" />
        <div style={{ position: "relative" }} ref={bellRef}>
          <button className="iconbtn" title="Сповіщення" aria-label="Сповіщення" onClick={() => setBellOpen((o) => !o)}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" /></svg>
            <span className="dot" hidden={!unread}>{unread}</span>
          </button>
          <div className={`notifs ${bellOpen ? "open" : ""}`}>
            {notifs.length ? notifs.slice(0, 12).map((n) => (
              <div className="n" key={n.id} onClick={() => openNotif(n)} style={{ cursor: "pointer" }}>
                <span>{n.read_at ? "○" : "●"}</span><span style={{ flex: 1 }}>{n.text}</span><span className="tm">{fmtDue(n.created_at)}</span>
              </div>
            )) : <div className="empty" style={{ padding: 14 }}>Сповіщень немає.</div>}
          </div>
        </div>
      </div>

      <div className="tabs" role="tablist">
        {tabs.map(([k, t]) => (
          <button key={k} className="tab" role="tab" aria-selected={cur === k}
            onClick={() => { if (k === "create") setC(blankC()); go(k === "create" ? { v: "create" } : k === "mine" ? { v: "mine" } : { v: "list" }); }}>
            {t}{k === "mine" && mineCount ? <span className="cnt">{mineCount}</span> : null}
          </button>
        ))}
      </div>

      {view.v === "list" && admin && (
        <ListView list={list} templates={templates} audienceLabel={audienceLabel} act={act}
          onCreate={() => { setC(blankC()); go({ v: "create" }); }}
          onTemplate={(t) => { const c = blankC(); c.title = t.name; c.anon = t.anon; c.questions = clone(t.questions); setC(c); go({ v: "create" }); }}
          onTemplateDel={async (t) => { try { await svDeleteTemplate(t.id); setTemplates(await svTemplates()); } catch (e) { toast(errText(e), true); } }} />
      )}
      {view.v === "create" && admin && (
        <CreateView C={C} setC={setC} people={people} teams={teams} toast={toast}
          onCancel={() => go({ v: "list" })}
          onSaved={async (id, launched) => { await reload(); go(launched ? { v: "results", id } : { v: "list" }); }}
          onTemplateSaved={async () => setTemplates(await svTemplates())} />
      )}
      {view.v === "results" && admin && <ResultsView id={view.id} act={act} audienceLabel={audienceLabel} toast={toast} onBack={() => go({ v: "list" })} />}
      {view.v === "mine" && <MineView list={admin ? mine : list} open={(id) => go({ v: "fill", id })} />}
      {view.v === "fill" && <FillView id={view.id} toast={toast} onBack={() => go({ v: "mine" })} onDone={async () => { await reload(); go({ v: "mine" }); }} />}

    </div>
  );
}

function StatusPill({ s }: { s: SvListRow }) {
  if (s.status === "draft") return <span className="pill draft">чернетка</span>;
  if (s.status === "active") return <span className="pill active">● активне</span>;
  if (s.status === "closed") return <span className="pill closed">закрите</span>;
  return <span className="pill draft">заплановане</span>;
}

/* ═══════════════════════════ АДМІН: СПИСОК ═══════════════════════════ */
function ListView({ list, templates, audienceLabel, act, onCreate, onTemplate, onTemplateDel }: {
  list: SvListRow[]; templates: SvTemplate[]; audienceLabel: (a?: SvAudience) => string; act: (a: string, id: number) => void;
  onCreate: () => void; onTemplate: (t: SvTemplate) => void; onTemplateDel: (t: SvTemplate) => void;
}) {
  const [q, setQ] = useState(""); const [f, setF] = useState("");
  const rows = list.filter((s) => (!q || s.title.toLowerCase().includes(q.toLowerCase())) && (!f || s.status === f));
  const rec = list.filter((s) => s.recur?.on && s.status !== "closed");
  const btn = (a: string, id: number, t: string, primary = false) =>
    <button className={`btn sm ${primary ? "primary" : ""}`} onClick={(e) => { e.stopPropagation(); act(a, id); }}>{t}</button>;
  return (
    <section>
      <div className="grid">
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
            <div><h2>Усі опитування</h2><p className="hint" style={{ margin: 0 }}>Чернетки, активні й закриті. Клік по рядку — результати або редагування.</p></div>
            <button className="btn primary" onClick={onCreate}>+ Створити опитування</button>
          </div>
          <div className="row" style={{ marginBottom: 12 }}>
            <input type="text" placeholder="Пошук за назвою…" style={{ maxWidth: 280 }} value={q} onChange={(e) => setQ(e.target.value)} />
            <select style={{ width: "auto" }} value={f} onChange={(e) => setF(e.target.value)}>
              <option value="">Усі статуси</option><option value="active">Активні</option><option value="draft">Чернетки</option><option value="closed">Закриті</option>
            </select>
          </div>
          <div className="list">
            {rows.length ? rows.map((s) => {
              const n = s.assigned ?? 0; const r = s.responded ?? 0; const pct = n ? Math.round(100 * r / n) : 0;
              return (
                <div className="srow" key={s.id} onClick={() => act(s.status === "draft" ? "edit" : "results", s.id)}>
                  <div>
                    <div className="ttl">{s.title} <StatusPill s={s} /> {s.anon && <span className="pill anon">анонімно</span>} {s.recur?.on && <span className="pill draft">↻ повтор</span>}</div>
                    <div className="meta">
                      <span>{s.q_count} пит.</span><span>{audienceLabel(s.audience)}</span>
                      <span>{s.status === "closed" ? "закрито " + fmtDate(s.closed_at) : "до " + fmtDue(s.due)}</span>
                      {s.status !== "draft" && <span className="prog"><span className="bar"><i style={{ width: `${pct}%` }} /></span>{r}/{n}</span>}
                    </div>
                  </div>
                  <div className="acts">
                    {s.status === "draft" ? <>{btn("edit", s.id, "Редагувати")}{btn("launch", s.id, "Запустити", true)}</>
                      : s.status === "active" ? <>{btn("remind", s.id, "Нагадати")}{btn("results", s.id, "Результати")}{btn("close", s.id, "Закрити")}</>
                      : <>{btn("results", s.id, "Результати")}{btn("reopen", s.id, "Відкрити знову")}{btn("dup", s.id, "Дублювати")}</>}
                  </div>
                </div>
              );
            }) : <div className="empty">{list.length ? "Нічого не знайдено." : "Опитувань ще немає — створіть перше."}</div>}
          </div>
        </div>
        <aside className="card side">
          <h2>Шаблони</h2>
          <p className="hint">Збережені набори питань. Створення з шаблону — нове опитування з тими ж питаннями.</p>
          <div className="stack">
            {templates.length ? templates.map((t) => (
              <div className="tpl" key={t.id}>
                <span><b>{t.name}</b><br /><span style={{ color: "var(--muted)" }}>{t.questions.length} пит.{t.anon ? " · анонімно" : ""}</span></span>
                <span className="row" style={{ gap: 4 }}>
                  <button className="btn sm" onClick={() => onTemplate(t)}>Створити</button>
                  <button className="btn sm ghost danger" onClick={() => onTemplateDel(t)}>✕</button>
                </span>
              </div>
            )) : <div className="empty" style={{ padding: 16 }}>Шаблонів ще немає — кнопка «Зберегти як шаблон» у створенні.</div>}
          </div>
          <h2 style={{ marginTop: 22 }}>Повторювані</h2>
          <p className="hint">Опитування з увімкненим повтором запускаються самі за розкладом.</p>
          <div className="stack">
            {rec.length ? rec.map((s) => (
              <div className="tpl" key={s.id}>
                <span><b>{s.title}</b><br /><span style={{ color: "var(--muted)" }}>{recurLabel(s.recur!)} · випуск {s.issue ?? 1}</span></span>
                <button className="btn sm" onClick={() => act("results", s.id)}>Відкрити</button>
              </div>
            )) : <div className="empty" style={{ padding: 16 }}>Немає. Вмикається перемикачем при створенні.</div>}
          </div>
        </aside>
      </div>
    </section>
  );
}

/* ═══════════════════════════ АДМІН: СТВОРЕННЯ ═══════════════════════════ */
function CreateView({ C, setC, people, teams, toast, onCancel, onSaved, onTemplateSaved }: {
  C: CState; setC: (f: (c: CState) => CState) => void; people: SvPerson[]; teams: Array<{ id: number; name: string }>;
  toast: (m: string, bad?: boolean) => void; onCancel: () => void; onSaved: (id: number, launched: boolean) => void; onTemplateSaved: () => void;
}) {
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false); const [over, setOver] = useState(false);
  const [who, setWho] = useState("");
  const imgTarget = useRef(-1); const imgInput = useRef<HTMLInputElement>(null); const fileInput = useRef<HTMLInputElement>(null);
  const errRef = useRef<HTMLDivElement>(null);
  const set = <K extends keyof CState>(k: K, v: CState[K]) => setC((x) => ({ ...x, [k]: v }));
  const setQ = (i: number, patch: Partial<SvQuestion>) => setC((x) => ({ ...x, questions: x.questions.map((q, k) => k === i ? { ...q, ...patch } : q) }));
  const showErr = (m: string) => { setErr(m); setTimeout(() => errRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 0); };

  const doParse = async (text: string) => {
    try {
      const p = await svParse(text);
      const replace = !C.questions.length || window.confirm("Замінити поточні питання розібраними?");
      const byType: Record<string, number> = {}; p.questions.forEach((q) => { byType[q.type] = (byType[q.type] || 0) + 1; });
      const unsure = p.questions.filter((q) => q.unsure).length;
      const sum = p.questions.length
        ? `Розпізнано ${p.questions.length}: ${Object.entries(byType).map(([k, v]) => `${v} — ${TYPE_LBL[k as SvQType]}`).join(", ")}${unsure ? `. ⚠ ${unsure} варто перевірити` : ""}`
        : "Питань не знайдено — перевірте формат (підказка нижче).";
      setC((x) => ({
        ...x, raw: text, rawSum: sum,
        ...(replace ? { questions: p.questions.map((q) => ({ ...q, hint: q.hint || "" })), title: x.title.trim() ? x.title : p.title || x.title, desc: x.desc.trim() ? x.desc : p.desc || x.desc } : {}),
      }));
      setErr("");
    } catch (e) { toast(errText(e), true); }
  };
  const onFile = async (f: File) => {
    try { const t = await readFileText(f); set("raw", t); await doParse(t); toast("Файл прочитано: " + f.name); }
    catch { toast("Не вдалося прочитати файл", true); }
  };
  const changeType = (i: number, type: SvQType) => {
    const q = C.questions[i]; const p: Partial<SvQuestion> = { type, unsure: "" };
    if ((type === "single" || type === "multi" || type === "rank") && q.options.length < 2) p.options = [...q.options, "", ""].slice(0, Math.max(2, q.options.length));
    if (type === "matrix") {
      let rows = q.rows.length ? q.rows : q.options.slice();
      if (!q.rows.length && q.options.length) p.options = [];
      if (rows.length < 2) rows = [...rows, "", ""].slice(0, Math.max(2, rows.length));
      p.rows = rows;
      if (q.max - q.min > 10 || q.max <= q.min) { p.min = 1; p.max = 5; }
    }
    if (type === "enps") { p.min = 0; p.max = 10; if (!q.text || q.text === "Нове питання") p.text = ENPS_TEXT; }
    setQ(i, p);
  };
  const move = (i: number, d: number) => setC((x) => {
    const j = i + d; if (j < 0 || j >= x.questions.length) return x;
    const qs = x.questions.slice(); [qs[i], qs[j]] = [qs[j], qs[i]]; return { ...x, questions: qs };
  });

  const audUsers = useMemo(() => {
    const a = C.audience; const grp = people.filter((p) => !p.isAdmin);
    if (a.kind === "all") return grp;
    if (a.kind === "leads") return grp.filter((p) => p.role === "lead");
    if (a.kind === "managers") return grp.filter((p) => p.role === "manager");
    if (a.kind === "team") return grp.filter((p) => a.team && String(p.teamId) === String(a.team));
    return people.filter((p) => (a.ids || []).map(Number).includes(p.id));
  }, [C.audience, people]);

  /** Ті самі перевірки, що в макеті (`validateC`); сервер повторить їх сам (`validateSurvey`). */
  const validate = (forLaunch: boolean): string | null => {
    if (!C.title.trim()) return "Вкажіть назву опитування.";
    if (!forLaunch) return null;
    if (!C.questions.length) return "Додайте хоча б одне питання.";
    for (const [i, q] of C.questions.entries()) {
      if (!q.text.trim()) return `Питання ${i + 1} без тексту.`;
      if ((q.type === "single" || q.type === "multi" || q.type === "rank") && q.options.filter((o) => o.trim()).length < 2) return `Питання ${i + 1}: потрібно щонайменше два варіанти.`;
      if (q.type === "matrix" && q.rows.filter((o) => o.trim()).length < 2) return `Питання ${i + 1}: матриці потрібно щонайменше два рядки.`;
      if ((q.type === "scale" || q.type === "matrix") && !(q.max > q.min)) return `Питання ${i + 1}: шкала має бути від меншого до більшого.`;
    }
    if (!audUsers.length) return "Оберіть, кому надіслати.";
    if (!C.due) return "Вкажіть дедлайн.";
    if (new Date(`${C.due}T${C.dueTime}`) < new Date()) return "Дедлайн уже минув — оберіть майбутню дату.";
    return null;
  };
  const save = async (launch: boolean) => {
    const e = validate(launch); if (e) return showErr(e);
    setBusy(true); setErr("");
    try {
      const d = draftOf(C);
      const { id } = C.id ? await svUpdate(C.id, d) : await svCreate(d);
      if (launch) {
        try { const r = await svLaunch(id); toast(`Запущено — отримали ${r.assigned}.`); }
        catch (x) { setC((c) => ({ ...c, id })); throw x; }
      } else toast("Чернетку збережено.");
      onSaved(id, launch);
    } catch (x) { showErr(errText(x)); } finally { setBusy(false); }
  };
  const saveTpl = async () => {
    if (!C.questions.length) return showErr("Спершу додайте питання.");
    try { await svSaveTemplate({ name: C.title.trim() || "Без назви", questions: C.questions.map(({ unsure: _u, ...q }) => q), anon: C.anon }); onTemplateSaved(); toast("Шаблон збережено."); }
    catch (x) { showErr(errText(x)); }
  };

  const optsEd = (i: number, q: SvQuestion, key: "options" | "rows", sq: boolean) => (
    <>
      <div className="opts">
        {q[key].map((o, j) => (
          <div className="opt" key={j}>
            <span className={`mk ${sq ? "sq" : ""}`} />
            <input type="text" value={o} onChange={(e) => setQ(i, { [key]: q[key].map((x, k) => k === j ? e.target.value : x) } as Partial<SvQuestion>)} />
            <button className="x" title="Прибрати" onClick={() => setQ(i, { [key]: q[key].filter((_, k) => k !== j) } as Partial<SvQuestion>)}>✕</button>
          </div>
        ))}
      </div>
      <button className="add" onClick={() => setQ(i, { [key]: [...q[key], ""], unsure: key === "options" ? "" : q.unsure } as Partial<SvQuestion>)}>+ {key === "rows" ? "рядок" : "варіант"}</button>
    </>
  );
  const scaleEd = (i: number, q: SvQuestion) => (
    <div className="scale">від <input type="number" value={q.min} min={0} max={99} onChange={(e) => setQ(i, { min: +e.target.value })} /> до <input type="number" value={q.max} min={1} max={100} onChange={(e) => setQ(i, { max: +e.target.value })} /></div>
  );
  const whoQ = who.trim().toLowerCase();

  return (
    <section>
      <div className="grid">
        <div className="stack">
          <div className="card">
            <h2>{C.id ? "Редагування чернетки" : "Нове опитування"}</h2>
            <p className="hint">Назва — те, що побачить команда. Опис необов’язковий.</p>
            <div className="stack">
              <label className="f"><span>Назва <span className="req">*</span></span><input type="text" placeholder="Напр. Пульс команди: жовтень" value={C.title} onChange={(e) => set("title", e.target.value)} /></label>
              <label className="f">Опис для респондентів<textarea style={{ minHeight: 64 }} placeholder="Навіщо це опитування і скільки займе часу" value={C.desc} onChange={(e) => set("desc", e.target.value)} /></label>
            </div>
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}><span className="n">1</span>Питання</h3>
            <p className="hint">Вставте текст із питаннями й варіантами — як сформулювали у Claude, нотатках чи Word. Система сама розбере, де питання, де варіанти й якого типу відповідь. Потім усе можна поправити руками.</p>
            <textarea className="paste" placeholder={PASTE_PH} value={C.raw} onChange={(e) => set("raw", e.target.value)} />
            <div className="parsebar">
              <button className="btn primary" onClick={() => doParse(C.raw)}>Розібрати текст</button>
              <button className="btn" onClick={() => { set("raw", SAMPLE_TEXT); doParse(SAMPLE_TEXT); }}>Вставити приклад</button>
              <span className="sum">{C.rawSum}</span>
            </div>
            <div className={`drop ${over ? "over" : ""}`}
              onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
              onDrop={(e: DragEvent) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) onFile(f); }}>
              Або перетягніть сюди файл <b onClick={() => fileInput.current?.click()} style={{ cursor: "pointer" }}>docx / txt</b> — текст буде розібрано так само
              <input type="file" ref={fileInput} accept=".docx,.txt" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
            </div>
            <details className="fmt"><summary>Який формат розуміє розбір</summary><pre>{FORMAT_HELP}</pre></details>
            <h3><span className="n">2</span>Перевірте розібрані питання <span style={{ fontWeight: 500, color: "var(--muted)" }}>{C.questions.length ? `— ${C.questions.length}` : ""}</span></h3>
            <div className="qs">
              {C.questions.length ? C.questions.map((q, i) => (
                <div className={`q ${q.unsure ? "unsure" : ""}`} key={i}>
                  <div className="qh"><span className="qn">{i + 1}.</span>
                    <input type="text" value={q.text} placeholder="Текст питання" onChange={(e) => setQ(i, { text: e.target.value })} />
                    <select className="qtype" value={q.type} onChange={(e) => changeType(i, e.target.value as SvQType)}>
                      {Object.entries(TYPE_LBL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                    <span className="tools">
                      <button title="Картинка до питання" onClick={() => { imgTarget.current = i; imgInput.current?.click(); }}>🖼</button>
                      <button title="Вище" onClick={() => move(i, -1)}>↑</button>
                      <button title="Нижче" onClick={() => move(i, 1)}>↓</button>
                      <button title="Видалити" onClick={() => setC((x) => ({ ...x, questions: x.questions.filter((_, k) => k !== i) }))}>✕</button>
                    </span>
                  </div>
                  {q.image && <div className="qimgwrap"><img className="qimg" src={q.image} alt="" /><button className="x" title="Прибрати картинку" onClick={() => setQ(i, { image: null })}>✕ картинку</button></div>}
                  {q.type === "single" || q.type === "multi" ? optsEd(i, q, "options", q.type === "multi")
                    : q.type === "rank" ? <><div className="textnote" style={{ fontStyle: "normal" }}>Респондент розставить варіанти по порядку — від найважливішого.</div>{optsEd(i, q, "options", false)}</>
                    : q.type === "matrix" ? <>{scaleEd(i, q)}<div className="textnote" style={{ fontStyle: "normal", marginTop: 4 }}>Рядки, які оцінюють за цією шкалою:</div>{optsEd(i, q, "rows", true)}</>
                    : q.type === "scale" ? scaleEd(i, q)
                    : q.type === "enps" ? <div className="textnote" style={{ fontStyle: "normal" }}>Шкала 0–10. Індекс рахується сам: % тих, хто поставив 9–10, мінус % тих, хто 0–6.</div>
                    : <div className="textnote">Респондент напише відповідь своїми словами.</div>}
                  {q.hint ? <div className="textnote" style={{ fontStyle: "normal", marginTop: 6 }}>Пояснення: <input type="text" value={q.hint} onChange={(e) => setQ(i, { hint: e.target.value })} style={{ width: "70%", border: "1px solid var(--line)", borderRadius: 8, padding: "3px 8px" }} /></div> : null}
                  <label className="req"><input type="checkbox" checked={q.required} onChange={(e) => setQ(i, { required: e.target.checked })} style={{ width: "auto", margin: 0 }} /> обов’язкове</label>
                  {q.unsure && <div className="why">⚠ {q.unsure}</div>}
                </div>
              )) : <div className="empty">Питань поки немає — вставте текст вище й натисніть «Розібрати», або додайте вручну.</div>}
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn" onClick={() => set("questions", [...C.questions, { ...newQ("Нове питання"), type: "single", options: ["Варіант 1", "Варіант 2"] }])}>+ Додати питання вручну</button>
              <button className="btn" title="Стандартне питання лояльності 0–10, індекс рахується сам" onClick={() => {
                if (C.questions.some((q) => q.type === "enps")) return toast("eNPS-питання вже є — одного досить.", true);
                set("questions", [...C.questions, { ...newQ(ENPS_TEXT), type: "enps", min: 0, max: 10 }]); toast("Додано eNPS-питання. Індекс порахується сам.");
              }}>+ eNPS одним кліком</button>
              <input type="file" ref={imgInput} accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => {
                const f = e.target.files?.[0]; e.target.value = ""; if (!f) return; const i = imgTarget.current;
                shrinkImage(f).then((url) => { setQ(i, { image: url }); toast(`Картинку додано до питання ${i + 1}.`); }).catch(() => toast("Не вдалося прочитати картинку", true));
              }} />
            </div>
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}><span className="n">3</span>Кому надіслати</h3>
            <div className="aud">
              {AUD_CHIPS.map(([k, t]) => <button key={k} className="chip" aria-pressed={C.audience.kind === k} onClick={() => set("audience", { ...C.audience, kind: k })}>{t}</button>)}
            </div>
            {C.audience.kind === "team" && (
              <div className="row" style={{ marginTop: 10 }}>
                {teams.map((t) => {
                  const lead = people.find((p) => p.teamId === t.id && p.role === "lead");
                  return <button key={t.id} className="chip" aria-pressed={String(C.audience.team) === String(t.id)} onClick={() => set("audience", { ...C.audience, team: String(t.id) })}>{t.name}{lead ? ` · ${lead.name}` : ""}</button>;
                })}
              </div>
            )}
            {C.audience.kind === "custom" && <>
              <input type="text" placeholder="Пошук людини…" value={who} onChange={(e) => setWho(e.target.value)} style={{ maxWidth: 280, marginTop: 10 }} />
              <div className="people">
                {people.filter((p) => !whoQ || p.name.toLowerCase().includes(whoQ) || (p.team || "").toLowerCase().includes(whoQ)).map((p) => {
                  const on = (C.audience.ids || []).map(Number).includes(p.id);
                  return (
                    <button key={p.id} className={`person ${p.role === "lead" ? "lead" : ""}`} aria-pressed={on}
                      onClick={() => set("audience", { ...C.audience, ids: on ? (C.audience.ids || []).filter((x) => Number(x) !== p.id) : [...(C.audience.ids || []), p.id] })}>
                      <span className="av">{initials(p.name)}</span>{p.name}<span className="r">{p.role === "lead" ? "лід" : p.team || p.role}</span>
                    </button>
                  );
                })}
              </div>
            </>}
            <p className="hint" style={{ margin: "10px 0 0" }}>{audUsers.length ? `Отримають ${audUsers.length}: ${audUsers.map((u) => shortName(u.name)).join(", ")}` : "Нікого не обрано."}</p>
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}><span className="n">4</span>Налаштування</h3>
            <div className="stack">
              <label className={`sw anon ${C.anon ? "on" : ""}`}><input type="checkbox" checked={C.anon} onChange={(e) => setC((x) => ({ ...x, anon: e.target.checked, allowEdit: e.target.checked ? false : x.allowEdit }))} /><span className="tg" />
                <span><span className="t">Анонімне опитування</span><span className="d">Відповіді не прив’язуються до людей — навіть адмін бачить лише зведення. Респонденти бачать позначку «анонімно». Розрізи по групах показуються лише від 3 осіб.</span></span></label>
              <div className="row">
                <label className="f" style={{ flex: 1, minWidth: 160 }}><span>Дедлайн <span className="req">*</span></span><input type="date" value={C.due} onChange={(e) => set("due", e.target.value)} /></label>
                <label className="f" style={{ width: 130 }}>Час<input type="time" value={C.dueTime} onChange={(e) => set("dueTime", e.target.value)} /></label>
              </div>
              <label className={`sw ${C.remind.on ? "on" : ""}`}><input type="checkbox" checked={C.remind.on} onChange={(e) => set("remind", { ...C.remind, on: e.target.checked })} /><span className="tg" />
                <span><span className="t">Нагадування</span><span className="d">Сповіщення в дашборді тим, хто ще не відповів.</span>
                  <span className="sub">за <select value={C.remind.days} onChange={(e) => set("remind", { ...C.remind, days: +e.target.value })}><option value={1}>1 день</option><option value={2}>2 дні</option><option value={3}>3 дні</option></select> до дедлайну о <input type="time" value={C.remind.time} onChange={(e) => set("remind", { ...C.remind, time: e.target.value })} /> <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5 }}><input type="checkbox" checked={C.remind.dayOf} onChange={(e) => set("remind", { ...C.remind, dayOf: e.target.checked })} style={{ width: "auto", margin: 0 }} /> і в день дедлайну</label></span></span></label>
              <label className={`sw ${C.allowEdit && !C.anon ? "on" : ""}`} style={{ opacity: C.anon ? 0.5 : 1 }} title={C.anon ? "В анонімному опитуванні відповідь не прив’язана до людини — змінити її неможливо" : ""}>
                <input type="checkbox" checked={C.allowEdit && !C.anon} onChange={(e) => { if (C.anon) return toast("В анонімному опитуванні відповідь змінити неможливо.", true); set("allowEdit", e.target.checked); }} /><span className="tg" />
                <span><span className="t">Дозволити змінювати відповідь до дедлайну</span><span className="d">Вимкнено — подав і все. Увімкнено — можна повернутись і поправити, поки опитування активне.</span></span></label>
              <label className={`sw ${C.recur.on ? "on" : ""}`}><input type="checkbox" checked={C.recur.on} onChange={(e) => set("recur", { ...C.recur, on: e.target.checked })} /><span className="tg" />
                <span><span className="t">Повторювати за розкладом</span><span className="d">Вимкнено за замовчуванням. Увімкнене — після закриття система сама створює й запускає наступний випуск з тими ж питаннями.</span>
                  <span className="sub">
                    <select value={C.recur.per} onChange={(e) => set("recur", { ...C.recur, per: e.target.value as SvRecur["per"] })}><option value="week">щотижня</option><option value="2week">раз на два тижні</option><option value="month">щомісяця</option></select> у{" "}
                    <select value={C.recur.day} onChange={(e) => set("recur", { ...C.recur, day: +e.target.value })}>{["понеділок", "вівторок", "середу", "четвер", "п’ятницю"].map((n, i) => <option key={i} value={i + 1}>{n}</option>)}</select> о{" "}
                    <input type="time" value={C.recur.time} onChange={(e) => set("recur", { ...C.recur, time: e.target.value })} /> · відповісти за{" "}
                    <select value={C.recur.days} onChange={(e) => set("recur", { ...C.recur, days: +e.target.value })}><option value={2}>2 дні</option><option value={3}>3 дні</option><option value={5}>5 днів</option></select>
                  </span></span></label>
            </div>
            <div className="row" style={{ marginTop: 16, justifyContent: "space-between" }}>
              <div className="row">
                <button className="btn" disabled={busy} onClick={() => save(false)}>Зберегти чернетку</button>
                <button className="btn" disabled={busy} onClick={saveTpl}>Зберегти як шаблон</button>
              </div>
              <div className="row">
                <button className="btn ghost" onClick={onCancel}>Скасувати</button>
                <button className="btn primary" disabled={busy} onClick={() => save(true)}>Запустити опитування →</button>
              </div>
            </div>
            <div className="notice bad" ref={errRef} hidden={!err} style={{ marginTop: 10 }}>{err}</div>
          </div>
        </div>

        <aside className="card side">
          <h2>Як це побачить команда</h2>
          <p className="hint">Живе прев’ю форми відповідей.</p>
          <div className="fill">
            {C.questions.length ? <>
              {C.anon && <div className="notice anon" style={{ marginBottom: 8 }}>🔒 Анонімно — відповіді не прив’язуються до вас.</div>}
              {C.questions.map((q, i) => <FillQ key={i} q={q} i={i} name={`p${i}`} disabled />)}
            </> : <div className="empty">Тут з’явиться форма, як тільки будуть питання.</div>}
          </div>
        </aside>
      </div>
    </section>
  );
}

/* ═══════════════════════════ ОДНЕ ПИТАННЯ ФОРМИ (прев’ю й відповідь) ═══════════════════════════ */
function FillQ({ q, i, name, value, onChange, disabled, missing }: {
  q: SvQuestion; i: number; name: string; value?: SvAnswer; onChange?: (v: SvAnswer | undefined) => void; disabled?: boolean; missing?: boolean;
}) {
  const [drag, setDrag] = useState<number | null>(null);
  const set = (v: SvAnswer | undefined) => onChange?.(v);
  const scaleBtns = (min: number, max: number) => range(min, max).map((k) => (
    <label key={k}><input type="radio" name={name} checked={value === k} disabled={disabled} onChange={() => set(k)} />{k}</label>
  ));
  let body: ReactNode;
  if (q.type === "single") body = <div className="ch">{q.options.map((o, j) => <label key={j}><input type="radio" name={name} checked={value === o} disabled={disabled} onChange={() => set(o)} />{o}</label>)}</div>;
  else if (q.type === "multi") {
    const cur = Array.isArray(value) ? (value as string[]) : [];
    body = <div className="ch">{q.options.map((o, j) => <label key={j}><input type="checkbox" name={name} checked={cur.includes(o)} disabled={disabled}
      onChange={(e) => { const nx = e.target.checked ? [...cur, o] : cur.filter((x) => x !== o); set(nx.length ? nx : undefined); }} />{o}</label>)}</div>;
  } else if (q.type === "scale") body = <><div className="sc">{scaleBtns(q.min, q.max)}</div><div className="sclbl"><span>{q.min} — зовсім ні</span><span>{q.max} — повністю</span></div></>;
  else if (q.type === "enps") body = <><div className="sc">{scaleBtns(0, 10)}</div><div className="sclbl"><span>0 — точно ні</span><span>10 — обов’язково</span></div></>;
  else if (q.type === "matrix") {
    const cur = (value && typeof value === "object" && !Array.isArray(value)) ? (value as Record<string, number>) : {};
    const cols = range(q.min, q.max);
    body = <div className="mx"><table><thead><tr><th />{cols.map((k) => <th key={k}>{k}</th>)}</tr></thead>
      <tbody>{q.rows.map((r, ri) => <tr key={ri}><td>{r}</td>{cols.map((k) => <td key={k}><input type="radio" name={`${name}__${ri}`} checked={cur[r] === k} disabled={disabled} onChange={() => set({ ...cur, [r]: k })} /></td>)}</tr>)}</tbody></table></div>;
  } else if (q.type === "rank") {
    const order = Array.isArray(value) && value.length === q.options.length ? (value as string[]) : q.options.slice();
    const mv = (k: number, d: number) => { const j = k + d; if (j < 0 || j >= order.length) return; const o = order.slice(); [o[k], o[j]] = [o[j], o[k]]; set(o); };
    body = <><div className="rk">{order.map((o, k) => (
      <div key={o + k} className={`ri ${drag === k ? "drag" : ""}`} draggable={!disabled}
        onDragStart={() => setDrag(k)} onDragEnd={() => setDrag(null)} onDragOver={(e) => e.preventDefault()}
        onDrop={() => { if (drag === null || drag === k) return; const o2 = order.slice(); const [x] = o2.splice(drag, 1); o2.splice(k, 0, x); set(o2); setDrag(null); }}>
        <span className="pos">{k + 1}</span><span className="lb">{o}</span>
        {!disabled && <span className="mv"><button type="button" title="Вище" onClick={() => mv(k, -1)}>↑</button><button type="button" title="Нижче" onClick={() => mv(k, 1)}>↓</button></span>}
      </div>))}</div><div className="sclbl" style={{ justifyContent: "flex-start" }}>1 — найважливіше. Перетягніть або стрілками.</div></>;
  } else body = <textarea name={name} placeholder="Ваша відповідь" disabled={disabled} value={typeof value === "string" ? value : ""} onChange={(e) => set(e.target.value || undefined)} />;
  return (
    <div className={`fq ${missing ? "missing" : ""}`} data-fq={name}>
      <div className="ft"><span className="qn">{i + 1}.</span><span>{q.text}{q.required && <> <span style={{ color: "var(--brand)" }}>*</span></>}</span></div>
      {q.hint ? <div className="fhint">{q.hint}</div> : null}
      {q.image ? <img className="qimg" src={q.image} alt="" /> : null}
      {body}
    </div>
  );
}

/* ═══════════════════════════ АДМІН: РЕЗУЛЬТАТИ ═══════════════════════════ */
function sparkline(nums: Array<number | null>) {
  const pts = nums.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] !== null);
  if (pts.length < 2) return null;
  const vs = pts.map((p) => p[1]); const mn = Math.min(...vs), mx = Math.max(...vs); const rng = mx - mn || 1;
  const W = 72, H = 22, n = nums.length - 1;
  const xy = pts.map(([i, v]) => [(i / n) * (W - 6) + 3, H - 3 - ((v - mn) / rng) * (H - 8)]);
  const d = xy.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const last = xy[xy.length - 1];
  return <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true"><path d={d} fill="none" stroke="var(--data)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /><circle cx={last[0].toFixed(1)} cy={last[1].toFixed(1)} r="3" fill="var(--data)" /></svg>;
}

function ResultsView({ id, act, audienceLabel, toast, onBack }: {
  id: number; act: (a: string, id: number) => Promise<void>; audienceLabel: (a?: SvAudience) => string; toast: (m: string, bad?: boolean) => void; onBack: () => void;
}) {
  const [slice, setSlice] = useState("all");
  const [r, setR] = useState<SvResults | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(() => svResults(id, slice).then((x) => { setR(x); setErr(""); }).catch((e) => setErr(errText(e))), [id, slice]);
  useEffect(() => { load(); }, [load]);
  const run = async (a: string) => { await act(a, id); load(); };
  if (!r) return <div className="card">{err ? <div className="notice bad">{err}</div> : <div className="empty">Завантаження…</div>}</div>;
  const s = r.survey; const p = r.participation;
  const pct = p.assigned ? Math.round(100 * p.responded / p.assigned) : 0;
  const dl = daysLeft(s.due);
  const slices: Array<[string, string]> = [["all", "Усі"], ["managers", "Менеджери"], ["leads", "Тім-ліди"], ...r.teams.map((t) => ["team:" + t, t] as [string, string])];
  const nameOf = new Map(p.respondedList.map((x) => [String(x.id), x.name]));
  const trend = r.trend;
  const lastCol = trend ? trend.participation.length - 1 : -1;

  return (
    <section>
      <div className="grid">
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
            <div><h2>{s.title}</h2>
              <div className="row" style={{ gap: 6, marginTop: 4 }}><StatusPill s={s} /> {s.anon && <span className="pill anon">анонімно</span>} <span className="hint" style={{ margin: 0 }}>{audienceLabel(s.audience)} · {s.status === "closed" ? "закрито " + fmtDate(s.closed_at) : "дедлайн " + fmtDue(s.due)}</span></div></div>
            <button className="btn ghost" onClick={onBack}>← до списку</button>
          </div>
          {s.description ? <p className="hint" style={{ marginTop: 8 }}>{s.description}</p> : null}
          <div className="kpis">
            <div className="kpi"><div className="v">{p.responded}<span style={{ fontSize: 14, color: "var(--muted)" }}> / {p.assigned}</span></div><div className="l">відповіли</div></div>
            <div className="kpi"><div className="v">{pct}%</div><div className="l">участь</div></div>
            <div className="kpi"><div className="v">{s.status === "active" ? Math.max(dl, 0) : "—"}</div><div className="l">{s.status === "active" ? (dl >= 0 ? "днів до дедлайну" : "прострочено") : "днів"}</div></div>
            {r.enps && <div className="kpi enps"><div className="v">{r.enps.score === null ? "—" : (r.enps.score > 0 ? "+" : "") + r.enps.score}</div><div className="l">eNPS</div></div>}
            <div className="kpi"><div className="v">{s.questions.length}</div><div className="l">питань</div></div>
          </div>
          {trend && trend.participation.length >= 2 && (
            <div className="trend"><h3 style={{ margin: "0 0 8px" }}>↻ Динаміка по випусках <small style={{ fontWeight: 500, color: "var(--muted)" }}>{trend.participation.length} випуски · стрілка — зміна проти попереднього</small></h3>
              <div style={{ overflowX: "auto" }}><table className="ttab">
                <thead><tr><th /><th />{trend.participation.map((c, k) => <th key={c.issue} className={k === lastCol ? "cur" : ""}>№{c.issue}<small>{c.status === "closed" ? fmtDate(c.closedAt) : "триває"}</small></th>)}</tr></thead>
                <tbody>
                  <tr><td className="ql">Участь</td><td />{trend.participation.map((c, k) => <td key={c.issue} className={k === lastCol ? "cur" : ""}><b>{c.pct}%</b><small>{c.responded}/{c.assigned}</small></td>)}</tr>
                  {trend.rows.map((row) => {
                    const qi = s.questions.findIndex((q) => String(q.id) === String(row.questionId));
                    return <tr key={String(row.questionId)}><td className="ql"><span className="qn">{qi + 1}.</span> {row.text} <small>{row.lbl}</small></td><td className="spark">{sparkline(row.cells.map((c) => c ? c.v : null))}</td>
                      {row.cells.map((c, k) => <td key={k} className={k === lastCol ? "cur" : ""}>{c ? <><b>{c.out}</b>{c.delta !== null && <span className={c.delta > 0 ? "up" : "down"}>{c.delta > 0 ? "↑" : "↓"} {c.deltaOut}</span>}</> : "—"}</td>)}</tr>;
                  })}
                </tbody></table></div></div>
          )}
          {s.status === "draft" && <div className="notice info">Це чернетка — відповідей ще немає. Запустіть, щоб команда отримала опитування.</div>}
          {s.status === "closed" && s.closed_by === "auto" && <div className="notice info">Закрито автоматично по дедлайну — підсумок надіслано адміністраторам.</div>}
          <div className="slices">
            {slices.map(([k, t]) => {
              const cnt = r.sliceCounts?.[k] ?? 0; const hidden = s.anon && k !== "all" && cnt < 3;
              return <button key={k} className="chip" aria-pressed={slice === k} disabled={hidden} title={hidden ? "Анонімне опитування: розріз показується лише для груп від 3 відповідей" : undefined}
                onClick={() => setSlice(k)}>{t} <span style={{ opacity: 0.6 }}>{hidden ? "🔒" : cnt}</span></button>;
            })}
          </div>
          {err && <div className="notice bad">{err}</div>}
          {(r.sliceCounts?.all ?? 0) ? r.results.map((res, i) => {
            const q = s.questions[i]; if (!q) return null;
            return (
              <div className="rq" key={res.questionId}>
                <div className="rt"><span className="qn">{i + 1}.</span><span>{q.text}</span><span className="typ">{TYPE_LBL[q.type]} · {res.n}</span></div>
                {q.image ? <img className="qimg small" src={q.image} alt="" /> : null}
                <ResultBody q={q} res={res} anon={s.anon} nameOf={nameOf} />
              </div>
            );
          }) : <div className="empty">Відповідей поки немає.</div>}
        </div>

        <aside className="card side">
          <h2>Дії</h2>
          <div className="stack">
            {s.status === "draft" && <><button className="btn primary" onClick={() => run("launch")}>Запустити</button><button className="btn" onClick={() => act("edit", id)}>Редагувати</button></>}
            {s.status === "active" && <><button className="btn" onClick={() => run("remind")}>🔔 Нагадати тим, хто не відповів ({p.notResponded.length})</button><button className="btn" onClick={() => run("close")}>Закрити опитування</button></>}
            {s.status === "closed" && <button className="btn" onClick={() => run("reopen")}>Відкрити знову</button>}
            <button className="btn" disabled={!(r.sliceCounts?.all ?? 0)} onClick={() => act("export", id)}>⬇ Експорт у Excel (CSV)</button>
            <button className="btn" onClick={() => act("dup", id)}>Дублювати як нове</button>
            <button className="btn" onClick={() => act("totpl", id)}>Зберегти як шаблон</button>
          </div>
          {s.remind?.on && s.status === "active" && <div className="notice info" style={{ marginTop: 12 }}>Нагадування заплановано: за {s.remind.days} дн. до дедлайну о {s.remind.time}{s.remind.dayOf ? " і в день дедлайну" : ""}.</div>}
          {s.recur?.on && <div className="notice info" style={{ marginTop: 8 }}>↻ Повтор: {recurLabel(s.recur)}. Після закриття наступний випуск створюється сам.</div>}
          <h2 style={{ marginTop: 20 }}>{s.anon ? "Участь" : "Хто відповів"}</h2>
          {s.anon ? <>
            <p className="hint">Анонімно: система знає, <i>хто</i> подав відповідь (щоб не нагадувати зайвий раз), але не <i>що</i> саме відповів.</p>
            <dl className="kv"><dt>Відповіли</dt><dd>{p.responded}</dd><dt>Ще ні</dt><dd>{p.notResponded.length}</dd></dl>
            {p.notResponded.length > 0 && <div className="who-list" style={{ marginTop: 8 }}>{p.notResponded.map((u) => <span key={u.id} className="chip no">{u.name}</span>)}</div>}
          </> : <>
            <div className="who-list">{p.respondedList.length ? p.respondedList.map((u) => <span key={u.id} className="chip">✓ {u.name}</span>) : <span className="hint">поки ніхто</span>}</div>
            <h3 style={{ marginTop: 14 }}>Ще не відповіли ({p.notResponded.length})</h3>
            <div className="who-list">{p.notResponded.length ? p.notResponded.map((u) => (
              <span key={u.id} className="chip no">{u.name} {s.status === "active" && <button title="Нагадати" style={{ color: "var(--data)" }}
                onClick={() => svRemind(id, [u.id]).then(() => toast("Нагадали " + u.name)).catch((e) => toast(errText(e), true))}>🔔</button>}</span>
            )) : <span className="hint">усі відповіли 🎉</span>}</div>
          </>}
        </aside>
      </div>
    </section>
  );
}

function ResultBody({ q, res, anon, nameOf }: { q: SvQuestion; res: SvResults["results"][number]; anon: boolean; nameOf: Map<string, string> }) {
  if (res.type === "choice") {
    const max = Math.max(...res.bars.map((b) => b.count), 1);
    return <div className="bars">{res.bars.map((b) => (
      <div key={b.label} className={`br ${b.count === max && b.count ? "top" : ""}`}><span className="lb" title={b.label}>{b.label}</span><span className="tr"><i style={{ width: `${b.pct}%` }} /></span><span className="vl">{b.pct}% <small>· {b.count}</small></span></div>
    ))}</div>;
  }
  if (res.type === "scale" || res.type === "enps") {
    const max = Math.max(...res.bins.map((b) => b.count), 1);
    const hist = <div className="hist">{res.bins.map((b) => (
      <div className="hb" key={b.value} title={`${b.value}: ${b.count}`}><small>{b.count || ""}</small>
        <i className={`${b.count ? "" : "zero"} ${res.type === "enps" ? (b.value >= 9 ? "good" : b.value <= 6 ? "bad" : "mid") : ""}`} style={{ height: `${Math.max(4, Math.round(100 * b.count / max))}%` }} /><span>{b.value}</span></div>
    ))}</div>;
    if (res.type === "enps") {
      const n = res.p + res.n0 + res.d; const pc = (x: number) => Math.round(100 * x / (n || 1));
      return <div className="scaleres"><div className="avg"><b>{res.score === null ? "—" : (res.score > 0 ? "+" : "") + res.score}</b><span>eNPS · {n} відп. · середнє {(res.avg ?? 0).toFixed(1)}</span></div>
        <div className="seg" title="критики / нейтральні / прихильники"><i className="bad" style={{ width: `${pc(res.d)}%` }} /><i className="mid" style={{ width: `${pc(res.n0)}%` }} /><i className="good" style={{ width: `${pc(res.p)}%` }} /></div>
        <div className="seglbl"><span><b className="bad">■</b> критики 0–6: {res.d} ({pc(res.d)}%)</span><span><b className="mid">■</b> нейтральні 7–8: {res.n0} ({pc(res.n0)}%)</span><span><b className="good">■</b> прихильники 9–10: {res.p} ({pc(res.p)}%)</span></div>{hist}</div>;
    }
    return <div className="scaleres"><div className="avg"><b>{(res.avg ?? 0).toFixed(1)}</b><span>середнє зі шкали {q.min}–{q.max}, {res.n} відп.</span></div>{hist}</div>;
  }
  if (res.type === "matrix") {
    const best = Math.max(...res.rows.map((x) => x.avg || 0));
    return <div className="bars">{res.rows.map((x) => (
      <div key={x.label} className={`br ${x.avg === best && x.avg ? "top" : ""}`}><span className="lb" title={x.label}>{x.label}</span><span className="tr"><i style={{ width: `${x.avg ? Math.round(100 * (x.avg - q.min) / ((q.max - q.min) || 1)) : 0}%` }} /></span><span className="vl">{x.avg ? x.avg.toFixed(1) : "—"} <small>з {q.max} · {x.n}</small></span></div>
    ))}</div>;
  }
  if (res.type === "rank") {
    const n = res.order.length;
    return <div className="bars">{res.order.map((x, k) => (
      <div key={x.label} className={`br ${k === 0 && x.avgPos ? "top" : ""}`}><span className="lb" title={x.label}>{k + 1}. {x.label}</span><span className="tr"><i style={{ width: `${x.avgPos ? Math.round(100 * (n + 1 - x.avgPos) / n) : 0}%` }} /></span><span className="vl">{x.avgPos ? x.avgPos.toFixed(1) : "—"} <small>сер. місце</small></span></div>
    ))}</div>;
  }
  return res.items.length ? <div className="texts">{res.items.map((x, k) => (
    <div className="ta" key={k}>{x.text}<div className="who">{anon ? "анонімно" : nameOf.get(String(x.userId)) || "—"} · {fmtDate(x.at)}</div></div>
  ))}</div> : <div className="texts"><span className="hint">Відповідей немає.</span></div>;
}

/* ═══════════════════════════ МОЇ ОПИТУВАННЯ ═══════════════════════════ */
function MineView({ list, open }: { list: SvListRow[]; open: (id: number) => void }) {
  const rows = list.filter((s) => s.status === "active" || s.status === "closed").map((s) => {
    const done = !!s.responded_at;
    const state = s.status === "closed" ? "closed" : done ? "done" : daysLeft(s.due) < 0 ? "late" : "new";
    return { s, state };
  });
  const isOpen = (x: { s: SvListRow; state: string }) => x.state !== "closed" && !(x.state === "done" && (!x.s.allow_edit || x.s.anon));
  const pill = (st: string) => ({
    new: <span className="pill new">нове</span>, late: <span className="pill late">прострочено</span>,
    done: <span className="pill done">✓ відповіли</span>, closed: <span className="pill closed">закрито</span>,
  } as Record<string, ReactNode>)[st];
  const row = (x: { s: SvListRow; state: string }) => (
    <div className="srow" key={x.s.id} onClick={() => open(x.s.id)}>
      <div><div className="ttl">{x.s.title} {pill(x.state)} {x.s.anon && <span className="pill anon">анонімно</span>}</div>
        <div className="meta"><span>{x.s.q_count} пит. · ~{Math.max(1, Math.ceil(x.s.q_count * 0.6))} хв</span><span>{x.s.status === "closed" ? "закрито " + fmtDate(x.s.closed_at) : "до " + fmtDue(x.s.due)}</span></div></div>
      <div className="acts">{x.state === "done" ? <button className="btn sm">{isOpen(x) ? "Змінити відповідь" : "Переглянути"}</button>
        : x.state === "closed" ? <button className="btn sm">Переглянути</button> : <button className="btn sm primary">Відповісти</button>}</div>
    </div>
  );
  const opened = rows.filter(isOpen); const done = rows.filter((x) => !isOpen(x));
  return (
    <section>
      <div className="grid">
        <div className="card"><h2>Мої опитування</h2><p className="hint">Те, що адресовано вам. Нові — з позначкою, дедлайн — праворуч.</p>
          <div className="list">{opened.length ? opened.map(row) : <div className="empty">Нових опитувань немає 👍</div>}</div></div>
        <aside className="card side"><h2>Пройдені</h2>
          <div className="list">{done.length ? done.map(row) : <div className="empty" style={{ padding: 16 }}>Поки порожньо.</div>}</div></aside>
      </div>
    </section>
  );
}

/* ═══════════════════════════ ЗАПОВНЕННЯ ═══════════════════════════ */
function FillView({ id, toast, onBack, onDone }: { id: number; toast: (m: string, bad?: boolean) => void; onBack: () => void; onDone: () => void }) {
  const [s, setS] = useState<SvFull | null>(null);
  const [a, setA] = useState<Record<string, SvAnswer>>({});
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLDivElement>(null);
  useEffect(() => { svGet(id).then((x) => { setS(x); if (x.mine) setA(x.mine.answers); }).catch((e) => setErr(errText(e))); }, [id]);
  if (!s) return <div className="card">{err ? <div className="notice bad">{err}</div> : <div className="empty">Завантаження…</div>}</div>;
  const done = !!s.responded_at; const closed = s.status === "closed";
  const canEdit = done && !!s.allow_edit && !closed && !s.anon;
  const readOnly = closed || (done && !canEdit);
  const submit = async () => {
    const ans: Record<string, SvAnswer> = { ...a };
    // ранжування без взаємодії = порядок як показано (так у пакеті)
    s.questions.filter((q) => q.type === "rank" && !ans[String(q.id)]).forEach((q) => { ans[String(q.id)] = q.options.slice(); });
    const miss = new Set(s.questions.filter((q) => {
      if (!q.required) return false; const v = ans[String(q.id)];
      if (v === undefined || v === "") return true;
      if (q.type === "matrix") return !(v && typeof v === "object" && q.rows.every((r) => typeof (v as Record<string, number>)[r] === "number"));
      return false;
    }).map((q) => String(q.id)));
    setMissing(miss);
    if (miss.size) {
      setErr("Відповідайте, будь ласка, на всі обов’язкові питання — позначені червоним.");
      setTimeout(() => formRef.current?.querySelector(".missing")?.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
      return;
    }
    setBusy(true); setErr("");
    try { await svRespond(id, ans); toast(done ? "Відповідь оновлено." : "Дякуємо, відповіді надіслано!"); onDone(); }
    catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  return (
    <section>
      <div className="grid">
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
            <div><h2>{s.title}</h2>{s.description ? <p className="hint">{s.description}</p> : null}</div>
            <button className="btn ghost" onClick={onBack}>← назад</button>
          </div>
          {s.anon && <div className="notice anon" style={{ margin: "8px 0" }}>🔒 Анонімно. Адміністратори бачать лише зведення без імен. Після подачі відповідь змінити не можна — вона не прив’язана до вас.</div>}
          {closed && <div className="notice info" style={{ margin: "8px 0" }}>Опитування закрите.{s.mine ? " Нижче — ваші відповіді." : ""}</div>}
          {done && !closed && !s.anon && <div className="notice ok" style={{ margin: "8px 0" }}>✓ Ви відповіли {fmtDue(s.responded_at)}.{canEdit ? " Можна змінити відповідь до дедлайну." : " Змінити відповідь не можна."}</div>}
          {done && s.anon && !closed && <div className="notice ok" style={{ margin: "8px 0" }}>✓ Вашу відповідь отримано. Дякуємо!</div>}
          <div className="fill" ref={formRef}>
            {done && s.anon ? null : s.questions.map((q, i) => (
              <FillQ key={String(q.id)} q={q} i={i} name={`q${q.id}`} value={a[String(q.id)]} disabled={readOnly} missing={missing.has(String(q.id))}
                onChange={(v) => { setA((x) => { const y = { ...x }; if (v === undefined) delete y[String(q.id)]; else y[String(q.id)] = v; return y; });
                  if (missing.has(String(q.id))) setMissing((m) => { const n = new Set(m); n.delete(String(q.id)); return n; }); }} />
            ))}
          </div>
          {!readOnly && <>
            <div className="row" style={{ marginTop: 14, justifyContent: "space-between" }}>
              <span className="hint" style={{ margin: 0 }}><span style={{ color: "var(--brand)" }}>*</span> — обов’язкові</span>
              <button className="btn primary" disabled={busy} onClick={submit}>{canEdit ? "Зберегти зміни" : "Надіслати відповіді"}</button>
            </div>
          </>}
          <div className="notice bad" hidden={!err} style={{ marginTop: 10 }}>{err}</div>
        </div>
        <aside className="card side">
          <h2>Про опитування</h2>
          <dl className="kv">
            <dt>Дедлайн</dt><dd>{fmtDue(s.due)}</dd><dt>Питань</dt><dd>{s.questions.length}</dd>
            <dt>Режим</dt><dd>{s.anon ? "анонімно" : "іменно"}</dd>
            <dt>Зміна відповіді</dt><dd>{s.anon ? "неможлива" : s.allow_edit ? "до дедлайну" : "ні"}</dd>
            {s.author ? <><dt>Від</dt><dd>{s.author}</dd></> : null}
          </dl>
        </aside>
      </div>
    </section>
  );
}

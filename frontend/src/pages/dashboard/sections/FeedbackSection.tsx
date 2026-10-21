import { useEffect, useMemo, useRef, useState } from "react";
import { useDialogs } from "../../../components/Dialogs";
import { failureReason } from "../../../actionFeedback";
import { NAV_ITEMS, HIDDEN_NAV } from "../../../components/Layout";
import {
  BUILD_SHA,
  commentFeedback,
  confirmFeedback,
  fetchFeedback,
  submitFeedback,
  updateFeedback,
  uploadFeedbackFile,
  deleteFeedbackFile,
  fetchFeedbackFileBlobUrl,
  FEEDBACK_FILE_MAX_BYTES,
  FEEDBACK_FILES_PER_ITEM,
  type FeedbackFormField,
  type FeedbackImpact,
  type FeedbackItem,
  type FeedbackFile,
  type FeedbackKind,
  type FeedbackKindSpec,
  type FeedbackStatus,
} from "../../../api";

/*
 * 💬 ЗВОРОТНИЙ ЗВʼЯЗОК (переробка 21.10.2026, рішення Романа).
 * Звернення були абстрактні («звіт неправильно рахує»), тому тепер:
 *  · звернення має ТИП, і в кожного типу свої обовʼязкові поля — серед них ПРИКЛАД;
 *  · поки не заповнено все обовʼязкове, «Надіслати» неактивна, і під формою написано, чого бракує;
 *  · опис полів приходить із сервера (`core/feedbackForm.ts`) — він же перевіряє звернення;
 *  · «Потрібні деталі» — питання автору прямо у зверненні, автор відповідає там же;
 *  · після «Вирішено» автор підтверджує «працює» або повертає «досі не працює».
 */

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

/** Відсіює те, що сервер однаково відхилить, — щоб людина дізналась ДО надсилання, а не після. */
function acceptImages(files: File[], room: number): { ok: File[]; problems: string[] } {
  const ok: File[] = [];
  const problems: string[] = [];
  for (const f of files) {
    if (!IMAGE_TYPES.includes(f.type)) { problems.push(`«${f.name}» — не фото (можна JPG, PNG, WEBP)`); continue; }
    if (f.size > FEEDBACK_FILE_MAX_BYTES) { problems.push(`«${f.name}» — більше 5 МБ`); continue; }
    if (ok.length >= room) { problems.push(`не більше ${FEEDBACK_FILES_PER_ITEM} фото на звернення`); break; }
    ok.push(f);
  }
  return { ok, problems };
}

/** Мініатюра фото: байти тягнемо з токеном (blob), бо тека фото не публічна. Клік — повний розмір. */
function FeedbackThumb({ itemId, file, onDelete }: { itemId: number; file: FeedbackFile; onDelete?: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    let made: string | null = null;
    fetchFeedbackFileBlobUrl(itemId, file.id)
      .then((u) => { made = u; if (alive) setUrl(u); else URL.revokeObjectURL(u); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [itemId, file.id]);
  return (
    <div className="fb-thumb">
      {url ? (
        <a href={url} target="_blank" rel="noreferrer" title={file.name}><img src={url} alt={file.name} /></a>
      ) : (
        <span className="fb-thumb-empty">{failed ? "фото недоступне" : "…"}</span>
      )}
      {onDelete && <button type="button" className="fb-thumb-x" onClick={onDelete} title="Прибрати фото" aria-label="Прибрати фото">✕</button>}
    </div>
  );
}

/** Зона додавання фото: кнопка, перетягування, Ctrl+V. Кладе файли через `onFiles`, решту вирішує власник. */
function PhotoDrop({ onFiles, room, compact = false, label }: { onFiles: (f: File[]) => void; room: number; compact?: boolean; label?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  if (room <= 0) return null;
  return (
    <div
      className={`fb-drop${over ? " over" : ""}${compact ? " compact" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); onFiles(Array.from(e.dataTransfer.files)); }}
      onClick={() => input.current?.click()}
      role="button"
    >
      📎 {compact ? "Додати фото" : (label ?? "Вставте скрін Ctrl+V, перетягніть файл або натисніть")} · JPG/PNG/WEBP до 5 МБ · ще {room}
      <input ref={input} type="file" accept={IMAGE_TYPES.join(",")} multiple hidden
        onChange={(e) => { onFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
    </div>
  );
}

// ── Довідники екрана ─────────────────────────────────────────────────────────

const STATUS_META: Record<FeedbackStatus, { label: string; cls: string }> = {
  pending: { label: "На розгляді", cls: "new" },
  needs_info: { label: "Потрібні деталі", cls: "ask" },
  approved: { label: "В роботі", cls: "work" },
  resolved: { label: "Вирішено", cls: "done" },
  rejected: { label: "Відхилено", cls: "rej" },
};

const IMPACTS: { v: FeedbackImpact; label: string; sub: string }[] = [
  { v: "block", label: "🔴 Блокує роботу", sub: "не можу працювати далі" },
  { v: "hurt", label: "🟠 Заважає", sub: "є обхід, але довго" },
  { v: "minor", label: "⚪ Дрібниця", sub: "косметика" },
];
const IMPACT_SHORT: Record<FeedbackImpact, string> = { block: "🔴 блокує", hurt: "🟠 заважає", minor: "⚪ дрібниця" };

/** Пʼять питань інструкції — по них іде чек-лист праворуч від форми. */
const QUESTIONS: { k: FeedbackFormField["question"]; q: string; w: string }[] = [
  { k: "where", q: "Де?", w: "розділ і що відкрито: період, менеджер, клієнт" },
  { k: "now", q: "Що зараз?", w: "цифра, текст помилки дослівно" },
  { k: "should", q: "Як має бути?", w: "і звідки це відомо: Kommo, 1С, банк" },
  { k: "impact", q: "Наскільки заважає / навіщо?", w: "блокує / заважає / дрібниця; що це спростить" },
  { k: "example", q: "Приклад", w: "номер угоди, рахунку, клієнт, скрін — обовʼязково" },
];

const PAIRS: Record<FeedbackKind, [string, string]> = {
  bug: ["Не працює дебіторка", "Дебіторка → ТОВ «Сігма». Кнопка «Запит на ліміт» не відкриває вікно. Двічі о 10:15, Chrome. Скрін додаю. Блокує роботу."],
  data: ["Звіт неправильно рахує", "Звіт → тиждень 13–19.10, менеджер Петренко: гроші тижня 48 000, у 1С 63 500. Не врахований рахунок №1234 від 16.10 на 15 500 ₴. Скрін з 1С."],
  change: ["Зробіть зручніше задачі", "Задачник: задача на 3 менеджерів = 3 окремі, загального прогресу не видно. Хочу «виконали 2 з 3». Ставлю так ~5 разів на тиждень."],
  idea: ["Додайте аналітику по клієнтах", "Лояльність: колонка «дата останнього перевезення». Зараз щоразу відкриваю Kommo — ~20 хв на день."],
  question: ["Як це працює?", "Задачник: як поставити план на тиждень лише на 3 дні? Менеджер Петренко, 27–31.10."],
};

/** Готові відповіді того, хто розбирає, — один клік вставляє текст. */
const REPLIES: Record<string, string> = {
  "Немає прикладу": "Покажіть, будь ласка, на прикладі: конкретний клієнт, номер угоди чи рахунку і скрін. Без прикладу не зможу відтворити й перевірити виправлення.",
  "Немає «де»": "Уточніть, де саме: розділ, період, менеджер або клієнт. Найкраще — скрін екрана, де це видно.",
  "Немає «як має бути»": "Яка цифра має бути і звідки це видно — Kommo, 1С, банк? Дайте номер угоди або рахунку.",
  "Нова функція без прикладу": "Опишіть реальний випадок, коли цього не вистачило, і як має виглядати результат — можна малюнок або скрін з Excel.",
  "Кілька проблем": "Тут кілька різних питань — розбийте, будь ласка, на окремі звернення, так кожне закриємо швидше.",
  "Немає «навіщо»": "Яку роботу це спростить і як часто вона потрібна? Так зможу поставити пріоритет.",
  "Дубль": "Це вже є у зверненні №… — стежте там.",
};

const ROLE_LABEL: Record<string, string> = {
  admin: "Адмін", ceo: "СЕО", opdir: "Операційний директор", kvp: "КВП", financier: "Фінансист",
  hr: "HR", team_lead: "Тімлід", manager: "Менеджер",
};

const OTHER_SECTION = "Інше";
const sectionOptions = (): string[] =>
  [...NAV_ITEMS.filter((n) => n.key !== "feedback" && !HIDDEN_NAV.has(n.key)).map((n) => n.label), OTHER_SECTION];
const sectionLabel = (key: string | undefined): string | null =>
  (key && NAV_ITEMS.find((n) => n.key === key)?.label) || null;

function fmt(d: string): string {
  return new Date(d).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// ── Екран ────────────────────────────────────────────────────────────────────

type Tab = "new" | "list" | "guide";

export function FeedbackSection({ isAdmin, role, fromSection }: { isAdmin: boolean; role: string; fromSection?: string }) {
  const [tab, setTab] = useState<Tab>("new");
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [form, setForm] = useState<FeedbackKindSpec[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    fetchFeedback()
      .then((r) => { setItems(r.items); setForm(r.form); setLoadErr(null); })
      .catch((e) => setLoadErr(failureReason(e, "Звернення не завантажились")))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const [notice, setNotice] = useState<string | null>(null);
  const replace = (it: FeedbackItem) => setItems((prev) => prev.map((x) => (x.id === it.id ? it : x)));

  // Лічильник на вкладці: адміну — що чекає розбору; решті — що чекає САМЕ ЇХ (питання, перевірка).
  const attention = isAdmin
    ? items.filter((x) => x.status === "pending").length
    : items.filter((x) => x.status === "needs_info" || (x.status === "resolved" && !x.confirmedAt)).length;

  return (
    <div className="fb">
      <div className="page-header">
        <h1 className="page-title">Зворотний звʼязок</h1>
      </div>
      <p className="fb-sub">Повідомте про помилку або запропонуйте зміну. Добре описане звернення роблять у рази швидше.</p>

      <div className="fb-tabs" role="tablist">
        <button role="tab" className={tab === "new" ? "on" : ""} onClick={() => setTab("new")}>Нове звернення</button>
        <button role="tab" className={tab === "list" ? "on" : ""} onClick={() => setTab("list")}>
          {isAdmin ? "Розбір" : "Мої звернення"}{attention > 0 && <span className="fb-cnt">{attention}</span>}
        </button>
        <button role="tab" className={tab === "guide" ? "on" : ""} onClick={() => setTab("guide")}>Як писати звернення</button>
      </div>

      {loadErr && <div role="alert" className="fb-alert">{loadErr} <button className="fb-btn sm ghost" onClick={load}>Повторити</button></div>}
      {notice && <div role="status" className="fb-notice">{notice} <button className="fb-link" onClick={() => setNotice(null)}>Зрозуміло</button></div>}

      {tab === "new" && (
        form.length === 0
          ? <p className="loading-text">{loading ? "Завантаження форми…" : "Форма не завантажилась — оновіть сторінку."}</p>
          : <NewFeedback form={form} role={role} fromSection={fromSection} onGuide={() => setTab("guide")}
              onCreated={(it, photoErr) => {
                setItems((p) => [it, ...p]);
                setNotice(`Звернення №${it.id} надіслано. Статус і питання до вас — тут, у «${isAdmin ? "Розбір" : "Мої звернення"}».${photoErr ? ` ${photoErr}` : ""}`);
                setTab("list");
              }} />
      )}
      {tab === "list" && (
        <FeedbackList items={items} form={form} isAdmin={isAdmin} loading={loading} onChange={replace} reload={load} />
      )}
      {tab === "guide" && <Guide form={form} />}
    </div>
  );
}

// ── Нове звернення ───────────────────────────────────────────────────────────

function NewFeedback({ form, role, fromSection, onCreated, onGuide }: {
  form: FeedbackKindSpec[]; role: string; fromSection?: string;
  onCreated: (it: FeedbackItem, photoErr: string | null) => void; onGuide: () => void;
}) {
  const fromLabel = sectionLabel(fromSection);
  const [kind, setKind] = useState<FeedbackKind | null>(null);
  const [section, setSection] = useState<string>(fromLabel ?? "");
  const [vals, setVals] = useState<Record<string, string>>({});
  const [impact, setImpact] = useState<FeedbackImpact | null>(null);
  const [pending, setPending] = useState<File[]>([]);
  const [pendingUrls, setPendingUrls] = useState<string[]>([]);
  const [photoErr, setPhotoErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const opened = useMemo(() => new Date().toISOString(), []);

  useEffect(() => {
    const urls = pending.map((f) => URL.createObjectURL(f));
    setPendingUrls(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [pending]);

  const spec = form.find((s) => s.kind === kind) ?? null;

  function addPending(files: File[]) {
    const { ok, problems } = acceptImages(files, FEEDBACK_FILES_PER_ITEM - pending.length);
    setPhotoErr(problems.length ? problems.join("; ") : null);
    if (ok.length) setPending((p) => [...p, ...ok]);
  }
  const onPaste = (e: React.ClipboardEvent) => {
    const imgs = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
    if (imgs.length) { e.preventDefault(); addPending(imgs); }
  };

  // Що з пʼяти питань уже закрито: питання вважається закритим, коли заповнені ВСІ обовʼязкові поля,
  // що на нього відповідають (+ розділ для «де», + «наскільки заважає» для «impact», де його питають).
  const done = useMemo(() => {
    const out: Partial<Record<FeedbackFormField["question"], boolean>> = {};
    if (!spec) return out;
    for (const q of QUESTIONS) {
      const fs = spec.fields.filter((f) => f.question === q.k && !f.optional);
      const extra = q.k === "where" ? [!!section] : q.k === "impact" && spec.askImpact ? [!!impact] : [];
      if (!fs.length && !extra.length) continue;
      out[q.k] = fs.every((f) => (vals[f.key] ?? "").trim() !== "") && extra.every(Boolean);
    }
    return out;
  }, [spec, vals, section, impact]);
  const asked = QUESTIONS.filter((q) => done[q.k] !== undefined);
  const okCount = asked.filter((q) => done[q.k]).length;
  const missing = asked.filter((q) => !done[q.k]).map((q) => q.q.replace("?", ""));
  const ready = !!spec && missing.length === 0;
  const pct = asked.length ? Math.round((100 * okCount) / asked.length) : 0;

  async function send() {
    if (!spec || !ready) return;
    setSaving(true);
    setErr(null);
    try {
      const created = await submitFeedback({
        kind: spec.kind, section, impact: spec.askImpact ? impact : null, fields: vals,
        context: { build: BUILD_SHA, role, fromSection: fromLabel ?? "", path: opened },
      });
      // Фото — після створення: їм потрібен id звернення. Невдале фото називаємо, текст уже збережено.
      const errs: string[] = [];
      for (const f of pending) {
        try { created.files.push(await uploadFeedbackFile(created.id, f)); } catch (e) { errs.push(`«${f.name}»: ${failureReason(e, "не завантажилось")}`); }
      }
      setVals({}); setImpact(null); setPending([]); setKind(null);
      onCreated(created, errs.length ? `Не всі фото завантажились: ${errs.join("; ")}. Додайте їх у самому зверненні.` : null);
    } catch (e) {
      setErr(failureReason(e, "Звернення не надіслалось"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <p className="fb-step">1 · Що сталося?</p>
      <div className="fb-types">
        {form.map((s) => (
          <button key={s.kind} type="button" className={`fb-type${s.kind === kind ? " on" : ""}`}
            onClick={() => { setKind(s.kind); setErr(null); }}>
            <span className="ic">{s.icon}</span><span className="t">{s.title}</span><span className="d">{s.description}</span>
          </button>
        ))}
      </div>

      {!spec ? (
        <div className="chart-card fb-empty">Оберіть тип звернення — і зʼявляться поля з підказками, що саме написати.</div>
      ) : (
        <div className="fb-grid">
          <div className="chart-card">
            <p className="fb-step">2 · Опишіть</p>
            <div className="fb-auto">
              {fromLabel && <span className="fb-chip">📍 прийшли з «{fromLabel}»</span>}
              <span className="fb-chip">👤 {ROLE_LABEL[role] ?? (role || "роль невідома")}</span>
              <span className="fb-chip">🕒 {fmt(opened)}</span>
              <span className="fb-chip">збірка {BUILD_SHA.slice(0, 7)}</span>
              <span className="fb-chip dashed">підставлено само</span>
            </div>

            <div className="fb-f">
              <label><span>Розділ</span><span className="req">*</span></label>
              <select value={section} onChange={(e) => setSection(e.target.value)}>
                <option value="">Оберіть розділ…</option>
                {sectionOptions().map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>

            {spec.fields.map((f) => (
              <div className="fb-f" key={`${spec.kind}-${f.key}`}>
                <label><span>{f.label}</span>{f.optional ? <span className="opt">необовʼязково</span> : <span className="req">*</span>}</label>
                {f.multiline ? (
                  <textarea rows={3} value={vals[f.key] ?? ""} placeholder={f.placeholder} onPaste={onPaste}
                    onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))} />
                ) : (
                  <input value={vals[f.key] ?? ""} placeholder={f.placeholder} onPaste={onPaste}
                    onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))} />
                )}
                {f.hint && <div className="fb-hint">{f.hint}</div>}
              </div>
            ))}

            {spec.askImpact && (
              <div className="fb-f">
                <label><span>Наскільки заважає</span><span className="req">*</span></label>
                <div className="fb-seg">
                  {IMPACTS.map((i) => (
                    <button key={i.v} type="button" data-v={i.v} className={impact === i.v ? "on" : ""} onClick={() => setImpact(i.v)}>
                      {i.label}<small>{i.sub}</small>
                    </button>
                  ))}
                </div>
                {impact === "block" && <div className="fb-hint warn">Якщо справа термінова — після надсилання продублюйте коротко в чат.</div>}
              </div>
            )}

            <div className="fb-f">
              <label><span>Скріни</span><span className="opt">дуже бажано</span></label>
              <PhotoDrop onFiles={addPending} room={FEEDBACK_FILES_PER_ITEM - pending.length} />
              {pending.length > 0 && (
                <div className="fb-thumbs">
                  {pending.map((f, i) => (
                    <div key={i} className="fb-thumb">
                      {pendingUrls[i] && <img src={pendingUrls[i]} alt={f.name} />}
                      <button type="button" className="fb-thumb-x" onClick={() => setPending((p) => p.filter((_, j) => j !== i))} aria-label="Прибрати">✕</button>
                    </div>
                  ))}
                </div>
              )}
              {photoErr && <div role="alert" className="fb-err">{photoErr}</div>}
            </div>

            {err && <div role="alert" className="fb-alert">{err}</div>}
            <div className="fb-bar">
              <span className="fb-missing">{missing.length ? <>Ще потрібно: <b>{missing.join(", ")}</b></> : "✓ Усе на місці"}</span>
              <button className="fb-btn" onClick={send} disabled={!ready || saving}>{saving ? "Надсилання…" : "Надіслати"}</button>
            </div>
          </div>

          <aside className="chart-card fb-aside">
            <h3>Чи зрозуміють ваше звернення</h3>
            <div className={`fb-meter${pct === 100 ? " full" : ""}`}><i style={{ width: `${pct}%` }} /></div>
            <div className="fb-meter-t">{pct === 100 ? "Готово — звернення зрозуміле" : `Заповнено ${okCount} з ${asked.length}`}</div>
            <ul className="fb-check">
              {asked.map((q) => (
                <li key={q.k} className={done[q.k] ? "ok" : ""}>
                  <span className="dot">{done[q.k] ? "✓" : ""}</span>
                  <span><b>{q.q}</b><br /><small>{q.w}</small></span>
                </li>
              ))}
            </ul>
            <div className="fb-ex-t">Приклад для «{spec.title}»</div>
            <div className="fb-ex bad"><div className="lbl">Так не пишемо</div>{PAIRS[spec.kind][0]}</div>
            <div className="fb-ex good"><div className="lbl">Так пишемо</div>{PAIRS[spec.kind][1]}</div>
            <div className="fb-rule">Одне звернення — одна проблема. Три проблеми — три звернення.</div>
            <button type="button" className="fb-link" onClick={onGuide}>Повна інструкція →</button>
          </aside>
        </div>
      )}
    </>
  );
}

// ── Список / розбір ──────────────────────────────────────────────────────────

const FILTERS: { key: "all" | FeedbackStatus; label: string }[] = [
  { key: "all", label: "Усі" },
  { key: "pending", label: "На розгляді" },
  { key: "needs_info", label: "Потрібні деталі" },
  { key: "approved", label: "В роботі" },
  { key: "resolved", label: "Вирішено" },
  { key: "rejected", label: "Відхилено" },
];

function FeedbackList({ items, form, isAdmin, loading, onChange, reload }: {
  items: FeedbackItem[]; form: FeedbackKindSpec[]; isAdmin: boolean; loading: boolean;
  onChange: (it: FeedbackItem) => void; reload: () => void;
}) {
  const [filter, setFilter] = useState<"all" | FeedbackStatus>(isAdmin ? "pending" : "all");
  const counts = items.reduce((a, x) => ((a[x.status] = (a[x.status] ?? 0) + 1), a), {} as Record<string, number>);
  const shown = filter === "all" ? items : items.filter((x) => x.status === filter);
  // Підсумки для того, хто розбирає: черга і чи стали звернення зрозумілішими.
  const last30 = items.filter((x) => Date.now() - new Date(x.createdAt).getTime() < 30 * 86_400_000);
  const askedShare = last30.length
    ? Math.round((100 * last30.filter((x) => x.comments.some((c) => c.kind === "question")).length) / last30.length)
    : null;

  return (
    <>
      {isAdmin && (
        <div className="fb-stats">
          <div className="fb-stat"><b>{counts.pending ?? 0}</b><span>чекають розбору</span></div>
          <div className="fb-stat"><b>{counts.needs_info ?? 0}</b><span>чекають відповіді автора</span></div>
          <div className="fb-stat"><b>{counts.approved ?? 0}</b><span>в роботі</span></div>
          <div className="fb-stat"><b>{askedShare == null ? "—" : `${askedShare}%`}</b><span>повернуто за деталями (30 дн)</span></div>
        </div>
      )}
      <div className="fb-filters">
        {FILTERS.map((f) => (
          <button key={f.key} className={filter === f.key ? "on" : ""} onClick={() => setFilter(f.key)}>
            {f.label} <span>{f.key === "all" ? items.length : counts[f.key] ?? 0}</span>
          </button>
        ))}
      </div>
      {loading ? <p className="loading-text">Завантаження…</p>
        : shown.length === 0 ? <p className="loading-text">Немає звернень{filter === "all" ? "" : " з цим статусом"}.</p>
        : shown.map((it) => <FeedbackCard key={it.id} item={it} form={form} isAdmin={isAdmin} onChange={onChange} reload={reload} />)}
      <p className="fb-note">Закриті звернення («вирішено», «відхилено») разом із фото видаляються через 30 днів.</p>
    </>
  );
}

const TRACK = ["Надіслано", "Розбір", "В роботі", "Вирішено", "Підтверджено"];
function trackPos(it: FeedbackItem): number {
  if (it.status === "pending" || it.status === "needs_info") return 1;
  if (it.status === "approved") return 2;
  if (it.status === "resolved") return it.confirmedAt ? 5 : 3;
  return -1;
}

function FeedbackCard({ item, form, isAdmin, onChange, reload }: {
  item: FeedbackItem; form: FeedbackKindSpec[]; isAdmin: boolean; onChange: (it: FeedbackItem) => void; reload: () => void;
}) {
  const dlg = useDialogs();
  const spec = form.find((s) => s.kind === item.kind) ?? null;
  const [mode, setMode] = useState<null | "ask" | "reject" | "reply" | "reopen">(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const meta = STATUS_META[item.status];
  const pos = trackPos(item);
  const title = spec
    ? `${spec.icon} ${spec.title}${item.fields?.actual ? ` · ${item.fields.actual.split("\n")[0].slice(0, 90)}` : ""}`
    : item.message.split("\n")[0].slice(0, 110);
  const statusLabel = item.status === "resolved" && item.confirmedAt ? "Підтверджено автором" : meta.label;

  async function run(fn: () => Promise<FeedbackItem>) {
    setBusy(true); setErr(null);
    try { onChange(await fn()); setMode(null); setText(""); }
    catch (e) { setErr(failureReason(e, "Не вийшло")); }
    finally { setBusy(false); }
  }
  async function addFiles(files: File[]) {
    const { ok, problems } = acceptImages(files, FEEDBACK_FILES_PER_ITEM - item.files.length);
    const errs = [...problems];
    for (const f of ok) {
      try { await uploadFeedbackFile(item.id, f); } catch (e) { errs.push(`«${f.name}»: ${failureReason(e, "не завантажилось")}`); }
    }
    setErr(errs.length ? errs.join("; ") : null);
    if (ok.length) reload();
  }
  async function removeFile(fileId: number) {
    if (!(await dlg.confirm({ text: "Прибрати це фото?", okLabel: "Прибрати", danger: true }))) return;
    try {
      await deleteFeedbackFile(item.id, fileId);
      onChange({ ...item, files: item.files.filter((f) => f.id !== fileId) });
    } catch (e) { setErr(failureReason(e, "Фото не прибралось")); }
  }

  const submitText = () => {
    const t = text.trim();
    if (!t) return;
    if (mode === "ask") return run(() => updateFeedback(item.id, { status: "needs_info", adminNote: t }));
    if (mode === "reject") return run(() => updateFeedback(item.id, { status: "rejected", adminNote: t }));
    if (mode === "reopen") return run(() => confirmFeedback(item.id, false, t));
    return run(() => commentFeedback(item.id, t));
  };
  const placeholder = mode === "ask" ? "Питання автору: чого саме не вистачає…"
    : mode === "reject" ? "Причина відхилення (автор її побачить)…"
    : mode === "reopen" ? "Що саме досі не працює — на якому прикладі…"
    : "Ваша відповідь…";
  const isAuthorView = !isAdmin;

  return (
    <div className={`fb-item s-${meta.cls}`}>
      <div className="fb-item-top">
        <div>
          <div className="fb-item-title">{title}</div>
          <div className="fb-meta">
            №{item.id}{item.section ? ` · ${item.section}` : ""}{isAdmin ? ` · ${item.authorName}` : ""} · {fmt(item.createdAt)}
            {item.impact && <span className={`fb-imp i-${item.impact}`}>{IMPACT_SHORT[item.impact]}</span>}
          </div>
        </div>
        <span className={`fb-badge b-${meta.cls}`}>{statusLabel}</span>
      </div>

      {pos > 0 && (
        <div className="fb-track">
          {TRACK.map((s, i) => (
            <span key={s} className={i < pos ? "d" : i === pos ? "c" : ""}>
              {i === 1 && item.status === "needs_info" ? "Потрібні деталі" : s}
            </span>
          ))}
        </div>
      )}

      {spec && item.fields ? (
        <dl className="fb-fields">
          {spec.fields.map((f) => item.fields![f.key] ? (
            <FieldRow key={f.key} label={f.label} value={item.fields![f.key]} example={f.question === "example"} />
          ) : null)}
        </dl>
      ) : (
        <div className="fb-legacy">{item.message}<div className="fb-meta">подано до нової форми — без типу й прикладу</div></div>
      )}

      {item.files.length > 0 && (
        <div className="fb-thumbs">
          {item.files.map((f) => <FeedbackThumb key={f.id} itemId={item.id} file={f} onDelete={() => removeFile(f.id)} />)}
        </div>
      )}
      {item.files.length < FEEDBACK_FILES_PER_ITEM && item.status !== "rejected" && (
        <div className="fb-drop-wrap"><PhotoDrop compact onFiles={addFiles} room={FEEDBACK_FILES_PER_ITEM - item.files.length} /></div>
      )}

      {item.comments.length > 0 && (
        <div className="fb-thread">
          {item.comments.map((c, i) => (
            <div key={i} className={`fb-msg r-${c.role} k-${c.kind}`}>
              <div className="fb-msg-h"><b>{c.byName}</b> · {fmt(c.at)}{c.kind === "question" ? " · питання" : c.kind === "reject" ? " · причина відхилення" : c.kind === "reopen" ? " · досі не працює" : ""}</div>
              <div className="fb-msg-b">{c.body}</div>
            </div>
          ))}
        </div>
      )}
      {!item.comments.length && item.adminNote && <div className="fb-thread"><div className="fb-msg r-admin"><div className="fb-msg-h"><b>Коментар</b></div><div className="fb-msg-b">{item.adminNote}</div></div></div>}

      {item.purgeAt && (
        <div data-testid="feedback-purge-at" className="fb-note">
          🗑 Видалиться {new Date(item.purgeAt).toLocaleDateString("uk-UA")} разом із фото — через 30 днів після закриття
        </div>
      )}

      {/* Підказка автору, коли хід за ним. */}
      {isAuthorView && item.status === "needs_info" && mode == null && (
        <div className="fb-callout ask">Вам поставили питання — відповідайте тут, і звернення повернеться на розгляд.</div>
      )}
      {isAuthorView && item.status === "resolved" && !item.confirmedAt && mode == null && (
        <div className="fb-callout done">Виправлено. Перевірте, будь ласка, на вашому прикладі.</div>
      )}

      {mode && (
        <div className="fb-compose">
          {(mode === "ask" || mode === "reject") && (
            <div className="fb-replies">
              {Object.entries(REPLIES).map(([k, v]) => (
                <button key={k} type="button" onClick={() => setText((t) => (t ? `${t}\n${v}` : v))}>{k}</button>
              ))}
            </div>
          )}
          <textarea rows={3} autoFocus value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} />
          <div className="fb-actions">
            <button className="fb-btn sm" disabled={busy || !text.trim()} onClick={submitText}>
              {mode === "ask" ? "Надіслати питання автору" : mode === "reject" ? "Відхилити" : mode === "reopen" ? "Повернути в роботу" : "Відповісти"}
            </button>
            <button className="fb-btn sm ghost" onClick={() => { setMode(null); setText(""); }}>Скасувати</button>
          </div>
        </div>
      )}

      {err && <div role="alert" className="fb-err">{err}</div>}

      {!mode && (
        <div className="fb-actions">
          {isAdmin && item.status === "pending" && <>
            <button className="fb-btn sm" disabled={busy} onClick={() => run(() => updateFeedback(item.id, { status: "approved" }))}>Прийняти в роботу</button>
            <button className="fb-btn sm ghost" onClick={() => setMode("ask")}>Потрібні деталі</button>
            <button className="fb-btn sm ghost" onClick={() => setMode("reject")}>Відхилити</button>
          </>}
          {isAdmin && item.status === "approved" && <>
            <button className="fb-btn sm ok" disabled={busy} onClick={() => run(() => updateFeedback(item.id, { status: "resolved" }))}>✔ Вирішено</button>
            <button className="fb-btn sm ghost" onClick={() => setMode("ask")}>Потрібні деталі</button>
          </>}
          {isAdmin && (item.status === "needs_info" || item.status === "rejected" || item.status === "resolved") && (
            <button className="fb-btn sm ghost" disabled={busy} onClick={() => run(() => updateFeedback(item.id, { status: "pending" }))}>↩ Повернути на розгляд</button>
          )}
          {isAuthorView && item.status === "resolved" && !item.confirmedAt && <>
            <button className="fb-btn sm ok" disabled={busy} onClick={() => run(() => confirmFeedback(item.id, true))}>✓ Працює</button>
            <button className="fb-btn sm ghost" onClick={() => setMode("reopen")}>✕ Досі не працює</button>
          </>}
          {item.status !== "rejected" && (
            <button className={`fb-btn sm ${isAuthorView && item.status === "needs_info" ? "" : "ghost"}`} onClick={() => setMode("reply")}>
              {isAuthorView && item.status === "needs_info" ? "Відповісти" : "💬 Написати"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function FieldRow({ label, value, example }: { label: string; value: string; example: boolean }) {
  return <><dt>{label}</dt><dd className={example ? "ex" : ""}>{value}</dd></>;
}

// ── Інструкція ───────────────────────────────────────────────────────────────

function Guide({ form }: { form: FeedbackKindSpec[] }) {
  const kinds = form.length ? form : [];
  return (
    <div className="chart-card fb-guide">
      <h2>Як написати звернення, щоб його зробили</h2>
      <p>Звернення читає людина, яка не бачила ваш екран. Якщо з тексту не зрозуміло <b>що</b> і <b>де</b>, воно повертається з питаннями, і все затягується на дні.</p>
      <div className="fb-rule"><b>Одне звернення — одна проблема.</b> Три проблеми — три звернення.</div>

      <h3>Пʼять питань, на які відповідає кожне звернення</h3>
      <ul className="fb-check">
        {QUESTIONS.map((q, i) => (
          <li key={q.k} className="ok"><span className="dot">{i + 1}</span><span><b>{q.q}</b><br /><small>{q.w}</small></span></li>
        ))}
      </ul>

      <h3>Приклади обовʼязкові</h3>
      <p>Розробник відтворює проблему саме на вашому прикладі і на ньому ж перевіряє виправлення: якщо на вашому прикладі стало правильно — зроблено. <b>Без прикладу звернення повертається з питанням.</b></p>
      <dl className="fb-fields wide">
        <dt>🐞 Не працює</dt><dd>клієнт / угода / рахунок, на якому ламається + скрін + дата й час</dd>
        <dt>📊 Неправильна цифра</dt><dd>1–3 угоди чи рахунки: номер, сума, дата + скрін з Kommo / 1С, де видно правильне</dd>
        <dt>✏️ Змінити / додати</dt><dd>реальна ситуація, коли цього не вистачило + як має виглядати (малюнок, скрін з Excel)</dd>
      </dl>
      <div className="fb-pair">
        <div className="fb-ex bad"><div className="lbl">Не приклад</div>«у багатьох клієнтів», «іноді», «десь у звіті», «як завжди»</div>
        <div className="fb-ex good"><div className="lbl">Приклад</div>«угода №61234567», «рахунок №1234 від 16.10 на 15 500 ₴», «ТОВ «Сігма», 21.10 о 10:15»</div>
      </div>
      <p className="fb-meta">Якщо випадків багато — дайте 2–3 приклади і напишіть, скільки їх приблизно всього.</p>

      <h3>Погано → добре</h3>
      {kinds.map((s) => (
        <div className="fb-pair" key={s.kind}>
          <div className="fb-ex bad"><div className="lbl">{s.icon} Так не пишемо</div>{PAIRS[s.kind][0]}</div>
          <div className="fb-ex good"><div className="lbl">Так пишемо</div>{PAIRS[s.kind][1]}</div>
        </div>
      ))}

      <h3>Що буде далі</h3>
      <div className="fb-track all">
        {["Надіслано", "Розбір ≤ 2 дні", "В роботі", "Вирішено", "Ви підтвердили"].map((s) => <span key={s} className="d">{s}</span>)}
      </div>
      <p>Якщо звернення повернули з питанням («Потрібні деталі») — відповідайте прямо в ньому. Після «Вирішено» перевірте на своєму прикладі й натисніть «Працює» або «Досі не працює». Якщо щось <b>блокує роботу</b> — позначте це у зверненні й продублюйте коротко в чат.</p>
    </div>
  );
}

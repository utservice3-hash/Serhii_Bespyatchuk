import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchTrainingCourses, fetchTrainingCourse, fetchTrainingMaterial, openTrainingMaterial, doneTrainingMaterial,
  createTrainingCourse, patchTrainingCourse, createTrainingFolder, updateTrainingFolder, deleteTrainingFolder,
  updateTrainingMaterial, deleteTrainingMaterial, fetchTrainingFileBlobUrl, createTrainingMaterial,
  type TrainingCourse, type TrainingCourseDetail, type TrainingMaterialContent, type TrainingAudience, type TrainingKind,
  type TrainingModule, type TrainingUploadRules,
} from "../../../api";
import { embedUrl } from "../trainingView";
import "./hiring.css";
import "./training.css";

/**
 * 🎓 «НАВЧАННЯ → КУРСИ» — ОДИН ЕКРАН ДЛЯ ВСІХ (23.09.2026, рішення Романа: «універсальний макет і для
 * кандидата, і для адміністрації, відкритий для модифікації»).
 *
 * 🔴 ЧОМУ ОДИН ЕКРАН, А НЕ ДВА. Досі курс проходив лише кандидат (`CandidateTraining`), а керівництво
 * бачило бібліотеку папок — і після переносу Академії Sereda в корені опинилось 47 тем, тобто екран
 * показував структуру сховища замість навчання. Тепер і читач, і редактор дивляться на ТОЙ САМИЙ курс:
 * ліворуч теми з кроками, праворуч крок. Різниця лише в тому, що доступно.
 *
 * 🔴 РЕДАГУВАННЯ — ПРАВО, А НЕ РОЛЬ (`canEdit` з сервера, `manage_training`). Режим «Редагування»
 * вмикається перемикачем у курсі, щоб випадковий клік не перейменував крок людині, яка його читає.
 * Кожна дія йде тими самими роутами, що й бібліотека: курс — `patchTrainingCourse`, тема — папка,
 * крок — матеріал. Нових дверей у сервер цей екран не відчиняє.
 *
 * 🔴 ПОРЯДОК КРОКІВ І ЗАМКИ рахує СЕРВЕР (`GET /training/courses/:id` → `state`, `blockedBy`), а не
 * екран: інакше «наступний відкривається після попереднього» існувало б у двох місцях і розійшлось би.
 * Тримають #706–#708.
 */

const KIND: Record<TrainingKind, { icon: string; label: string }> = {
  text: { icon: "📝", label: "текст" },
  file: { icon: "📄", label: "файл" },
  video_embed: { icon: "🎬", label: "відео" },
  link: { icon: "🔗", label: "посилання" },
};
const AUDIENCE: { key: TrainingAudience; label: string }[] = [
  { key: "candidate", label: "Кандидати" }, { key: "manager", label: "Менеджери" }, { key: "all", label: "Усі" },
];
const audLabel = (a: TrainingAudience) => AUDIENCE.find((x) => x.key === a)?.label ?? a;
const errText = (e: unknown) => (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "Дію не вдалося виконати";

export function TrainingCourses({ onOpenLibrary }: { onOpenLibrary?: () => void }) {
  const [rows, setRows] = useState<TrainingCourse[] | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const [filt, setFilt] = useState<"all" | "published" | "draft" | "empty">("all");
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    fetchTrainingCourses().then((d) => { setRows(d.courses); setCanEdit(d.canEdit); setErr(null); })
      .catch(() => setErr("Не вдалося завантажити курси."));
  }, []);
  useEffect(load, [load]);

  if (openId != null) return <CourseView id={openId} canEdit={canEdit} onBack={() => { setOpenId(null); load(); }} />;
  if (err) return <div className="hr-card" style={{ padding: 16, color: "var(--danger)" }}>{err}</div>;
  if (!rows) return <p className="loading-text">Завантаження…</p>;

  const published = rows.filter((c) => c.published).length;
  const steps = rows.reduce((a, c) => a + c.materialCount, 0);
  const mine = rows.filter((c) => c.percent > 0 && c.percent < 100).length;
  const shown = rows.filter((c) => (!q.trim() || c.title.toLowerCase().includes(q.trim().toLowerCase()))
    && (filt === "all" || (filt === "published" ? c.published : filt === "draft" ? !c.published : c.materialCount === 0)));

  return (
    <div>
      <div className="tr-kpis">
        <div className="tr-kpi"><span className="k">Курси</span><span className="v">{rows.length}</span>
          <span className="s">{canEdit ? "усі, разом із чернетками" : "відкриті вашій ролі"}</span></div>
        <div className="tr-kpi"><span className="k">Опубліковано</span><span className="v">{published}<small>/ {rows.length}</small></span>
          <span className="s">видно за аудиторією курсу</span></div>
        <div className={`tr-kpi ${canEdit && rows.length - published ? "warn" : ""}`}><span className="k">{canEdit ? "Чернетки" : "У процесі"}</span>
          <span className="v">{canEdit ? rows.length - published : mine}</span>
          <span className="s">{canEdit ? "бачить лише керівництво" : "почали, але не завершили"}</span></div>
        <div className="tr-kpi"><span className="k">Кроків усього</span><span className="v">{steps}</span>
          <span className="s">{onOpenLibrary ? "матеріали — у «Бібліотеці»" : "уроки всіх курсів"}</span></div>
      </div>

      <div className="hr-pills">
        {([["all", "Усі"], ["published", "Опубліковані"], ["draft", "Чернетки"], ["empty", "Порожні"]] as const)
          .filter(([k]) => canEdit || k === "all" || k === "published")
          .map(([k, l]) => <button key={k} className={filt === k ? "on" : ""} onClick={() => setFilt(k)}>{l}</button>)}
        <input className="hr-inp" style={{ flex: "1 1 220px" }} placeholder="🔍 Пошук курсу" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Пошук курсу" />
        {canEdit && <button className="hr-btn p" onClick={() => setAdding(true)}>+ Курс</button>}
      </div>

      {shown.length === 0 ? (
        <div className="hr-card" style={{ padding: 16 }}>
          <b>{rows.length ? "Нічого не знайдено." : "Курсів ще немає."}</b>{" "}
          <span className="hr-muted">{rows.length ? "Змініть пошук або фільтр." : canEdit ? "Створіть перший кнопкою «+ Курс»." : "Керівництво відкриє курс, коли він буде готовий."}</span>
        </div>
      ) : (
        <div className="tr-grid">
          {shown.map((c) => (
            <button key={c.id} className={`tr-cc ${c.published ? "" : "draft"}`} onClick={() => setOpenId(c.id)}>
              <div className="tr-ch">
                <span className="tt">{c.title}</span>
                {canEdit && <span className={`hr-pill ${c.published ? "ok" : "wn"}`}>{c.published ? "опубліковано" : "чернетка"}</span>}
              </div>
              <div className="hr-muted">
                {(c.modules?.length ?? 0)} тем · {c.materialCount} кроків{c.requiredCount !== c.materialCount ? ` · ${c.requiredCount} обовʼязкових` : ""}
              </div>
              {c.materialCount === 0
                ? <span className="hr-pill gr">кроків ще немає</span>
                : (<div>
                    <div className="hr-muted" style={{ marginBottom: 4 }}>Пройдено {c.percent}%</div>
                    <div className="tr-track"><i style={{ width: `${c.percent}%`, background: c.percent === 100 ? "var(--ok)" : "var(--info)" }} /></div>
                  </div>)}
              <div className="tr-cf">
                <span className="hr-btn xs">Відкрити</span>
                <span className="hr-pill gr" style={{ marginLeft: "auto" }}>{audLabel(c.audience)}</span>
              </div>
            </button>
          ))}
        </div>
      )}
      {adding && <NewCourse onClose={() => setAdding(false)} onDone={(id) => { setAdding(false); load(); setOpenId(id); }} />}
    </div>
  );
}

function NewCourse({ onClose, onDone }: { onClose: () => void; onDone: (id: number) => void }) {
  const [title, setTitle] = useState("");
  const [audience, setAudience] = useState<TrainingAudience>("candidate");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!title.trim()) { setErr("Введіть назву курсу"); return; }
    setBusy(true);
    try { onDone(await createTrainingCourse({ title: title.trim(), audience })); }
    catch (e) { setErr(errText(e)); setBusy(false); }
  };
  return (
    <div className="hr-modal-back" onClick={onClose}>
      <div className="hr-modal" role="dialog" aria-label="Новий курс" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <h3 style={{ margin: "0 0 4px", fontSize: 16 }}>Новий курс</h3>
        <div className="hr-muted" style={{ marginBottom: 12 }}>Курс створюється чернеткою: його видно лише керівництву, поки ви не опублікуєте.</div>
        <label style={{ display: "block", fontSize: 12, color: "var(--text-muted)" }}>Назва
          <input className="hr-inp" style={{ width: "100%" }} autoFocus value={title} onChange={(e) => { setTitle(e.target.value); setErr(null); }} placeholder="Старт кандидата" />
        </label>
        <label style={{ display: "block", fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>Для кого
          <select className="hr-inp" style={{ width: "100%" }} value={audience} onChange={(e) => setAudience(e.target.value as TrainingAudience)}>
            {AUDIENCE.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
          </select>
        </label>
        {err && <div style={{ color: "var(--danger)", fontSize: 13, marginTop: 8 }}>{err}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
          <button className="hr-btn" onClick={onClose}>Скасувати</button>
          <button className="hr-btn p" disabled={busy} onClick={() => void save()}>{busy ? "Створюю…" : "Створити"}</button>
        </div>
      </div>
    </div>
  );
}

/** Курс: ліворуч теми з кроками, праворуч крок. Той самий вигляд для читача й для редактора. */
function CourseView({ id, canEdit, onBack }: { id: number; canEdit: boolean; onBack: () => void }) {
  const [d, setD] = useState<TrainingCourseDetail | null>(null);
  const [curId, setCurId] = useState<number | null>(null);
  const [edit, setEdit] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Теми бібліотеки, які ще не належать жодному курсу: їх можна забрати сюди, не створюючи нову. */
  const [free, setFree] = useState<TrainingModule[]>([]);
  /** Тема, у яку зараз додаємо крок (`null` — діалог закритий). */
  const [addTo, setAddTo] = useState<{ id: number; name: string } | null>(null);
  /** 📎 Межа й перелік типів — З СЕРВЕРА, власного числа фронт не має (`#712`). */
  const [upload, setUpload] = useState<TrainingUploadRules | null>(null);

  const load = useCallback(() => {
    fetchTrainingCourse(id).then((x) => { setD(x); setErr(null); }).catch((e) => setErr(errText(e)));
    fetchTrainingCourses().then((x) => { setFree(x.freeModules ?? []); setUpload(x.upload); }).catch(() => setFree([]));
  }, [id]);
  useEffect(load, [load]);

  const steps = useMemo(() => (d?.modules ?? []).flatMap((m) => m.materials.map((s) => ({ ...s, moduleName: m.name }))), [d]);
  const cur = curId != null ? steps.find((s) => s.id === curId) ?? null : steps.find((s) => s.state === "available" || s.state === "opened") ?? steps[0] ?? null;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr(null);
    try { await fn(); load(); } catch (e) { setErr(errText(e)); }
    setBusy(false);
  };

  if (err && !d) return <div className="hr-card" style={{ padding: 16, color: "var(--danger)" }}>{err} <button className="hr-btn xs" onClick={onBack}>← Назад</button></div>;
  if (!d) return <p className="loading-text">Завантаження…</p>;
  const done = steps.filter((s) => s.state === "done").length, req = steps.filter((s) => s.required).length;

  return (
    <div>
      <div className="hr-pills" style={{ alignItems: "center" }}>
        <button className="hr-btn" onClick={onBack}>← Усі курси</button>
        <b style={{ fontSize: 16 }}>{d.course.title}</b>
        {canEdit && <span className={`hr-pill ${d.course.published ? "ok" : "wn"}`}>{d.course.published ? "опубліковано" : "чернетка"}</span>}
        <span className="hr-muted" style={{ marginLeft: "auto" }}>{done} із {req} обовʼязкових</span>
        <span className="tr-track" style={{ width: 120 }}><i style={{ width: `${d.percent}%`, background: d.percent === 100 ? "var(--ok)" : "var(--info)" }} /></span>
        {canEdit && (
          <>
            <div className="hr-seg">
              <button className={edit ? "" : "on"} onClick={() => setEdit(false)}>Перегляд</button>
              <button className={edit ? "on" : ""} onClick={() => setEdit(true)}>Редагування</button>
            </div>
            <button className="hr-btn xs" disabled={busy || steps.length === 0} title={steps.length ? "" : "Порожній курс публікувати нема сенсу"}
              onClick={() => void act(() => patchTrainingCourse(id, { published: !d.course.published }))}>
              {d.course.published ? "Приховати" : "Опублікувати"}
            </button>
          </>
        )}
      </div>

      {err && <div className="hr-card" style={{ padding: 10, color: "var(--danger)" }}>{err}</div>}

      {canEdit && edit && (
        <div className="hr-card tr-edithead">
          <label><span>Назва курсу</span>
            <input key={d.course.title} className="hr-inp" defaultValue={d.course.title}
              onBlur={(e) => { const t = e.target.value.trim(); if (t && t !== d.course.title) void act(() => patchTrainingCourse(id, { title: t })); }} />
          </label>
          <label><span>Для кого</span>
            <select className="hr-inp" value={d.course.audience} onChange={(e) => void act(() => patchTrainingCourse(id, { audience: e.target.value as TrainingAudience }))}>
              {AUDIENCE.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
            </select>
          </label>
          <label className="wide"><span>Опис</span>
            <input key={d.course.description ?? ""} className="hr-inp" defaultValue={d.course.description ?? ""} placeholder="Про що цей курс"
              onBlur={(e) => { const v = e.target.value.trim(); if (v !== (d.course.description ?? "")) void act(() => patchTrainingCourse(id, { description: v || null })); }} />
          </label>
        </div>
      )}

      <div className="tr-course">
        <div className="hr-card tr-outline">
          {d.modules.length === 0 && <div className="tr-mod hr-muted">Тем ще немає.{canEdit && edit ? " Додайте першу кнопкою нижче." : ""}</div>}
          {d.modules.map((m) => (
            <div key={m.id} className="tr-mod">
              <div className="tr-mh">
                <b>{m.name}</b>
                {canEdit && edit ? (
                  <>
                    <button className="hr-btn xs" title="Перейменувати тему" disabled={busy}
                      onClick={() => { const n = window.prompt("Назва теми:", m.name)?.trim(); if (n && n !== m.name) void act(() => updateTrainingFolder(m.id, { name: n })); }}>✏️</button>
                    <button className="hr-btn xs" title="Прибрати тему з курсу (матеріали лишаються)" disabled={busy}
                      onClick={() => { if (window.confirm(`Прибрати тему «${m.name}» з курсу? Матеріали лишаться в бібліотеці.`)) void act(() => updateTrainingFolder(m.id, { courseId: null })); }}>↩</button>
                    {/* 📎 Крок додається ТУТ, у своїй темі: доти шлях був кружний — піти в «Бібліотеку»,
                        створити там матеріал, повернутись і причепити тему. Саме тому з екрана й читалось,
                        що фото чи відео додати не можна. */}
                    <button className="hr-btn xs" title="Додати крок у цю тему — фото, відео, документ або текст"
                      disabled={busy} onClick={() => setAddTo({ id: m.id, name: m.name })}>+ Крок</button>
                  </>
                ) : <span className="hr-muted">{m.percent}%</span>}
              </div>
              {m.materials.map((s, si) => (
                <div key={s.id} className="tr-lrow-wrap">
                  <button className={`tr-lrow ${cur?.id === s.id ? "on" : ""} ${s.state === "locked" && !(canEdit && edit) ? "lock" : ""}`}
                    disabled={s.state === "locked" && !(canEdit && edit)}
                    title={s.state === "locked" && s.blockedBy ? `Спершу «${s.blockedBy.title}»` : ""}
                    onClick={() => setCurId(s.id)}>
                    <span className="ic">{s.state === "done" ? "✅" : s.state === "locked" && !(canEdit && edit) ? "🔒" : KIND[s.kind].icon}</span>
                    <span className="tt">{s.title}</span>
                    {!s.required && <span className="hr-pill gr">необовʼязково</span>}
                  </button>
                  {canEdit && edit && (
                    <span className="tr-lacts">
                      {/* ⬆ міняє місцями з попереднім кроком теми: обом ставимо позицію за їхнім НОВИМ номером
                          у списку — сервер сортує саме за `position`, тож двох запитів досить. */}
                      <button className="hr-btn xs" title="Підняти вище" disabled={busy || si === 0}
                        onClick={() => { const prev = m.materials[si - 1]; void act(async () => {
                          await updateTrainingMaterial(s.id, { position: si });
                          await updateTrainingMaterial(prev.id, { position: si + 1 });
                        }); }}>↑</button>
                      <button className="hr-btn xs" title={s.required ? "Зробити необовʼязковим" : "Зробити обовʼязковим"} disabled={busy}
                        onClick={() => void act(() => updateTrainingMaterial(s.id, { required: !s.required }))}>{s.required ? "★" : "☆"}</button>
                      <button className="hr-btn xs" title="Видалити крок" disabled={busy}
                        onClick={() => { if (window.confirm(`Видалити крок «${s.title}»? Прогрес людей по ньому теж зникне.`)) void act(() => deleteTrainingMaterial(s.id)); }}>🗑</button>
                    </span>
                  )}
                </div>
              ))}
              {m.materials.length === 0 && <div className="hr-muted" style={{ padding: "4px 8px" }}>Кроків немає.{canEdit && edit ? " Додайте перший кнопкою «+ Крок» вище." : ""}</div>}
            </div>
          ))}
          {canEdit && edit && (
            <div className="tr-mod">
              <button className="hr-btn xs" disabled={busy}
                onClick={() => { const n = window.prompt("Назва нової теми:")?.trim(); if (n) void act(async () => { const f = await createTrainingFolder(n, null); await updateTrainingFolder(f.id, { courseId: id }); }); }}>+ Тема</button>
              {free.length > 0 && (
                <select className="hr-inp" style={{ marginLeft: 6 }} value="" disabled={busy}
                  onChange={(e) => { const fid = Number(e.target.value); if (fid) void act(() => updateTrainingFolder(fid, { courseId: id })); }}>
                  <option value="">+ Наявна тема з бібліотеки…</option>
                  {free.map((f) => <option key={f.id} value={f.id}>{f.name} ({f.steps})</option>)}
                </select>
              )}
              {d.modules.length > 0 && (
                <button className="hr-btn xs" style={{ marginLeft: 6 }} disabled={busy}
                  onClick={() => { if (window.confirm("Видалити ПОРОЖНЮ тему? Тема з матеріалами не видаляється — спершу перенесіть їх.")) {
                    const empty = d.modules.find((m) => m.materials.length === 0);
                    if (empty) void act(() => deleteTrainingFolder(empty.id)); else setErr("Порожніх тем немає — видаляти нічого.");
                  } }}>🗑 Порожню тему</button>
              )}
            </div>
          )}
        </div>

        {cur ? <StepPane key={cur.id} step={cur} edit={canEdit && edit} busy={busy} onChanged={load}
          nextTitle={steps[steps.findIndex((s) => s.id === cur.id) + 1]?.title ?? null}
          onNext={() => { const i = steps.findIndex((s) => s.id === cur.id); const n = steps[i + 1]; if (n) setCurId(n.id); }} />
          : <div className="hr-card" style={{ padding: 18 }}><span className="hr-muted">У курсі ще немає кроків.{canEdit ? " Увімкніть «Редагування», додайте тему і крок у ній." : ""}</span></div>}
      </div>

      {addTo && upload && (
        <AddStep folder={addTo} upload={upload} onClose={() => setAddTo(null)}
          onAdded={() => { setAddTo(null); load(); }} />
      )}
    </div>
  );
}

/**
 * ➕ ДОДАТИ КРОК У ТЕМУ — фото, відео, документ, посилання або текст (23.09.2026).
 *
 * 🔴 ЧОМУ ЦЕ ТУТ, А НЕ ЛИШЕ В «БІБЛІОТЕЦІ». Сервер приймав файл із самого початку, і крок уже
 * вмів малювати `image/*` картинкою, а `video/*` — програвачем. Не було рівно одного: місця,
 * де людина може це зробити, дивлячись на курс. Шлях був кружний (бібліотека → створити →
 * повернутись → причепити тему), тож з екрана читалось «фото й відео додати не можна».
 *
 * 🔴 ТИП І МЕЖУ ВИРІШУЄ СЕРВЕР, а форма лише показує його ж правила (`upload` із відповіді):
 * власне число тут розійшлося б із серверним мовчки, і межу людина дізнавала б із 413 ПІСЛЯ
 * хвилини завантаження. Перевірка на боці форми — ввічливість, не межа; справжню тримає
 * `core/trainingUpload.ts`.
 *
 * ⚠️ Прев'ю показуємо ДО збереження: інакше «я завантажив не те» зʼясовується вже кроком у курсі.
 */
function AddStep({ folder, upload, onClose, onAdded }: {
  folder: { id: number; name: string }; upload: TrainingUploadRules; onClose: () => void; onAdded: () => void;
}) {
  type Mode = "file" | "video_embed" | "link" | "text";
  const [mode, setMode] = useState<Mode>("file");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [content, setContent] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [pct, setPct] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const maxMb = Math.round(upload.maxBytes / (1024 * 1024));

  // Прев'ю живе рівно поки живе вибраний файл — інакше blob-адреси течуть при кожній заміні.
  useEffect(() => {
    if (!file) { setPreview(null); return; }
    const u = URL.createObjectURL(file);
    setPreview(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  const take = (f: File | null | undefined) => {
    if (!f) return;
    setErr(null);
    if (f.size > upload.maxBytes) {
      setErr(`Файл ${Math.ceil(f.size / (1024 * 1024))} МБ — більше за межу ${maxMb} МБ. Велике відео додайте посиланням.`);
      return;
    }
    setFile(f);
    if (!title.trim()) setTitle(f.name.replace(/\.[^.]+$/, ""));
  };

  const save = async () => {
    const t = title.trim();
    if (!t) { setErr("Вкажіть назву кроку"); return; }
    setBusy(true); setErr(null);
    try {
      if (mode === "file") {
        if (!file) { setErr("Оберіть файл"); setBusy(false); return; }
        const dataBase64 = await new Promise<string>((res, rej) => {
          const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(file);
        });
        setPct(0);
        await createTrainingMaterial({ folderId: folder.id, title: t, kind: "file", filename: file.name,
          mime: file.type || null, dataBase64, content: content.trim() || null }, setPct);
      } else if (mode === "text") {
        if (!content.trim()) { setErr("Текст кроку порожній"); setBusy(false); return; }
        await createTrainingMaterial({ folderId: folder.id, title: t, kind: "text", content: content.trim() });
      } else {
        if (!/^https?:\/\//i.test(url.trim())) { setErr("Вкажіть посилання, що починається з http:// або https://"); setBusy(false); return; }
        await createTrainingMaterial({ folderId: folder.id, title: t, kind: mode, url: url.trim(), content: content.trim() || null });
      }
      onAdded();
    } catch (e) {
      setErr(errText(e));
    } finally { setBusy(false); setPct(null); }
  };

  const MODES: { key: Mode; label: string; hint: string }[] = [
    { key: "file", label: "📎 Файл", hint: `Фото, відео, документ — до ${maxMb} МБ` },
    { key: "video_embed", label: "🎬 Відео посиланням", hint: "YouTube, Vimeo або пряме посилання на відео" },
    { key: "link", label: "🔗 Посилання", hint: "Зовнішня сторінка" },
    { key: "text", label: "📝 Текст", hint: "Написати прямо тут" },
  ];
  const hint = MODES.find((x) => x.key === mode)!.hint;

  return (
    <div className="hr-modal-back" onClick={onClose}>
      <div className="hr-modal tr-add" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 2px", fontSize: 16 }}>Новий крок</h3>
        <div className="hr-muted" style={{ marginBottom: 12 }}>у тему «{folder.name}»</div>

        <div className="hr-pills" style={{ marginBottom: 4 }}>
          {MODES.map((x) => (
            <button key={x.key} className={`hr-pill ${mode === x.key ? "pl" : "gr"}`} disabled={busy}
              onClick={() => { setMode(x.key); setErr(null); }}>{x.label}</button>
          ))}
        </div>
        <div className="hr-muted" style={{ marginBottom: 12 }}>{hint}</div>

        {mode === "file" && (
          <div className={`tr-drop ${over ? "over" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files?.[0]); }}>
            <input id="tr-file" type="file" accept={upload.accept} style={{ display: "none" }}
              onChange={(e) => take(e.target.files?.[0])} />
            {!file ? (
              <label htmlFor="tr-file" className="tr-dropin">
                <b>Перетягніть файл сюди</b>
                <span className="hr-muted">або натисніть, щоб обрати — фото, відео, документ (до {maxMb} МБ)</span>
              </label>
            ) : (
              <div className="tr-dropped">
                {file.type.startsWith("image/") && preview && <img src={preview} alt={file.name} />}
                {file.type.startsWith("video/") && preview && <video src={preview} controls />}
                <div className="tr-dropmeta">
                  <b>{file.name}</b>
                  <span className="hr-muted">{(file.size / (1024 * 1024)).toFixed(1)} МБ{file.type ? ` · ${file.type}` : ""}</span>
                  <label htmlFor="tr-file" className="hr-btn xs" style={{ marginTop: 6 }}>Обрати інший</label>
                </div>
              </div>
            )}
          </div>
        )}

        {(mode === "video_embed" || mode === "link") && (
          <input className="hr-inp" value={url} placeholder="https://…" disabled={busy}
            onChange={(e) => setUrl(e.target.value)} style={{ width: "100%" }} />
        )}

        <label style={{ display: "block", marginTop: 12 }}>
          <span className="hr-muted">Назва кроку</span>
          <input className="hr-inp" value={title} disabled={busy} placeholder="Як крок буде названо в курсі"
            onChange={(e) => setTitle(e.target.value)} style={{ width: "100%" }} />
        </label>

        <label style={{ display: "block", marginTop: 10 }}>
          <span className="hr-muted">{mode === "text" ? "Текст кроку" : "Опис (не обовʼязково)"}</span>
          <textarea className="hr-inp" rows={mode === "text" ? 8 : 2} value={content} disabled={busy}
            onChange={(e) => setContent(e.target.value)} style={{ width: "100%", resize: "vertical" }} />
        </label>

        {pct != null && <div className="tr-track" style={{ marginTop: 12 }}><i style={{ width: `${pct}%`, background: "var(--info)" }} /></div>}
        {err && <div style={{ color: "var(--danger)", fontSize: 13, marginTop: 10 }}>{err}</div>}

        <div className="hr-pills" style={{ marginTop: 16, justifyContent: "flex-end" }}>
          <button className="hr-btn" onClick={onClose} disabled={busy}>Скасувати</button>
          <button className="hr-btn p" onClick={() => void save()} disabled={busy}>
            {busy ? (pct != null ? `Завантажую ${pct}%` : "Зберігаю…") : "Додати крок"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Крок: те, що бачить людина. У режимі редагування зверху зʼявляється правка назви й тексту. */
function StepPane({ step, edit, busy, onChanged, onNext, nextTitle }: {
  step: { id: number; title: string; kind: TrainingKind; required: boolean; state: string; moduleName: string };
  edit: boolean; busy: boolean; onChanged: () => void; onNext: () => void; nextTitle: string | null;
}) {
  const [m, setM] = useState<TrainingMaterialContent | null>(null);
  const [blob, setBlob] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true, url: string | null = null;
    setM(null); setBlob(null);
    fetchTrainingMaterial(step.id).then((x) => {
      if (!alive) return;
      setM(x);
      if (x.kind === "file" && x.hasFile) fetchTrainingFileBlobUrl(step.id).then((u) => { if (alive) { url = u; setBlob(u); } }).catch(() => undefined);
      if (x.status == null) void openTrainingMaterial(step.id).then(onChanged).catch(() => undefined);
    }).catch((e) => setErr(errText(e)));
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [step.id, onChanged]);

  const markDone = async () => {
    setSaving(true);
    try { await doneTrainingMaterial(step.id); onChanged(); onNext(); } catch (e) { setErr(errText(e)); }
    setSaving(false);
  };

  return (
    <div className="hr-card tr-step">
      {edit && m && (
        <div className="tr-edit">
          <div className="tr-erow">
            <label style={{ flex: "2 1 240px" }}><span>Назва кроку</span>
              <input key={m.title} className="hr-inp" defaultValue={m.title}
                onBlur={(e) => { const t = e.target.value.trim(); if (t && t !== m.title) void updateTrainingMaterial(step.id, { title: t }).then(onChanged).catch((x) => setErr(errText(x))); }} />
            </label>
            <span className="hr-pill gr">{KIND[m.kind].icon} {KIND[m.kind].label}</span>
            <span className={`hr-pill ${m.required ? "pl" : "gr"}`}>{m.required ? "обовʼязковий" : "необовʼязковий"}</span>
          </div>
          {m.kind === "text" ? (
            <textarea className="hr-inp" key={m.content ?? ""} rows={8} defaultValue={m.content ?? ""} style={{ width: "100%", resize: "vertical" }}
              onBlur={(e) => { const v = e.target.value; if (v !== (m.content ?? "")) void updateTrainingMaterial(step.id, { content: v }).then(onChanged).catch((x) => setErr(errText(x))); }} />
          ) : (
            <input key={m.url ?? ""} className="hr-inp" defaultValue={m.url ?? ""} placeholder="https://…"
              onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== (m.url ?? "")) void updateTrainingMaterial(step.id, { url: v }).then(onChanged).catch((x) => setErr(errText(x))); }} />
          )}
          <div className="hr-muted">Зміни зберігаються, щойно ви виходите з поля. Нижче — те, що побачить людина.</div>
        </div>
      )}

      <h3 style={{ margin: "0 0 2px", fontSize: 16 }}>{step.title}</h3>
      <div className="hr-muted" style={{ marginBottom: 12 }}>{step.moduleName}{step.required ? "" : " · необовʼязковий крок"}</div>

      {err && <div style={{ color: "var(--danger)", fontSize: 13, marginBottom: 8 }}>{err}</div>}
      {!m ? <p className="loading-text">Завантаження…</p> : (
        <>
          {m.kind === "text" && <div className="tr-body">{m.content || "Текст кроку порожній."}</div>}
          {m.kind === "video_embed" && m.url && (() => {
            const e = embedUrl(m.url);
            return e.direct
              ? <video src={e.direct} controls style={{ width: "100%", borderRadius: 8, background: "#000" }} />
              : <div className="tr-embed"><iframe src={e.iframe} title={m.title} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowFullScreen /></div>;
          })()}
          {m.kind === "link" && m.url && <a className="hr-btn" href={m.url} target="_blank" rel="noopener noreferrer">Відкрити посилання ↗</a>}
          {m.kind === "file" && (m.mime === "application/pdf" && blob
            ? <iframe src={blob} title={m.title} className="tr-pdf" />
            : m.mime?.startsWith("image/") && blob ? <img src={blob} alt={m.title} style={{ maxWidth: "100%", borderRadius: 8 }} />
            : m.mime?.startsWith("video/") && blob ? <video src={blob} controls style={{ width: "100%", borderRadius: 8, background: "#000" }} />
            : <div className="tr-file">📄 {m.title}{blob && <> · <a href={blob} download={m.title}>завантажити</a></>}</div>)}
          {m.content && m.kind !== "text" && <p className="hr-muted" style={{ marginTop: 12, whiteSpace: "pre-wrap" }}>{m.content}</p>}

          {!edit && (
            <div className="tr-actions">
              <button className="hr-btn p" disabled={saving || busy || step.state === "done"} onClick={() => void markDone()}>
                {step.state === "done" ? "Опрацьовано ✓" : saving ? "Зберігаю…" : nextTitle ? "Опрацював(ла) — далі" : "Опрацював(ла)"}
              </button>
              {nextTitle && <span className="hr-muted">далі: {nextTitle}</span>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

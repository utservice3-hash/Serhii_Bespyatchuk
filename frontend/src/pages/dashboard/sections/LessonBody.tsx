import { useEffect, useState } from "react";
import { fetchTrainingFileBlobUrl, type TrainingMaterialContent } from "../../../api";
import { embedUrl } from "../trainingView";
import { lessonLayout, sizeLabel, type LessonItem } from "../lessonLayout";
import { PdfViewer } from "./PdfViewer";
import "./training.css";

/**
 * 📘 ТІЛО УРОКУ ЯК У SEREDA (27.09.2026) — одне на обидва екрани: крок курсу (`TrainingCourses`) і екран
 * кандидата (`CandidateTraining`). Порядок: текст уроку, під ним те, що дивляться (pdf-переглядач, відео,
 * зображення), нижче — «Вкладення» з розміром і кнопкою завантаження. У Sereda текст стоїть ПІД переглядачем;
 * тут навпаки за рішенням Романа 28.09 (`#736`). ЩО куди йде, вирішує `lessonLayout.ts`; тут лише вигляд.
 *
 * 🔴 ОДИН КОМПОНЕНТ, А НЕ ДВІ КОПІЇ. Досі кожен екран малював крок сам, і вони вже розійшлись у дрібницях
 * (підпис посилання, «Файл завантажується…» лише в кандидата). Урок із частинами зробив би з двох копій дві
 * різні програми. Тримає `#729`.
 *
 * ⚠️ Файли тягнуться тим самим захищеним запитом (`/material/:id/file`), що й раніше: вкладення — лише за
 * натисканням, бо їх можуть і не відкривати, а тягнути 5 МБ «про запас» на кожен урок — марнотратство.
 */
export function LessonBody({ m }: { m: TrainingMaterialContent }) {
  const layout = lessonLayout(m, m.parts ?? []);
  const [blobs, setBlobs] = useState<Record<number, string>>({});

  // Файли, які треба ПОКАЗАТИ (pdf, зображення, відео), — одразу; адреси звільняються разом з уроком.
  useEffect(() => {
    let alive = true;
    const made: string[] = [];
    setBlobs({});                                   // новий урок — без адрес попереднього
    for (const it of layout.main) {
      if (!it.hasFile || !["pdf", "image", "video"].includes(it.show)) continue;
      fetchTrainingFileBlobUrl(it.id).then((u) => {
        made.push(u);
        if (alive) setBlobs((b) => ({ ...b, [it.id]: u })); else URL.revokeObjectURL(u);
      }).catch(() => undefined);
    }
    return () => { alive = false; made.forEach((u) => URL.revokeObjectURL(u)); };
    // Урок той самий, доки той самий id і склад частин.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.id, (m.parts ?? []).map((p) => p.id).join(",")]);

  const empty = !layout.main.length && !layout.text && !layout.attachments.length;

  return (
    <div className="tr-lsn">
      {/* 🔝 ТЕКСТ — НАД ПРЕЗЕНТАЦІЄЮ. У Sereda навпаки (заміряно: переглядач зверху, текст під ним), але Роман
          28.09 вирішив інакше: «презентація зверху, а текст знизу — мало б бути навпаки». Спершу пояснення, потім
          слайди. Це свідоме відхилення від Sereda, тримає `#736`. */}
      {layout.text && <div className="tr-body tr-lsn-text">{layout.text}</div>}
      {layout.main.map((it) => <MainItem key={it.id} it={it} src={blobs[it.id] ?? null} />)}
      {layout.attachments.length > 0 && <Attachments items={layout.attachments} />}
      {empty && <p className="hr-muted">У цьому уроці поки нічого немає.</p>}
    </div>
  );
}

function MainItem({ it, src }: { it: LessonItem; src: string | null }) {
  if (it.show === "embed" && it.url) {
    const e = embedUrl(it.url);
    return e.direct
      ? <video className="tr-lsn-media" src={e.direct} controls />
      : <div className="tr-embed"><iframe src={e.iframe} title={it.title} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowFullScreen /></div>;
  }
  if (it.show === "link" && it.url) return <a className="hr-btn" href={it.url} target="_blank" rel="noopener noreferrer">Відкрити посилання ↗</a>;
  if (!src) return <div className="tr-lsn-wait"><span className="pdfv-spinner" aria-label="Завантаження" /></div>;
  if (it.show === "pdf") return <PdfViewer src={src} title={it.title} />;
  if (it.show === "image") return <img className="tr-lsn-media" src={src} alt={it.title} />;
  return <video className="tr-lsn-media" src={src} controls />;
}

/** «Вкладення» як у Sereda: скріпка, назва, розмір у дужках, кнопка завантаження праворуч. */
function Attachments({ items }: { items: LessonItem[] }) {
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const save = async (it: LessonItem) => {
    setBusy(it.id); setErr(null);
    try {
      const u = await fetchTrainingFileBlobUrl(it.id);
      const a = document.createElement("a");
      a.href = u; a.download = fileName(it);
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 10_000);
    } catch { setErr(`Не вдалося завантажити «${it.title}». Спробуйте ще раз.`); }
    setBusy(null);
  };
  return (
    <div className="tr-att">
      <div className="tr-att-h"><ClipIcon /> Вкладення</div>
      {items.map((it) => (
        <button key={it.id} type="button" className="tr-att-row" disabled={busy === it.id || !it.hasFile} onClick={() => void save(it)}
          title={it.hasFile ? `Завантажити «${it.title}»` : "Файл відсутній"}>
          <ClipIcon />
          <span className="tr-att-name">{it.title}</span>
          {sizeLabel(it.sizeBytes) && <span className="tr-att-size">({sizeLabel(it.sizeBytes)})</span>}
          <span className="tr-att-dl">{busy === it.id ? <span className="pdfv-spinner" /> : <DownloadIcon />}</span>
        </button>
      ))}
      {err && <div className="tr-att-err">{err}</div>}
    </div>
  );
}

/** Імʼя файла для збереження: назва + розширення з типу, якщо в назві його немає (у Sereda назви без розширень). */
function fileName(it: LessonItem): string {
  if (/\.[a-z0-9]{2,5}$/i.test(it.title)) return it.title;
  const ext: Record<string, string> = {
    "application/pdf": ".pdf", "image/png": ".png", "image/jpeg": ".jpg", "video/mp4": ".mp4",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  };
  return it.title + (ext[(it.mime ?? "").toLowerCase()] ?? "");
}

const ClipIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />
  </svg>
);
const DownloadIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 3v12" /><path d="M7 10l5 5 5-5" /><path d="M5 21h14" />
  </svg>
);

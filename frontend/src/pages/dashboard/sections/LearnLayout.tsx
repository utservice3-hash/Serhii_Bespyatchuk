import { useState, type ReactNode } from "react";
import {
  lessonAfter, lessonsCount, lessonsWord, moduleStat, openModuleId, programStat,
  type ProgramLesson, type ProgramModule,
} from "../learnProgram";
import "./training.css";

/**
 * 🎓 НАВЧАННЯ В БУДОВІ SEREDA (28.09.2026, Роман: «воно не як sereda ai» → «все як в середі»).
 *
 * 🔴 ГОЛОВНА ВІДМІННІСТЬ БУЛА НЕ В КОЛЬОРАХ, А В БУДОВІ. У Sereda курс і урок — ДВІ сторінки (заміряно на
 * курсі «для менеджерів з продажу»):
 *   • КУРС — шапка з назвою, плашкою «Курс завершено» (або прогресом) і лічильниками; нижче «Програма курсу»:
 *     теми-акордеони (значок, назва, «1 з 1 уроку», кільце «1/1», стрілка), у розгорнутій — уроки;
 *   • УРОК — широка колонка з уроком (назад, «Урок», заголовок, «Урок завершено», тіло) і бічна панель
 *     праворуч: «Наступний», «20 з 20 уроків · 100%», ті самі теми меншими.
 * У нас усе було на одній сторінці: зміст ліворуч, крок праворуч. Тут — саме будова Sereda, у кольорах
 * дашборда (червоний бренду замість синього Sereda).
 *
 * Стан уроку (пройдено / доступно / замкнено) — з СЕРВЕРА, тут лише показ (`#708`). Один набір компонентів
 * на обидва екрани — викладача й кандидата (`#732`).
 */

// ── Значки: прості лінійні, як у Sereda ────────────────────────────────────────
const I = {
  check: <path d="M20 6L9 17l-5-5" />,
  lock: <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>,
  book: <><path d="M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2z" /><path d="M22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z" /></>,
  file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M8 13h8M8 17h5" /></>,
  video: <><rect x="2" y="6" width="14" height="12" rx="2" /><path d="M16 10l6-3v10l-6-3" /></>,
  link: <><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" /></>,
  chevron: <path d="M6 9l6 6 6-6" />,
  back: <path d="M19 12H5M12 19l-7-7 7-7" />,
  next: <path d="M5 12h14M12 5l7 7-7 7" />,
  trophy: <><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z" /><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3" /></>,
  layers: <><path d="M12 2l10 6-10 6L2 8z" /><path d="M2 16l10 6 10-6" /></>,
  circle: <circle cx="12" cy="12" r="9" />,
};
function Ic({ n, size = 18, className }: { n: keyof typeof I; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{I[n]}</svg>
  );
}
const kindIcon = (kind: string): keyof typeof I => (kind === "video_embed" ? "video" : kind === "link" ? "link" : "file");
const kindWord = (kind: string): string => (kind === "video_embed" ? "Відео" : kind === "link" ? "Посилання" : "Урок");

/** Кільце «k/n», як праворуч від теми в Sereda. */
function Ring({ done, total }: { done: number; total: number }) {
  const R = 17, C = 2 * Math.PI * R, part = total ? done / total : 0;
  return (
    <svg className="lr-ring" width="40" height="40" viewBox="0 0 40 40" role="img" aria-label={`${done} з ${total}`}>
      <circle cx="20" cy="20" r={R} fill="none" stroke="var(--border)" strokeWidth="3" />
      <circle cx="20" cy="20" r={R} fill="none" stroke={part === 1 ? "var(--ok)" : "var(--brand)"} strokeWidth="3" strokeLinecap="round"
        strokeDasharray={`${C * part} ${C}`} transform="rotate(-90 20 20)" />
      <text x="20" y="24" textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--text)">{done}/{total}</text>
    </svg>
  );
}

// ── Сторінка курсу ─────────────────────────────────────────────────────────────

/** Шапка курсу як у Sereda: назва, плашка стану, лічильники. */
export function CourseHeader({ title, percent, modules, onContinue, badge }: {
  title: string; percent: number; modules: readonly ProgramModule[]; onContinue: (id: number) => void; badge?: ReactNode;
}) {
  const st = programStat(modules);
  const complete = st.lessons > 0 && percent >= 100;
  return (
    <div className="lr-head">
      {badge && <div className="lr-head-badge">{badge}</div>}
      <h2 className="lr-title">{title}</h2>
      {complete ? (
        <div className="lr-banner ok">
          <span className="lr-banner-ic"><Ic n="trophy" size={22} /></span>
          <div><b>Курс завершено</b><span>Усі обовʼязкові уроки пройдено</span></div>
        </div>
      ) : st.lessons === 0 ? (
        <div className="lr-banner"><div><b>Уроків ще немає</b><span>Курс готується</span></div></div>
      ) : (
        <div className="lr-banner">
          <div className="lr-banner-grow">
            <b>Пройдено {percent}%</b>
            <span className="lr-bar"><i style={{ width: `${percent}%` }} /></span>
          </div>
          {st.next && <button type="button" className="hr-btn p" onClick={() => onContinue(st.next!.id)}>{st.done ? "Продовжити" : "Почати"}: {st.next.title}</button>}
        </div>
      )}
      <div className="lr-meta">
        <span><Ic n="book" size={16} /> {lessonsCount(st.lessons)}</span>
        <span><Ic n="layers" size={16} /> {st.modules} {st.modules === 1 ? "тема" : st.modules >= 2 && st.modules <= 4 ? "теми" : "тем"}</span>
        <span><Ic n="check" size={16} /> {st.done} пройдено</span>
      </div>
    </div>
  );
}

/**
 * «Програма курсу»: теми-акордеони. `side` — менший варіант для бічної панелі уроку (без кільця, з
 * підсвіченим поточним уроком), як у Sereda.
 */
export function ProgramAccordion({ modules, currentId, onOpen, side }: {
  modules: readonly ProgramModule[]; currentId: number | null; onOpen: (id: number) => void; side?: boolean;
}) {
  const [open, setOpen] = useState<Set<number>>(() => {
    const first = openModuleId(modules, currentId);
    return new Set(first == null ? [] : [first]);
  });
  const toggle = (id: number) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div className={`lr-prog${side ? " side" : ""}`}>
      {modules.map((m) => {
        const st = moduleStat(m), isOpen = open.has(m.id);
        return (
          <div key={m.id} className={`lr-mod${isOpen ? " open" : ""}`}>
            <button type="button" className="lr-mod-h" aria-expanded={isOpen} onClick={() => toggle(m.id)}>
              <span className={`lr-mod-ic${st.complete ? " ok" : ""}`}><Ic n={st.complete ? "check" : "book"} size={side ? 16 : 20} /></span>
              <span className="lr-mod-t">
                <b>{m.name}</b>
                <span>{side ? `${st.done}/${st.total}` : `${st.done} з ${st.total} ${lessonsWord(st.total)}`}</span>
              </span>
              {!side && <Ring done={st.done} total={st.total} />}
              <Ic n="chevron" size={18} className="lr-chev" />
            </button>
            {isOpen && (
              <div className="lr-lessons">
                {m.materials.length === 0 && <div className="lr-empty">Уроків у темі ще немає.</div>}
                {m.materials.map((l) => <LessonRow key={l.id} l={l} active={l.id === currentId} side={side} onOpen={onOpen} />)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function LessonRow({ l, active, side, onOpen }: { l: ProgramLesson; active: boolean; side?: boolean; onOpen: (id: number) => void }) {
  const locked = l.state === "locked", done = l.state === "done";
  return (
    <button type="button" className={`lr-les${active ? " on" : ""}${done ? " done" : ""}${locked ? " lock" : ""}`}
      disabled={locked} title={locked && l.blockedBy ? `Спершу пройдіть «${l.blockedBy.title}»` : l.title}
      onClick={() => onOpen(l.id)}>
      <span className={`lr-les-st${done ? " ok" : ""}`}><Ic n={done ? "check" : locked ? "lock" : "circle"} size={side ? 14 : 16} /></span>
      {!side && <span className="lr-les-kind"><Ic n={kindIcon(l.kind)} size={16} /></span>}
      <span className="lr-les-t">
        <span className="lr-les-name">{l.title}</span>
        {!side && <span className="lr-les-sub">{kindWord(l.kind)}{locked && l.blockedBy ? ` · після «${l.blockedBy.title}»` : ""}</span>}
      </span>
      {!side && <span className={`lr-les-req${l.required ? "" : " opt"}`}>{l.required ? "Обовʼязково" : "Необовʼязково"}</span>}
    </button>
  );
}

// ── Сторінка уроку ─────────────────────────────────────────────────────────────

/**
 * Урок як у Sereda: ліворуч — «Назад до курсу · Урок», заголовок, «Урок завершено», тіло (children), низ
 * (footer); праворуч — «Наступний», «k з n уроків · p%», теми. На вузькому екрані панель іде під урок.
 */
export function LessonPage({ title, done, modules, currentId, percent, onBack, onOpen, children, footer }: {
  title: string; done: boolean; modules: readonly ProgramModule[]; currentId: number; percent: number;
  onBack: () => void; onOpen: (id: number) => void; children: ReactNode; footer?: ReactNode;
}) {
  const st = programStat(modules);
  const next = lessonAfter(modules, currentId);
  const nextLocked = next?.state === "locked";
  return (
    <div className="lr-page">
      <div className="lr-main">
        <div className="lr-crumbs">
          <button type="button" className="lr-backlink" onClick={onBack}><Ic n="back" size={16} /> Назад до курсу</button>
          <span className="lr-chip">Урок</span>
        </div>
        <h1 className="lr-h1">{title}</h1>
        {done && (
          <div className="lr-done">
            <span className="lr-done-ic"><Ic n="check" size={20} /></span>
            <div><b>Урок завершено ✓</b><span>Ви вже пройшли цей урок</span></div>
          </div>
        )}
        {children}
        {footer && <div className="lr-foot">{footer}</div>}
      </div>
      <aside className="lr-side">
        <button type="button" className="lr-next" disabled={!next || nextLocked}
          title={!next ? "Це останній урок курсу" : nextLocked ? "Спершу опрацюйте цей урок" : `Далі: ${next.title}`}
          onClick={() => next && onOpen(next.id)}>
          Наступний <Ic n="next" size={16} />
        </button>
        <div className="lr-sprog">
          <div className="lr-sprog-row"><b>{st.done} з {st.lessons} {lessonsWord(st.lessons)}</b><span>{percent}%</span></div>
          <span className="lr-bar"><i style={{ width: `${percent}%` }} /></span>
        </div>
        <ProgramAccordion key={currentId} modules={modules} currentId={currentId} onOpen={onOpen} side />
      </aside>
    </div>
  );
}

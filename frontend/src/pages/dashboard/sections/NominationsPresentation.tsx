import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import {
  fetchReportPlan, fetchPresentationExtras, teamPhotoUrl, employeePhotoUrl, fetchPptxTemplate,
  type NominationWeek, type ReportPlan, type PresentationExtras, type PhotoRef,
} from "../../../api";
import { EmployeePhoto } from "./EmployeePhotos";
import { buildPresentationModel, dmy, short, num, type TopKey, type AwardM, type EventM } from "../presentationModel";
import { unzip, zipStore, fillPptx, photoNeeds } from "../pptxTemplate";
import "./presentation.css";

/**
 * 🎞 ПРЕЗЕНТАЦІЯ ЩОТИЖНЕВОЇ ЗУСТРІЧІ — МАКЕТ ДАШІ (04.11.2026, «Щотижнева зустріч UTS — новий дизайн»).
 * Повністю замінює попередню (рішення Романа: «потрібно повністю новий макет»). Один комерційний відділ — без
 * поділу на РПК/РНК: титул, події тижня, пульс плану, гроші й обсяг тижня (топ-3), особливі відзнаки, лідогенерація,
 * лідерборд конверсії, фокус.
 *
 * ЗВІДКИ ЧИСЛА — лише з тих самих ендпоінтів, що й екрани, без власної арифметики по грошах:
 *  · «Пульс плану» — верх Звіту за весь поточний місяць (`glance`: факт, план, очікуємо за план. датою);
 *  · топ-3 — `companyTop` сервера (рейтинги всіх команд тижня, з правками тімлідів);
 *  · лідогенерація, конверсія, тексти — `/nominations/week`;
 *  · події тижня, новачки, нові клієнти — `/nominations/presentation-extras` (ядро сервера);
 *  · «Прорив тижня» — колонка «Виконано %» Звіту за номінований тиждень (`pct`), без власного розрахунку.
 * Що з цього на якому слайді — `presentationModel.ts`: ОДНА модель і для екрана, і для PPTX.
 *
 * ⏳ ПРЕЗЕНТАЦІЯ ЗБИРАЄТЬСЯ НЕ ОДРАЗУ (04.11.2026): дані йдуть кількома запитами, і «Завантажити» до їх приходу давало файл
 * без половини слайдів. Тому — смужка прогресу, а обидві кнопки завантаження чекають, доки готове ВСЕ.
 */

const kyivToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
const monthEnd = (ymd: string) => {
  const d = new Date(`${ymd.slice(0, 7)}-01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1, 0);
  return d.toISOString().slice(0, 10);
};
/** Шрифти макета (Oswald — заголовки, Rubik — текст). Не в збірці свідомо: файл шрифту, на який посилається лише CSS,
 *  процедура викату видалила б (вона прибирає з докрута все, чого немає в `index.html`). Без інтернету — системний. */
const FONTS = "https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=Rubik:wght@400;500;600;700&display=swap";
const TONE: Record<EventM["kind"], string> = { birthday: "red", newcomer: "dark", position: "gold" };

/** Фото в квадратний JPEG (обрізка по центру): у PPTX коло шаблону, і квадрат лягає в нього без спотворення. */
async function squareJpeg(url: string, size: number): Promise<Uint8Array | null> {
  const img = new Image();
  img.src = url;
  try { await img.decode(); } catch { return null; }
  const s = Math.min(img.naturalWidth, img.naturalHeight);
  if (!s) return null;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  c.getContext("2d")!.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size);
  const blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, "image/jpeg", 0.88));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

type Step = "month" | "weekRep" | "extras" | "photos" | "fonts";
const STEPS: { k: Step; label: string }[] = [
  { k: "month", label: "пульс плану" }, { k: "weekRep", label: "звіт тижня" }, { k: "extras", label: "події й відзнаки" },
  { k: "photos", label: "фото" }, { k: "fonts", label: "шрифти" },
];

export function NominationsPresentation({ week, onClose }: { week: NominationWeek; onClose: () => void }) {
  const [month, setMonth] = useState<ReportPlan | null>(null);
  const [weekRep, setWeekRep] = useState<ReportPlan | null>(null);
  const [extras, setExtras] = useState<PresentationExtras | null>(null);
  const [teamPhoto, setTeamPhoto] = useState<string | null>(null);
  const [done, setDone] = useState<Partial<Record<Step, true>>>({});
  const [err, setErr] = useState<string | null>(null);
  const [i, setI] = useState(0);
  const [scale, setScale] = useState(1);
  const overlay = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const today = kyivToday();
  const mStart = `${today.slice(0, 7)}-01`;
  const mark = (k: Step) => setDone((d) => (d[k] ? d : { ...d, [k]: true }));

  useEffect(() => {
    let l = document.querySelector<HTMLLinkElement>(`link[href="${FONTS}"]`);
    if (!l) {
      l = document.createElement("link");
      l.rel = "stylesheet"; l.href = FONTS;
      document.head.appendChild(l);
    }
    // Шрифти — крок прогресу: PDF зі шрифтом-заміною розʼїжджається. Без інтернету не чекаємо вічно — 5 с і далі.
    const wait = l.sheet ? Promise.resolve() : new Promise<void>((ok) => { l!.addEventListener("load", () => ok()); l!.addEventListener("error", () => ok()); });
    void Promise.race([wait.then(() => document.fonts.ready), new Promise((ok) => setTimeout(ok, 5000))]).then(() => mark("fonts"));
  }, []);
  useEffect(() => {
    fetchReportPlan({ from: mStart, to: monthEnd(today) }).then((r) => { setMonth(r); mark("month"); })
      .catch(() => setErr("Не вдалося завантажити пульс плану — спробуйте ще раз"));
  }, [mStart, today]);
  useEffect(() => {
    fetchReportPlan({ from: week.weekFrom, to: week.weekTo }).then((r) => { setWeekRep(r); mark("weekRep"); })
      .catch(() => setErr("Не вдалося завантажити звіт тижня — спробуйте ще раз"));
    fetchPresentationExtras(week.weekFrom).then((x) => { setExtras(x); mark("extras"); })
      .catch(() => setErr("Не вдалося завантажити події тижня й відзнаки — спробуйте ще раз"));
  }, [week.weekFrom, week.weekTo]);

  const model = useMemo(() => buildPresentationModel({ week, month, weekRep, extras, today }), [week, month, weekRep, extras, today]);
  /** Фото людини на слайді: менеджер Kommo — з фото тижня, співробітник «Найму» — з фото подій. */
  const refOf = (n: { managerId?: number | null; employeeId?: number | null }): PhotoRef | null | undefined =>
    n.employeeId != null ? extras?.photos?.[String(n.employeeId)] : n.managerId != null ? week.photos?.[String(n.managerId)] : null;

  // Фото — коли відомо, хто на слайдах (усі дані прийшли): підтягуємо в кеш наперед, тоді PDF і PPTX їх уже мають.
  const dataReady = !!(done.month && done.weekRep && done.extras);
  useEffect(() => {
    if (!dataReady) return;
    let alive = true;
    const jobs = photoNeeds(model).map((n) => {
      if (n.team) return week.teamPhoto ? teamPhotoUrl(week.teamPhoto.v).then((u) => { if (alive) setTeamPhoto(u); }) : null;
      const r = refOf(n);
      return r ? employeePhotoUrl(r) : null;
    });
    void Promise.all(jobs).then(() => { if (alive) mark("photos"); });
    return () => { alive = false; };
  }, [dataReady, model, week.teamPhoto?.v]); // eslint-disable-line react-hooks/exhaustive-deps
  const doneN = STEPS.filter((s) => done[s.k]).length;
  const ready = doneN === STEPS.length && !err;
  const pending = STEPS.find((s) => !done[s.k]);

  const slides = useMemo(() => {
    const m = model;
    const out: { key: string; node: ReactElement }[] = [];
    const mark = m.draft ? <div className="ps-watermark">ЧЕРНЕТКА · тиждень ще не зафіксовано</div> : null;
    const foot = (extra?: string) => <div className="ps-foot">UTS • Комерційний відділ • {dmy(m.meeting)}{extra ? ` • ${extra}` : ""}</div>;
    const chip = (min: number, tone: "dark" | "red" = "dark") => <div className={`ps-chip ${tone}`}><i className="ps-clock" />{min} хв</div>;
    const ava = (who: { managerId?: number | null; employeeId?: number | null }, name: string, cls: string) =>
      <EmployeePhoto photo={refOf(who)} name={name} className={cls} />;
    const head = (kick: string, title: string, min: number, tone: "dark" | "red" = "dark") => (
      <div className="ps-head2"><div><div className="ps-kick2">{kick}</div><h2 className="ps-h2">{title}</h2></div>{chip(min, tone)}</div>
    );

    // 1 · Титул
    out.push({ key: "title", node: (
      <div className="ps-slide2 ps-cover">
        <div className="ps-cover-l">
          <div className="ps-uts">UTS</div>
          <h1 className="ps-cover-h">ЩОТИЖНЕВА<br />ЗУСТРІЧ</h1>
          <div className="ps-cover-sub">Комерційний відділ • {dmy(m.meeting)}</div>
          <div className="ps-cover-chips"><span className="ps-pill red"><i className="ps-clock" />15 хвилин</span><span className="ps-pill grey">UTS — транспортна компанія</span></div>
        </div>
        <div className="ps-cover-stripe" />
        <div className="ps-cover-r">
          <div className="ps-cover-photo">{teamPhoto ? <img src={teamPhoto} alt="Фото команди" /> : <span>Фото команди</span>}</div>
        </div>
        {mark}
      </div>
    ) });

    // 2 · Події тижня — з «Найму» (ДР, 14 днів від прийому) і «Нова посада» від Даші. Немає подій — слайда немає.
    const ev = m.events ?? [];
    if (ev.length) out.push({ key: "events", node: (
      <div className="ps-slide2">
        {head("КОМАНДА", "ПОДІЇ ТИЖНЯ", 2)}
        <div className={`ps-evs n${Math.min(ev.length, 6)}`}>
          {ev.slice(0, 6).map((e) => (
            <div className={`ps-ev ${TONE[e.kind]}`} key={`${e.kind}${e.employeeId}`}>
              {ava({ employeeId: e.employeeId }, e.name, "ps-evava")}
              <div className="ps-evtag">{e.tag}</div>
              <div className="ps-evname">{short(e.name)}</div>
              <div className="ps-evtext">{e.text}</div>
            </div>
          ))}
        </div>
        {ev.length > 6 ? <div className="ps-more">ще {ev.length - 6} — поза слайдом</div> : null}
        {foot()}
        {mark}
      </div>
    ) });

    // 3 · Пульс плану — верх Звіту за поточний місяць
    if (m.pulse) {
      const q = m.pulse;
      out.push({ key: "pulse", node: (
        <div className="ps-slide2 dark">
          {head(q.monthLabel, "ПУЛЬС ПЛАНУ", 1, "red")}
          <div className="ps-pulse"><div className="ps-pulse-n">{q.pct == null ? "—" : `${q.pct}%`}</div><div className="ps-pulse-t">плану виконано<br />за місяць</div></div>
          <div className="ps-bar2"><span style={{ width: `${Math.min(100, q.pct ?? 0)}%` }} /></div>
          <div className="ps-pcards">
            <div className="ps-pcard"><div className="l">ФАКТ / ПЛАН</div><div className="v">{num(q.fact)} / {num(q.plan)} ₴</div></div>
            <div className="ps-pcard"><div className="l">ЗАЛИШИЛОСЬ ДО ПЛАНУ</div><div className="v">{q.left == null ? "план виконано" : `${num(q.left)} ₴`}</div></div>
            <div className="ps-pcard"><div className="l">ОЧІКУЄМО ЗА ПЛАН. ДАТОЮ</div><div className="v">{num(q.expect)} ₴</div></div>
          </div>
          {foot()}
          {mark}
        </div>
      ) });
    }

    // 4–5 · Топ-3 на весь відділ: три рядки; хто ділить місце з третім — підписом знизу (ревʼю 04.11.2026)
    const topCol = (k: TopKey, title: string) => {
      const { rows, tied } = m.tops[k];
      return (
        <div className="ps-tcol">
          <div className="ps-tcol-h">{title}</div>
          {rows.length === 0 ? <div className="ps-trow empty">ніхто не набрав</div> : rows.map((r) => (
            <div className={`ps-trow p${Math.min(r.place, 3)}`} key={`${r.managerId}`}>
              <div className="ps-place">{r.place}</div>
              {ava({ managerId: r.managerId }, r.name, "ps-tava")}
              <div className="ps-tinfo"><div className="ps-tname">{r.name}</div>
                <div className={`ps-tval${r.place === 1 ? " first" : ""}`}>{r.text}{r.manual ? <span className="ps-manual">✎</span> : null}</div></div>
            </div>
          ))}
          {tied.length ? <div className="ps-more">з тим самим результатом: {tied.join(", ")}</div> : null}
        </div>
      );
    };
    out.push({ key: "money", node: (
      <div className="ps-slide2">
        {head("НОМІНАЦІЇ • ТОП-3", "ГРОШІ ТИЖНЯ", 2)}
        <div className="ps-tcols">{topCol("maxDeal", "НАЙБІЛЬШИЙ РАЗОВИЙ ЗАЗОР")}{topCol("revenue", "НАЙБІЛЬШЕ В «УСПІШНИХ»")}</div>
        {foot("однаковий результат = однакове місце")}
        {mark}
      </div>
    ) });
    out.push({ key: "volume", node: (
      <div className="ps-slide2">
        {head("НОМІНАЦІЇ • ТОП-3", "ОБСЯГ ТИЖНЯ", 2)}
        <div className="ps-tcols">{topCol("cars", "ПОСТАВЛЕНІ АВТО")}{topCol("intl", "МІЖНАРОДНІ ПЕРЕВЕЗЕННЯ")}</div>
        {foot("однаковий результат = однакове місце")}
        {mark}
      </div>
    ) });

    // 6 · Особливі відзнаки — по одному переможцю (нічия — усі імена, фото першого)
    if (m.awards) {
      const award = (icon: string, title: string, sub: string, a: AwardM) => (
        <div className="ps-aw">
          <div className="ps-aw-i">{icon}</div>
          <div className="ps-aw-t">{title}</div>
          <div className="ps-aw-s">{sub}</div>
          <div className="ps-aw-ph">{a.names.length ? ava(a, a.names[0], "ps-awava") : <div className="ps-aw-none" />}</div>
          <div className="ps-aw-n">{a.names.length ? a.names.map(short).join(", ") : "немає претендентів"}</div>
          {a.value ? <div className="ps-aw-v">{a.value}</div> : null}
        </div>
      );
      out.push({ key: "awards", node: (
        <div className="ps-slide2 warm">
          {head("НОВІ НОМІНАЦІЇ", "ОСОБЛИВІ ВІДЗНАКИ", 3)}
          <div className="ps-aws">
            {award("⚡", "ПРОРИВ ТИЖНЯ", "Найвище виконання свого тижневого плану", m.awards.proryv)}
            {award("☆", "НОВИЙ КЛІЄНТ", "Найбільше перших перевезень з новими", m.awards.clients)}
            {award("⌕", "СНАЙПЕР", "Найкраща конверсія ліда в успіх", m.awards.sniper)}
            {award("🎓", "НОВАЧОК ТИЖНЯ", "Найкращий старт на адаптації", m.awards.rookie)}
          </div>
          {foot("по одному переможцю, щоб не затягувати")}
          {mark}
        </div>
      ) });
    }

    // 7 · Лідогенерація
    if (m.leadgen) {
      const lg = m.leadgen;
      const big = (c: typeof lg.maxDeal, label: string) => (
        <div className="ps-lgcard">
          {c.managerId != null ? ava({ managerId: c.managerId }, c.name ?? "", "ps-lgava") : <div className="ps-lgava ps-ph" />}
          <div><div className="ps-lgl">{label}</div>
            {c.text ? <><div className="ps-lgv">{c.text}{c.manual ? <span className="ps-manual">✎</span> : null}</div>
              <div className="ps-lgn">{c.name}</div></> : <div className="ps-lgn muted">дані не внесено</div>}
          </div>
        </div>
      );
      out.push({ key: "leadgen", node: (
        <div className="ps-slide2">
          {head("ЛІДОГЕНЕРАЦІЯ", "ЛІДЕРИ ЛІДОГЕНЕРАЦІЇ", 1)}
          <div className="ps-lgcards">{big(lg.maxDeal, "РАЗОВИЙ ЗАЗОР")}{big(lg.quotes, "ПРОРАХУНКИ")}</div>
          <div className="ps-also"><i className="ps-cal" />Також: {lg.also}</div>
          {foot()}
          {mark}
        </div>
      ) });
    }

    // 8 · Лідерборд конверсії — рядки, відмічені «на слайд», ▲/▼ проти минулого тижня
    if (m.conv) {
      const trCls = { up: "up", down: "down", same: "none", none: "none" } as const;
      out.push({ key: "conv", node: (
        <div className="ps-slide2 dark">
          {head("СТАТИСТИКА ВІДДІЛУ", "ЛІДЕРБОРД КОНВЕРСІЇ", 2, "red")}
          <div className="ps-lb">
            <div className="ps-lbt">
              <table>
                <thead><tr><th>#</th><th>Менеджер</th><th className="n">Ліди</th><th className="n">Успіх</th><th className="n">Конв.</th><th className="n">Тиждень</th></tr></thead>
                <tbody>{m.conv.rows.length === 0 ? <tr><td colSpan={6} className="muted">Ніхто не відмічений «на слайд» у вкладці</td></tr> : m.conv.rows.map((r) => (
                  <tr key={r.managerId} className={r.n === 1 ? "first" : ""}><td>{r.n}</td><td>{r.name}</td><td className="n">{r.taken}</td><td className="n">{r.won}</td>
                    <td className="n pct">{r.pct}</td><td className="n"><span className={`ps-tr ${trCls[r.dir]}`}>{r.trend}</span></td></tr>
                ))}</tbody>
              </table>
            </div>
            <div className="ps-concl"><i className="ps-msg" /><div className="ps-concl-h">ВИСНОВОК ТИЖНЯ</div>
              <div className="ps-concl-t">{m.conv.comment ?? "Висновок ще не написано — коментар у таблиці конверсії у вкладці."}</div></div>
          </div>
          {foot("конверсія = успіх / цільові ліди")}
          {mark}
        </div>
      ) });
    }

    // 9 · Фокус наступного тижня
    out.push({ key: "focus", node: (
      <div className="ps-slide2 red">
        <div className="ps-uts light">UTS</div>
        <div className="ps-focus-chip">{chip(1)}</div>
        <div className="ps-focus-k">ФОКУС НАСТУПНОГО ТИЖНЯ</div>
        <div className="ps-focus-t">{m.focus ?? "Фокус ще не задано"}</div>
        <div className="ps-focus-bye">ДЯКУЄМО! ДАЛІ ТІЛЬКИ БІЛЬШЕ.</div>
        <div className="ps-focus-s1" /><div className="ps-focus-s2" />
        {mark}
      </div>
    ) });
    return out;
  }, [model, teamPhoto, week.photos, extras?.photos]); // eslint-disable-line react-hooks/exhaustive-deps

  const n = slides.length;
  const go = (k: number) => setI(Math.max(0, Math.min(n - 1, k)));
  /**
   * 📄 ЗАВАНТАЖИТИ PDF (04.11.2026). Усі слайди стосом у корені сторінки (портал), по сторінці 1280×720 на слайд, і системне
   * вікно друку — там «Зберегти як PDF». Без бібліотек: текст лишається текстом, кольори — через print-color-adjust.
   * Друк — лише коли кожна картинка стосу домальована: інакше на сторінці лишались ініціали замість фото.
   */
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    if (!printing) return;
    let alive = true;
    const finish = () => setPrinting(false);
    addEventListener("afterprint", finish);
    const t = setTimeout(async () => {
      const imgs = [...document.querySelectorAll<HTMLImageElement>(".ps-print-root img")];
      await Promise.race([Promise.all(imgs.map((im) => im.decode().catch(() => undefined))), new Promise((ok) => setTimeout(ok, 4000))]);
      await document.fonts.ready;
      if (alive) window.print();
    }, 400);
    return () => { alive = false; clearTimeout(t); removeEventListener("afterprint", finish); };
  }, [printing]);

  /**
   * 📊 ЗАВАНТАЖИТИ PPTX (04.11.2026, «щоб можна було редагувати»). Шаблон Даші з сервера, у ньому тексти й фото
   * замінюються моделлю — тож у PowerPoint / Google Slides відкривається ТОЙ САМИЙ макет із живим текстом.
   */
  const [pptx, setPptx] = useState<"idle" | "busy">("idle");
  const [pptxErr, setPptxErr] = useState<string | null>(null);
  const downloadPptx = async () => {
    setPptx("busy"); setPptxErr(null);
    try {
      const tpl = await unzip(await fetchPptxTemplate());
      const photos = new Map<string, Uint8Array>();
      await Promise.all(photoNeeds(model).map(async (nd) => {
        const url = nd.team ? (week.teamPhoto ? await teamPhotoUrl(week.teamPhoto.v) : null) : await (async () => { const r = refOf(nd); return r ? employeePhotoUrl(r) : null; })();
        const bytes = url ? await squareJpeg(url, nd.team ? 900 : 400) : null;
        if (bytes) photos.set(nd.slot, bytes);
      }));
      const file = zipStore(fillPptx(tpl, model, photos));
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([file.slice()], { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }));
      a.download = `UTS_щотижнева_зустріч_${dmy(model.meeting)}.pptx`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    } catch {
      setPptxErr("Не вдалося зібрати PPTX — спробуйте ще раз");
    } finally {
      setPptx("idle");
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") { e.preventDefault(); setI((c) => Math.min(n - 1, c + 1)); }
      else if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); setI((c) => Math.max(0, c - 1)); }
      else if (e.key === "Home") setI(0);
      else if (e.key === "End") setI(n - 1);
      else if (e.key === "Escape" && !document.fullscreenElement) onClose();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [n, onClose]);

  useLayoutEffect(() => {
    const fit = () => {
      const v = viewport.current;
      if (v) setScale(Math.min(v.clientWidth / 1280, v.clientHeight / 720));
    };
    fit();
    addEventListener("resize", fit);
    document.addEventListener("fullscreenchange", fit);
    return () => { removeEventListener("resize", fit); document.removeEventListener("fullscreenchange", fit); };
  }, []);

  const full = () => { if (document.fullscreenElement) void document.exitFullscreen(); else void overlay.current?.requestFullscreen?.(); };
  const cur = slides[Math.min(i, n - 1)];
  const wait = ready ? undefined : "Зачекайте — презентація ще збирається";

  return (
    <div className="ps-overlay" ref={overlay} role="dialog" aria-label="Презентація щотижневої зустрічі">
      <div className="ps-bar">
        <b>Презентація · тиждень {week.weekFrom.slice(8, 10)}.{week.weekFrom.slice(5, 7)}–{week.weekTo.slice(8, 10)}.{week.weekTo.slice(5, 7)}</b>
        {model.draft ? <span className="ps-draft">Чернетка: тиждень ще не зафіксовано</span> : null}
        {!ready && !err ? (
          <span className="ps-prog" role="status">Готуємо презентацію… {doneN}/{STEPS.length}{pending ? ` · ${pending.label}` : ""}
            <span className="ps-prog-bar"><span style={{ width: `${(doneN / STEPS.length) * 100}%` }} /></span></span>
        ) : null}
        {err || pptxErr ? <span style={{ color: "#fca5a5" }}>{err ?? pptxErr}</span> : null}
        <span className="sp" />
        <button onClick={() => go(i - 1)} aria-label="попередній слайд" disabled={i === 0}>←</button>
        <span>{Math.min(i + 1, n)} / {n}</span>
        <button onClick={() => go(i + 1)} aria-label="наступний слайд" disabled={i >= n - 1}>→</button>
        <button onClick={() => setPrinting(true)} disabled={!ready || printing} title={wait}>{printing ? "Готую PDF…" : "Завантажити PDF"}</button>
        <button onClick={() => void downloadPptx()} disabled={!ready || pptx === "busy"} title={wait}>{pptx === "busy" ? "Готую PPTX…" : "Завантажити PPTX"}</button>
        <button onClick={full}>На весь екран</button>
        <button onClick={onClose}>Закрити</button>
      </div>
      <div className="ps-viewport" ref={viewport} onClick={(e) => { if (e.target === viewport.current) go(i + 1); }}>
        <div className="ps-stage" style={{ transform: `translate(-50%, -50%) scale(${scale})` }}>{cur?.node}</div>
      </div>
      {printing ? createPortal(<div className="ps-print-root">{slides.map((sl) => <div className="ps-print-page" key={sl.key}>{sl.node}</div>)}</div>, document.body) : null}
    </div>
  );
}


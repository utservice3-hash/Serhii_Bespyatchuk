import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  fetchReportPlan, fetchPresentationExtras, teamPhotoUrl,
  type NominationWeek, type NominationKey, type NominationTopRow, type ReportPlan, type PresentationExtras,
} from "../../../api";
import { EmployeePhoto } from "./EmployeePhotos";
import { formatAmountFull } from "../format";
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
 */

const MONTHS = ["січень", "лютий", "березень", "квітень", "травень", "червень", "липень", "серпень", "вересень", "жовтень", "листопад", "грудень"];
const kyivToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
const dmy = (ymd: string) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}.${ymd.slice(0, 4)}`;
const monthEnd = (ymd: string) => {
  const d = new Date(`${ymd.slice(0, 7)}-01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1, 0);
  return d.toISOString().slice(0, 10);
};
const short = (n: string) => n.split(/\s+/).slice(0, 2).join(" ");
const num = (v: number) => Math.round(v).toLocaleString("uk-UA").replace(/ | /g, " ");
/** «1 рейс · 2 рейси · 5 рейсів» — як у макеті. */
const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};
const valueText = (k: NominationKey, v: number): string =>
  k === "cars" ? `${v} авто` : k === "intl" ? `${v} ${plural(v, "рейс", "рейси", "рейсів")}` : formatAmountFull(v);
const pctText = (v: number | null) => (v == null ? "—" : `${Math.round(v)}%`);
/** Шрифти макета (Oswald — заголовки, Rubik — текст). Не в збірці свідомо: файл шрифту, на який посилається лише CSS,
 *  процедура викату видалила б (вона прибирає з докрута все, чого немає в `index.html`). Без інтернету — системний. */
const FONTS = "https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=Rubik:wght@400;500;600;700&display=swap";

export function NominationsPresentation({ week, onClose }: { week: NominationWeek; onClose: () => void }) {
  const [month, setMonth] = useState<ReportPlan | null>(null);
  const [weekRep, setWeekRep] = useState<ReportPlan | null>(null);
  const [extras, setExtras] = useState<PresentationExtras | null>(null);
  const [teamPhoto, setTeamPhoto] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [i, setI] = useState(0);
  const [scale, setScale] = useState(1);
  const overlay = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const today = kyivToday();
  const mStart = `${today.slice(0, 7)}-01`;

  useEffect(() => {
    if (document.querySelector(`link[href="${FONTS}"]`)) return;
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.href = FONTS;
    document.head.appendChild(l);
  }, []);
  useEffect(() => {
    fetchReportPlan({ from: mStart, to: monthEnd(today) }).then(setMonth)
      .catch(() => setErr("Не вдалося завантажити пульс плану — спробуйте ще раз"));
  }, [mStart, today]);
  useEffect(() => {
    Promise.all([fetchReportPlan({ from: week.weekFrom, to: week.weekTo }), fetchPresentationExtras(week.weekFrom)])
      .then(([r, x]) => { setWeekRep(r); setExtras(x); })
      .catch(() => setErr("Не вдалося завантажити події тижня й відзнаки — спробуйте ще раз"));
  }, [week.weekFrom, week.weekTo]);
  useEffect(() => {
    let alive = true;
    if (week.teamPhoto) void teamPhotoUrl(week.teamPhoto.v).then((u) => { if (alive) setTeamPhoto(u); });
    return () => { alive = false; };
  }, [week.teamPhoto?.v]);

  const draft = week.state !== "frozen";
  const meeting = week.freezeDueAt.slice(0, 10);
  const name = useCallback((id: number) => week.names[String(id)] ?? `Менеджер #${id}`, [week.names]);

  const slides = useMemo(() => {
    const out: { key: string; node: ReactElement }[] = [];
    const mark = draft ? <div className="ps-watermark">ЧЕРНЕТКА · тиждень ще не зафіксовано</div> : null;
    const foot = (extra?: string) => <div className="ps-foot">UTS • Комерційний відділ • {dmy(meeting)}{extra ? ` • ${extra}` : ""}</div>;
    const chip = (min: number, tone: "dark" | "red" = "dark") => <div className={`ps-chip ${tone}`}><i className="ps-clock" />{min} хв</div>;
    const ava = (id: number, cls: string, who?: string) => <EmployeePhoto key={id} photo={week.photos?.[String(id)]} name={who ?? name(id)} className={cls} />;
    const head = (kick: string, title: string, min: number, tone: "dark" | "red" = "dark") => (
      <div className="ps-head2"><div><div className="ps-kick2">{kick}</div><h2 className="ps-h2">{title}</h2></div>{chip(min, tone)}</div>
    );

    // 1 · Титул
    out.push({ key: "title", node: (
      <div className="ps-slide2 ps-cover">
        <div className="ps-cover-l">
          <div className="ps-uts">UTS</div>
          <h1 className="ps-cover-h">ЩОТИЖНЕВА<br />ЗУСТРІЧ</h1>
          <div className="ps-cover-sub">Комерційний відділ • {dmy(meeting)}</div>
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
    const empAva = (id: number, name0: string, cls: string) => <EmployeePhoto key={id} photo={extras?.photos?.[String(id)]} name={name0} className={cls} />;
    if (extras) {
      const ev = [
        ...extras.birthdays.map((b) => ({ k: `b${b.employeeId}`, id: b.employeeId, name: b.name, tone: "red", tag: "ДЕНЬ НАРОДЖЕННЯ",
          text: `${b.date.slice(8, 10)}.${b.date.slice(5, 7)} • Бажаємо енергії та нових рекордів!` })),
        ...extras.newcomers.map((x) => ({ k: `n${x.employeeId}`, id: x.employeeId, name: x.name, tone: "dark", tag: "НОВИЙ У КОМАНДІ",
          text: x.cars ? `Уже ${x.cars} ${plural(x.cars, "поставлене авто", "поставлені авто", "поставлених авто")} на адаптації` : "Вітаємо в команді!" })),
        ...extras.newPositions.map((x) => ({ k: `p${x.employeeId}`, id: x.employeeId, name: x.name, tone: "gold", tag: "НОВА ПОСАДА",
          text: `${x.position} • Пишаємося твоїм розвитком!` })),
      ];
      if (ev.length) out.push({ key: "events", node: (
        <div className="ps-slide2">
          {head("КОМАНДА", "ПОДІЇ ТИЖНЯ", 2)}
          <div className={`ps-evs${ev.length > 3 ? " many" : ""}`}>
            {ev.slice(0, 6).map((e) => (
              <div className={`ps-ev ${e.tone}`} key={e.k}>
                {empAva(e.id, e.name, "ps-evava")}
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
    }

    // 3 · Пульс плану — верх Звіту за поточний місяць
    if (month) {
      const g = month.glance;
      const pct = g.plan > 0 ? Math.round((g.fact / g.plan) * 100) : null;
      out.push({ key: "pulse", node: (
        <div className="ps-slide2 dark">
          {head(`${MONTHS[Number(today.slice(5, 7)) - 1].toUpperCase()} ${today.slice(0, 4)}`, "ПУЛЬС ПЛАНУ", 1, "red")}
          <div className="ps-pulse"><div className="ps-pulse-n">{pct == null ? "—" : `${pct}%`}</div><div className="ps-pulse-t">плану виконано<br />за місяць</div></div>
          <div className="ps-bar2"><span style={{ width: `${Math.min(100, pct ?? 0)}%` }} /></div>
          <div className="ps-pcards">
            <div className="ps-pcard"><div className="l">ФАКТ / ПЛАН</div><div className="v">{num(g.fact)} / {num(g.plan)} ₴</div></div>
            <div className="ps-pcard"><div className="l">ЗАЛИШИЛОСЬ ДО ПЛАНУ</div><div className="v">{g.plan > g.fact ? `${num(g.plan - g.fact)} ₴` : "план виконано"}</div></div>
            <div className="ps-pcard"><div className="l">ОЧІКУЄМО ЗА ПЛАН. ДАТОЮ</div><div className="v">{num(g.expectThisMonth)} ₴</div></div>
          </div>
          {foot()}
          {mark}
        </div>
      ) });
    }

    // 4–5 · Топ-3 на весь відділ
    const topCol = (k: NominationKey, title: string) => {
      const rows: NominationTopRow[] = week.companyTop?.[k] ?? [];
      const shown = rows.slice(0, 5);
      return (
        <div className="ps-tcol">
          <div className="ps-tcol-h">{title}</div>
          {shown.length === 0 ? <div className="ps-trow empty">ніхто не набрав</div> : shown.map((r) => (
            <div className={`ps-trow p${Math.min(r.place, 3)}`} key={`${r.managerId}`}>
              <div className="ps-place">{r.place}</div>
              {ava(r.managerId, "ps-tava")}
              <div className="ps-tinfo"><div className="ps-tname">{short(name(r.managerId))}</div>
                <div className={`ps-tval${r.place === 1 ? " first" : ""}`}>{valueText(k, r.value)}{r.manual ? <span className="ps-manual">✎</span> : null}</div></div>
            </div>
          ))}
          {rows.length > shown.length ? <div className="ps-more">ще {rows.length - shown.length} з тим самим результатом</div> : null}
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
    if (extras && weekRep) {
      const best = <T,>(xs: T[], val: (x: T) => number | null): T[] => {
        const ok = xs.filter((x) => (val(x) ?? 0) > 0);
        const m = Math.max(...ok.map((x) => val(x)!), -Infinity);
        return ok.filter((x) => val(x) === m);
      };
      const proryv = best(weekRep.managers.filter((m) => m.plan > 0), (m) => m.pct);
      const clients = best(extras.newClients.rows, (r) => r.first);
      const sniper = best((week.rnkConv?.rows ?? []).filter((r) => r.onSlide), (r) => r.pct);
      const rookie = best(extras.rookies, (r) => r.cars);
      const award = (icon: string, title: string, sub: string, names: string[], photo: ReactElement | null, value: string | null) => (
        <div className="ps-aw">
          <div className="ps-aw-i">{icon}</div>
          <div className="ps-aw-t">{title}</div>
          <div className="ps-aw-s">{sub}</div>
          <div className="ps-aw-ph">{photo ?? <div className="ps-aw-none" />}</div>
          <div className="ps-aw-n">{names.length ? names.map(short).join(", ") : "немає претендентів"}</div>
          {value ? <div className="ps-aw-v">{value}</div> : null}
        </div>
      );
      out.push({ key: "awards", node: (
        <div className="ps-slide2 warm">
          {head("НОВІ НОМІНАЦІЇ", "ОСОБЛИВІ ВІДЗНАКИ", 3)}
          <div className="ps-aws">
            {award("⚡", "ПРОРИВ ТИЖНЯ", "Найвище виконання свого тижневого плану", proryv.map((m) => m.name),
              proryv[0] ? ava(proryv[0].managerId, "ps-awava", proryv[0].name) : null, proryv[0] ? `${Math.round(proryv[0].pct!)}% плану` : null)}
            {award("☆", "НОВИЙ КЛІЄНТ", "Найбільше перших перевезень з новими", clients.map((r) => name(r.managerId)),
              clients[0] ? ava(clients[0].managerId, "ps-awava") : null, clients[0] ? `${clients[0].first} ${plural(clients[0].first, "клієнт", "клієнти", "клієнтів")}` : null)}
            {award("⌕", "СНАЙПЕР", "Найкраща конверсія ліда в успіх", sniper.map((r) => r.name),
              sniper[0] ? ava(sniper[0].managerId, "ps-awava", sniper[0].name) : null, sniper[0] ? `${pctText(sniper[0].pct)} конверсія` : null)}
            {award("🎓", "НОВАЧОК ТИЖНЯ", "Найкращий старт на адаптації", rookie.map((r) => r.name),
              rookie[0] ? empAva(rookie[0].employeeId, rookie[0].name, "ps-awava") : null, rookie[0] ? `${rookie[0].cars} авто` : null)}
          </div>
          {foot("по одному переможцю, щоб не затягувати")}
          {mark}
        </div>
      ) });
    }

    // 7 · Лідогенерація
    if (week.leadgen) {
      const lg = week.leadgen;
      const cell = (k: NominationKey) => lg.cells.find((c) => c.nomination === k)?.final;
      const lgName = (id: number) => lg.members.find((m) => m.id === id)?.name ?? name(id);
      const big = (k: NominationKey, label: string) => {
        const f = cell(k);
        const ok = !!f && f.status !== "empty" && f.winners.length > 0;
        return (
          <div className="ps-lgcard">
            {ok ? ava(f!.winners[0], "ps-lgava", lgName(f!.winners[0])) : <div className="ps-lgava ps-ph" />}
            <div><div className="ps-lgl">{label}</div>
              {ok ? <><div className="ps-lgv">{k === "lgQuotes" ? String(f!.value) : formatAmountFull(f!.value ?? 0)}{f!.status === "overridden" ? <span className="ps-manual">✎</span> : null}</div>
                <div className="ps-lgn">{f!.winners.map((id) => short(lgName(id))).join(", ")}</div></> : <div className="ps-lgn muted">дані не внесено</div>}
            </div>
          </div>
        );
      };
      const also = (["lgCars", "lgIntl"] as const).map((k) => {
        const f = cell(k);
        const label = k === "lgCars" ? "поставлені авто" : "міжнародні";
        return f && f.status !== "empty" && f.winners.length ? <span key={k}><b>{f.winners.map((id) => short(lgName(id))).join(", ")}</b> — {f.value} {label}</span> : <span key={k}>{label} — дані не внесено</span>;
      });
      out.push({ key: "leadgen", node: (
        <div className="ps-slide2">
          {head("ЛІДОГЕНЕРАЦІЯ", "ЛІДЕРИ ЛІДОГЕНЕРАЦІЇ", 1)}
          <div className="ps-lgcards">{big("lgMaxDeal", "РАЗОВИЙ ЗАЗОР")}{big("lgQuotes", "ПРОРАХУНКИ")}</div>
          <div className="ps-also"><i className="ps-cal" />Також: {also.map((x, n) => <span key={n}>{n ? " • " : ""}{x}</span>)}</div>
          {foot()}
          {mark}
        </div>
      ) });
    }

    // 8 · Лідерборд конверсії — рядки, відмічені «на слайд», ▲/▼ проти минулого тижня
    if (week.rnkConv) {
      const rows = week.rnkConv.rows.filter((r) => r.onSlide).sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || b.taken - a.taken).slice(0, 8);
      const trend = (now: number | null, prev: number | null) => {
        if (now == null || prev == null) return <span className="ps-tr none">—</span>;
        const d = Math.round(now - prev);
        return d > 0 ? <span className="ps-tr up">▲ {d}</span> : d < 0 ? <span className="ps-tr down">▼ {-d}</span> : <span className="ps-tr none">=</span>;
      };
      out.push({ key: "conv", node: (
        <div className="ps-slide2 dark">
          {head("СТАТИСТИКА ВІДДІЛУ", "ЛІДЕРБОРД КОНВЕРСІЇ", 2, "red")}
          <div className="ps-lb">
            <div className="ps-lbt">
              <table>
                <thead><tr><th>#</th><th>Менеджер</th><th className="n">Ліди</th><th className="n">Успіх</th><th className="n">Конв.</th><th className="n">Тиждень</th></tr></thead>
                <tbody>{rows.length === 0 ? <tr><td colSpan={6} className="muted">Ніхто не відмічений «на слайд» у вкладці</td></tr> : rows.map((r, n) => (
                  <tr key={r.managerId} className={n === 0 ? "first" : ""}><td>{n + 1}</td><td>{short(r.name)}</td><td className="n">{r.taken}</td><td className="n">{r.won}</td>
                    <td className="n pct">{pctText(r.pct)}</td><td className="n">{trend(r.pct, r.prevPct)}</td></tr>
                ))}</tbody>
              </table>
            </div>
            <div className="ps-concl"><i className="ps-msg" /><div className="ps-concl-h">ВИСНОВОК ТИЖНЯ</div>
              <div className="ps-concl-t">{week.rnkConv.comment?.text ?? "Висновок ще не написано — коментар у таблиці конверсії у вкладці."}</div></div>
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
        <div className="ps-focus-t">{week.texts?.focus?.text || "Фокус ще не задано"}</div>
        <div className="ps-focus-bye">ДЯКУЄМО! ДАЛІ ТІЛЬКИ БІЛЬШЕ.</div>
        <div className="ps-focus-s1" /><div className="ps-focus-s2" />
        {mark}
      </div>
    ) });
    return out;
  }, [week, month, weekRep, extras, teamPhoto, draft, meeting, name, today]);

  const n = slides.length;
  const go = (k: number) => setI(Math.max(0, Math.min(n - 1, k)));

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

  return (
    <div className="ps-overlay" ref={overlay} role="dialog" aria-label="Презентація щотижневої зустрічі">
      <div className="ps-bar">
        <b>Презентація · тиждень {week.weekFrom.slice(8, 10)}.{week.weekFrom.slice(5, 7)}–{week.weekTo.slice(8, 10)}.{week.weekTo.slice(5, 7)}</b>
        {draft ? <span className="ps-draft">Чернетка: тиждень ще не зафіксовано</span> : null}
        {err ? <span style={{ color: "#fca5a5" }}>{err}</span> : null}
        <span className="sp" />
        <button onClick={() => go(i - 1)} aria-label="попередній слайд" disabled={i === 0}>←</button>
        <span>{Math.min(i + 1, n)} / {n}</span>
        <button onClick={() => go(i + 1)} aria-label="наступний слайд" disabled={i >= n - 1}>→</button>
        <button onClick={full}>На весь екран</button>
        <button onClick={onClose}>Закрити</button>
      </div>
      <div className="ps-viewport" ref={viewport} onClick={(e) => { if (e.target === viewport.current) go(i + 1); }}>
        <div className="ps-stage" style={{ transform: `translate(-50%, -50%) scale(${scale})` }}>{cur?.node}</div>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { fetchAiCalls, type AiCallsResp } from "../../../api";
import { InfoHint } from "../widgets";
import { addDays, ddmm, mondayOf, todayKyiv } from "../periodRules";
import { reviewByTeam, reviewPct, reviewWeekWindow, type ReviewCount } from "../aiCallsView";
import "./firstTouch.css";

/**
 * 📋 РОЗБІР ПО КОМАНДАХ (задача 7238, ТЗ Юлі 28.10.2026, задача 1 п.1): «треба розібрати / розібрано» по кожній команді за
 * кожен день і за тиждень пн–нд — на екрані «Перший дотик · AI» і в Звіті КВП. Один компонент на обидва місця: власний
 * тиждень зі стрілками, власний запит `/ai-calls` (скоуп ролі — серверний), числа — `reviewByTeam` з `aiCallsView`.
 * День — за датою розмови (рішення Романа 04.11.2026). «Дійшла до рахунку» — окремою колонкою (Роман 04.11.2026: «так»).
 */
const WD = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];
const HINT = "«Треба» — розмови з позначкою в колонці «Розбір» (немає дзвінка, без ціни, втрачений лід, запізнився). "
  + "«Розібрано» — тімлід поставив «Розібрано» чи «Опрацьовано» (з 04.11 — лише після коментаря менеджера). "
  + "«До рахунку» — угода дійшла до «Виставлення рахунку» сама, розбирати не треба; у відсоток не входить. "
  + "«Лишилось» — ще в черзі. День — за датою розмови. У клітинці дня: розібрано / треба (без «до рахунку»).";

/** `anchor` — день, чий тиждень показати першим (Звіт КВП — кінець свого періоду; майбутнє — сьогодні). `refresh` — після розбору
 * на екрані: перечитує тиждень на місці, без «Завантаження…». */
export function ReviewByTeamBlock({ variant, anchor, refresh = 0 }: { variant: "ftd" | "kvp"; anchor?: string; refresh?: number }) {
  const today = todayKyiv();
  const [monday, setMonday] = useState(() => mondayOf(anchor && anchor < today ? anchor : today));
  useEffect(() => { if (anchor) setMonday(mondayOf(anchor < today ? anchor : today)); }, [anchor, today]);
  const [d, setD] = useState<{ monday: string; data: AiCallsResp } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true; setErr(null);
    fetchAiCalls(reviewWeekWindow(monday)).then((x) => { if (alive) setD({ monday, data: x }); })
      .catch(() => { if (alive) setErr("Не вдалося завантажити розбір по командах."); });
    return () => { alive = false; };
  }, [monday, refresh]);
  // Числа іншого тижня не показуємо навіть на мить: поки новий тиждень вантажиться — «Завантаження…».
  const rep = useMemo(() => (d && d.monday === monday ? reviewByTeam(d.data.rows, monday) : null), [d, monday]);

  const kvp = variant === "kvp";
  const nav = (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 13 }}>
      <button type="button" className="ftd-pill" onClick={() => setMonday(addDays(monday, -7))} aria-label="Попередній тиждень">‹</button>
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{ddmm(monday)}–{ddmm(addDays(monday, 6))}</span>
      <button type="button" className="ftd-pill" disabled={addDays(monday, 7) > today} onClick={() => setMonday(addDays(monday, 7))} aria-label="Наступний тиждень">›</button>
    </span>
  );
  const head = (
    <div className="ftd-card-h">
      <h2 className={kvp ? "chart-title" : undefined} style={kvp ? { margin: 0 } : undefined}>📋 Розбір по командах<InfoHint text={HINT} /></h2>
      {nav}
    </div>
  );
  const box = (body: React.ReactNode) => (
    <section aria-label="Розбір по командах" className={kvp ? "chart-card" : "ftd-card ftd-card-pad"}>{head}{body}</section>
  );
  if (err) return box(<p style={{ margin: 0, color: "var(--danger, #c8102e)" }}>{err}</p>);
  if (!rep) return box(<p className="loading-text" style={{ margin: 0 }}>Завантаження…</p>);
  if (!rep.total.week.due) return box(<p className="ftd-sub" style={{ margin: 0 }}>За цей тиждень розмов, які треба розібрати, немає.</p>);

  const dayCell = (c: ReviewCount, day: string) => {
    if (day > today) return <td key={day} className="ftd-sub" style={{ textAlign: "center" }}>·</td>;
    const of = c.reviewed + c.left;
    const tip = `треба ${String(c.due)} · розібрано ${String(c.reviewed)} · до рахунку ${String(c.invoice)} · лишилось ${String(c.left)}`;
    return (
      <td key={day} title={tip} style={{ textAlign: "center", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap",
        color: !c.due ? "var(--text-muted)" : c.left ? "var(--danger, #b91c1c)" : "var(--ok, #166534)" }}>
        {c.due ? `${String(c.reviewed)} / ${String(of)}` : "—"}
      </td>
    );
  };
  const num = (v: number, tone?: string) => <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: tone }}>{v}</td>;
  const row = (l: typeof rep.total, strong = false) => (
    <tr key={l.teamId ?? (strong ? "total" : "none")} style={strong ? { fontWeight: 700 } : undefined}>
      <td style={{ whiteSpace: "nowrap" }}>{l.teamName}</td>
      {l.days.map((c, i) => dayCell(c, rep.days[i]))}
      {num(l.week.due)}
      {num(l.week.reviewed, "var(--ok, #166534)")}
      {num(l.week.invoice)}
      {num(l.week.left, l.week.left ? "var(--danger, #b91c1c)" : undefined)}
      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{l.pct == null ? "—" : `${String(l.pct)}%`}</td>
    </tr>
  );
  return box(
    <div style={{ overflowX: "auto" }}>
      <table className={kvp ? "data-table" : "ftd-table"} style={{ minWidth: 820 }}>
        <thead>
          <tr>
            <th>Команда</th>
            {rep.days.map((day, i) => <th key={day} style={{ textAlign: "center" }}>{WD[i]} {ddmm(day)}</th>)}
            <th style={{ textAlign: "right" }}>Треба</th><th style={{ textAlign: "right" }}>Розібрано</th>
            <th style={{ textAlign: "right" }}>До рахунку</th><th style={{ textAlign: "right" }}>Лишилось</th>
            <th style={{ textAlign: "right" }}>% розібрано</th>
          </tr>
        </thead>
        <tbody>
          {rep.teams.map((t) => row(t))}
          {rep.teams.length > 1 && row(rep.total, true)}
        </tbody>
      </table>
      {reviewPct(rep.total.week) == null && <p className="ftd-sub" style={{ margin: "6px 0 0" }}>Усі розмови тижня дійшли до рахунку — розбирати нічого.</p>}
    </div>
  );
}

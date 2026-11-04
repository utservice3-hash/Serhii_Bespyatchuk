/**
 * 🎞 МОДЕЛЬ СЛАЙДІВ ПРЕЗЕНТАЦІЇ (04.11.2026) — ОДНА на екран і на PPTX. Жодного імпорту під час виконання: гейт #3468
 * транспілює цей файл і ВИКОНУЄ його. Слайди (`NominationsPresentation.tsx`) і PPTX (`pptxTemplate.ts`) малюють рівно
 * цю модель — тож число на слайді й у файлі розійтися не можуть.
 *
 * Звідки числа: «Пульс плану» — верх Звіту за поточний місяць (`glance`); топ-3 — `companyTop` сервера; «Прорив» —
 * «Виконано %» Звіту за тиждень; решта — `/nominations/week` і `/nominations/presentation-extras`.
 */
import type { NominationWeek, NominationKey, ReportPlan, PresentationExtras } from "../../api";

const MONTHS = ["січень", "лютий", "березень", "квітень", "травень", "червень", "липень", "серпень", "вересень", "жовтень", "листопад", "грудень"];
export const dmy = (ymd: string) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}.${ymd.slice(0, 4)}`;
export const short = (n: string) => n.split(/\s+/).slice(0, 2).join(" ");
export const num = (v: number) => Math.round(v).toLocaleString("uk-UA").replace(/[  ]/g, " ");
export const money = (v: number) => `${num(v)} ₴`;
/** «1 рейс · 2 рейси · 5 рейсів». */
export const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};
export const valueText = (k: NominationKey, v: number): string =>
  k === "cars" ? `${v} авто` : k === "intl" ? `${v} ${plural(v, "рейс", "рейси", "рейсів")}` : money(v);
export const pctText = (v: number | null) => (v == null ? "—" : `${Math.round(v)}%`);

export type TopKey = "maxDeal" | "revenue" | "cars" | "intl";
export interface TopRowM { place: number; managerId: number; name: string; value: number; text: string; manual: boolean }
export interface AwardM { names: string[]; managerId: number | null; employeeId: number | null; value: string | null }
export interface EventM { kind: "birthday" | "newcomer" | "position"; employeeId: number; name: string; tag: string; text: string }
export interface PresModel {
  meeting: string; weekFrom: string; weekTo: string; draft: boolean;
  events: EventM[] | null;
  pulse: { monthLabel: string; pct: number | null; fact: number; plan: number; left: number | null; expect: number } | null;
  tops: Record<TopKey, { rows: TopRowM[]; tied: string[] }>;
  awards: { proryv: AwardM; clients: AwardM; sniper: AwardM; rookie: AwardM } | null;
  leadgen: { maxDeal: { name: string | null; managerId: number | null; text: string | null; manual: boolean };
    quotes: { name: string | null; managerId: number | null; text: string | null; manual: boolean }; also: string } | null;
  conv: { rows: { n: number; managerId: number; name: string; taken: number; won: number; pct: string; trend: string; dir: "up" | "down" | "same" | "none" }[];
    comment: string | null } | null;
  focus: string | null;
}

/** Хто переміг за значенням `val` (> 0); нічия — усі. */
function best<T>(xs: readonly T[], val: (x: T) => number | null): T[] {
  const ok = xs.filter((x) => (val(x) ?? 0) > 0);
  if (!ok.length) return [];
  const m = Math.max(...ok.map((x) => val(x)!));
  return ok.filter((x) => val(x) === m);
}

export function buildPresentationModel(p: { week: NominationWeek; month: ReportPlan | null; weekRep: ReportPlan | null; extras: PresentationExtras | null; today: string }): PresModel {
  const { week, month, weekRep, extras, today } = p;
  const name = (id: number) => week.names[String(id)] ?? `Менеджер #${id}`;

  // Події тижня — з «Найму» (ДР, 14 днів від прийому) і «Нова посада» від Даші.
  const events: EventM[] | null = extras ? [
    ...extras.birthdays.map((b) => ({ kind: "birthday" as const, employeeId: b.employeeId, name: b.name, tag: "ДЕНЬ НАРОДЖЕННЯ",
      text: `${b.date.slice(8, 10)}.${b.date.slice(5, 7)} • Бажаємо енергії та нових рекордів!` })),
    ...extras.newcomers.map((x) => ({ kind: "newcomer" as const, employeeId: x.employeeId, name: x.name, tag: "НОВИЙ У КОМАНДІ",
      text: x.cars ? `Уже ${x.cars} ${plural(x.cars, "поставлене авто", "поставлені авто", "поставлених авто")} на адаптації` : "Вітаємо в команді!" })),
    ...extras.newPositions.map((x) => ({ kind: "position" as const, employeeId: x.employeeId, name: x.name, tag: "НОВА ПОСАДА",
      text: `${x.position} • Пишаємося твоїм розвитком!` })),
  ] : null;

  const g = month?.glance;
  const pulse = g ? {
    monthLabel: `${MONTHS[Number(today.slice(5, 7)) - 1].toUpperCase()} ${today.slice(0, 4)}`,
    pct: g.plan > 0 ? Math.round((g.fact / g.plan) * 100) : null,
    fact: g.fact, plan: g.plan, left: g.plan > g.fact ? g.plan - g.fact : null, expect: g.expectThisMonth,
  } : null;

  // Топ-3: три рядки; хто ділить місце з третім рядком — окремим списком (ревʼю 04.11.2026).
  const top = (k: TopKey) => {
    const all = week.companyTop?.[k] ?? [];
    const rows = all.slice(0, 3).map((r) => ({ place: r.place, managerId: r.managerId, name: short(name(r.managerId)), value: r.value, text: valueText(k, r.value), manual: r.manual }));
    const tied = rows.length === 3 ? all.slice(3).filter((r) => r.place === rows[2].place).map((r) => short(name(r.managerId))) : [];
    return { rows, tied };
  };
  const tops = { maxDeal: top("maxDeal"), revenue: top("revenue"), cars: top("cars"), intl: top("intl") };

  let awards: PresModel["awards"] = null;
  if (extras && weekRep) {
    // Люди на адаптації (перший місяць) у «Прорив» не йдуть: план тижня новачка крихітний («2664%»).
    const adapting = new Set(extras.adaptingManagerIds ?? []);
    const pr = best(weekRep.managers.filter((m) => m.plan > 0 && !adapting.has(m.managerId)), (m) => m.pct);
    const cl = best(extras.newClients.rows, (r) => r.first);
    const sn = best((week.rnkConv?.rows ?? []).filter((r) => r.onSlide), (r) => r.pct);
    const rk = best(extras.rookies, (r) => r.cars);
    awards = {
      proryv: { names: pr.map((m) => m.name), managerId: pr[0]?.managerId ?? null, employeeId: null, value: pr[0] ? `${Math.round(pr[0].pct!)}% плану` : null },
      clients: { names: cl.map((r) => name(r.managerId)), managerId: cl[0]?.managerId ?? null, employeeId: null,
        value: cl[0] ? `${cl[0].first} ${plural(cl[0].first, "клієнт", "клієнти", "клієнтів")}` : null },
      sniper: { names: sn.map((r) => r.name), managerId: sn[0]?.managerId ?? null, employeeId: null, value: sn[0] ? `${pctText(sn[0].pct)} конверсія` : null },
      rookie: { names: rk.map((r) => r.name), managerId: rk[0]?.managerId ?? null, employeeId: rk[0]?.employeeId ?? null, value: rk[0] ? `${rk[0].cars} авто` : null },
    };
  }

  let leadgen: PresModel["leadgen"] = null;
  if (week.leadgen) {
    const lg = week.leadgen;
    const lgName = (id: number) => lg.members.find((m) => m.id === id)?.name ?? name(id);
    const cell = (k: NominationKey) => lg.cells.find((c) => c.nomination === k)?.final;
    const card = (k: NominationKey, fmt: (v: number) => string) => {
      const f = cell(k);
      const ok = !!f && f.status !== "empty" && f.winners.length > 0;
      return { name: ok ? f!.winners.map((id) => short(lgName(id))).join(", ") : null, managerId: ok ? f!.winners[0] : null,
        text: ok ? fmt(f!.value ?? 0) : null, manual: ok && f!.status === "overridden" };
    };
    const alsoOf = (k: NominationKey, label: string) => {
      const f = cell(k);
      return f && f.status !== "empty" && f.winners.length ? `${f.winners.map((id) => short(lgName(id))).join(", ")} — ${f.value} ${label}` : `${label} — дані не внесено`;
    };
    leadgen = { maxDeal: card("lgMaxDeal", money), quotes: card("lgQuotes", (v) => String(v)), also: `${alsoOf("lgCars", "поставлені авто")} • ${alsoOf("lgIntl", "міжнародні")}` };
  }

  let conv: PresModel["conv"] = null;
  if (week.rnkConv) {
    const rows = week.rnkConv.rows.filter((r) => r.onSlide).sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || b.taken - a.taken).slice(0, 8);
    conv = {
      rows: rows.map((r, i) => {
        const d = r.pct == null || r.prevPct == null ? null : Math.round(r.pct - r.prevPct);
        return { n: i + 1, managerId: r.managerId, name: short(r.name), taken: r.taken, won: r.won, pct: pctText(r.pct),
          trend: d == null ? "—" : d > 0 ? `▲ ${d} п.п.` : d < 0 ? `▼ ${-d} п.п.` : "=",
          dir: d == null ? "none" as const : d > 0 ? "up" as const : d < 0 ? "down" as const : "same" as const };
      }),
      comment: week.rnkConv.comment?.text ?? null,
    };
  }

  return {
    meeting: week.freezeDueAt.slice(0, 10), weekFrom: week.weekFrom, weekTo: week.weekTo, draft: week.state !== "frozen",
    events, pulse, tops, awards, leadgen, conv, focus: week.texts?.focus?.text || null,
  };
}

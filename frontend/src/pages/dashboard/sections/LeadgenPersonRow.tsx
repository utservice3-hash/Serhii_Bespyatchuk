import type { LeadgenPersonRow as Row, LeadgenBucket, LeadgenGrain, LeadgenHandoffMoney } from "../../../api";
import { formatAmount } from "../format";
import { Donut } from "./ReportPlanSection";
import { ddmm, addDays, dow, mondayOf } from "../periodRules";
import { LeadgenMoneyDetails } from "./LeadgenMoneyDetails";

const GREEN = "#16a34a", AMBER = "#d97706", RED = "#dc2626", MUTED = "var(--text-muted)";
const WD = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];

/** Відсоток з одним знаком після коми, як пишуть люди: «14,9 %». */
export const pct1 = (v: number) => `${v.toLocaleString("uk-UA", { maximumFractionDigits: 1 })} %`;
const ratio = (num: number, den: number): number | null => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);
const n = (v: number) => v.toLocaleString("uk-UA");

/**
 * 🟢 СТАТУС КОНВЕРСІЇ «ЛІДИ → ОПР» — ОДНА ФУНКЦІЯ ДЛЯ КІЛЬЦЯ, СМУГИ Й ПІЛЮЛЬ.
 * Пороги ті самі, що в кільця Звіту (≥100 % цілі — зелений, ≥70 % — жовтий, нижче —
 * червоний), і рахуються від ТОГО САМОГО округленого числа, що на кільці: раніше пілюлі
 * брали неокруглене, і людина з кільцем «100 %» ішла в «близько».
 *   • без лідів — статусу немає (0 з 0 — «нема з чого рахувати», а не провал);
 *   • ОПР більше за лідів — статусу немає: конверсії понад 100 % у воронці не буває,
 *     це межа вікна або зміна процесу (вересень 2026: 101 лід проти 262 ОПР);
 *   • короткий період (< 4 тижнів) — статусу немає: ОПР тижня здебільшого з лідів,
 *     узятих раніше, тож «конверсія» дня чи тижня — шум, а не оцінка людини.
 */
export function convStatus(opr: number, leads: number, target: number, statusful: boolean) {
  const conv = ratio(opr, leads);
  const overfull = conv != null && conv > 100;
  const ofTarget = conv == null || overfull ? null : Math.round((conv / target) * 100);
  const level: "g" | "a" | "r" | null = !statusful || ofTarget == null ? null : ofTarget >= 100 ? "g" : ofTarget >= 70 ? "a" : "r";
  const color = level === "g" ? GREEN : level === "a" ? AMBER : level === "r" ? RED : "var(--border)";
  return { conv, overfull, ofTarget, level, color };
}

/** Кільце: кольорове — коли статус є (кільце Звіту); сіре з числом — коли статусу немає. */
export function StatusRing({ st, target, title }: { st: ReturnType<typeof convStatus>; target: number; title?: string }) {
  if (st.level && st.ofTarget != null) return <Donut pct={st.ofTarget} title={title ?? `Ліди → ОПР ${pct1(st.conv!)} — це ${st.ofTarget} % від цілі ${target} %`} />;
  return (
    <span title={title} style={{ width: 58, height: 58, borderRadius: "50%", border: "8px solid var(--border)", boxSizing: "border-box", flex: "none",
      display: "grid", placeItems: "center", fontSize: 11, fontWeight: 700, color: MUTED }}>
      {st.ofTarget != null ? `${st.ofTarget}%` : "—"}
    </span>
  );
}

/**
 * 📅 ОДИНИЦІ РОЗБИВКИ — З КАЛЕНДАРЯ, А НЕ З ДАНИХ. Бекенд віддає лише бакети, де були
 * дії; день чи тиждень без жодної дії інакше просто зник би з таблиці, і «у вівторок
 * нуль» читалося б як «вівторка в періоді немає». Тому список будуємо за календарем
 * (до сьогодні включно) і підставляємо нулі.
 */
export function unitsOf(grain: LeadgenGrain | null, period: { from: string; to: string }, today: string): string[] {
  if (!grain) return [];
  const last = period.to < today ? period.to : today;
  const out: string[] = [];
  if (grain === "day") for (let d = period.from; d <= last; d = addDays(d, 1)) out.push(d);
  else for (let w = mondayOf(period.from); w <= last; w = addDays(w, 7)) out.push(w);
  return out;
}
export function fillBuckets<T extends LeadgenBucket>(units: string[], buckets: T[]): LeadgenBucket[] {
  const by = new Map(buckets.map((b) => [b.bucket, b]));
  return units.map((u) => by.get(u) ?? { bucket: u, calls: 0, leads: 0, opr: 0, quotes: 0, warming: 0 });
}

/** «дд.мм», а якщо період перетинає рік — «дд.мм.рр», щоб 28.12–03.01 не читався як один рік. */
export const dateLbl = (s: string, period: { from: string; to: string }) =>
  period.from.slice(0, 4) !== period.to.slice(0, 4) ? `${ddmm(s)}.${s.slice(2, 4)}` : ddmm(s);

/** Підпис одиниці: «Пн 21.09» для дня; «31.08–06.09» для тижня, обрізаний межами періоду — із «*». */
export function bucketLabel(b: string, grain: LeadgenGrain, period: { from: string; to: string }): string {
  if (grain === "day") return `${WD[dow(b) - 1]} ${dateLbl(b, period)}`;
  const end = addDays(b, 6);
  const a = b < period.from ? period.from : b, z = end > period.to ? period.to : end;
  const cut = a !== b || z !== end ? " *" : "";
  return a === z ? `${dateLbl(a, period)}${cut}` : `${dateLbl(a, period)}–${dateLbl(z, period)}${cut}`;
}

/**
 * Рядок лідгена — у візуальній мові рядка менеджера зі Звіту: ліва смуга статусу,
 * кільце, головні числа; клік розгортає розбивку на одиницю нижче обраного періоду
 * (місяць/довгий період — тижні, тиждень/короткий період — дні, день — без розбивки).
 */
export function LeadgenPersonRow({ row, money, dataPeriod, buckets, grain, units, targets, period, statusful, open, onToggle }: {
  row: Row;
  /** Гроші з переданих цією людиною лідів (див. `LeadgenHandoffMoney`); немає — «—». */
  money?: LeadgenHandoffMoney;
  /** Період, за який УЖЕ завантажені числа рядка (`money` з нього). Список грошей бере саме його, а не щойно
   *  обраний `period`: інакше під час перезавантаження список нового періоду звірявся б зі старим рядком. */
  dataPeriod: { from: string; to: string };
  buckets: LeadgenBucket[];
  grain: LeadgenGrain | null;
  units: string[];
  targets: { oprOfLeads: number; quotesOfOpr: number };
  period: { from: string; to: string };
  statusful: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const st = convStatus(row.opr, row.leads, targets.oprOfLeads, statusful);
  const overfullWhy = `ОПР (${n(row.opr)}) більше, ніж лідів (${n(row.leads)}): частина ОПР — із лідів, узятих раніше цього періоду, або змінився процес. Така «конверсія» нічого не каже, тому без статусу.`;
  const quotesConv = ratio(row.quotes, row.opr);

  return (
    <div className="lg-card" style={{ background: "var(--card-bg)", border: "1px solid var(--border)", borderLeft: `4px solid ${st.color}`, borderRadius: 14, marginBottom: 11, overflow: "hidden" }}>
      <button type="button" onClick={onToggle} aria-expanded={open} className="lg-row-head"
        style={{ border: 0, background: "transparent", color: "inherit", font: "inherit", textAlign: "left", margin: 0,
          boxSizing: "border-box", width: "100%", cursor: "pointer", display: "grid", gap: 14, alignItems: "center", padding: "14px 17px" }}>
        <span style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 0 }}>
          <span style={{ fontWeight: 700, fontSize: 15 }}>{row.name}</span>
          <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <Chip>{row.teamName ?? "поза командою"}</Chip>
            {!row.isActive && <Chip>деактивований</Chip>}
          </span>
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <StatusRing st={st} target={targets.oprOfLeads}
            title={st.overfull ? overfullWhy : st.conv == null ? "Лідів у періоді немає — конверсію рахувати нема з чого"
              : !statusful ? "Статус — лише за місяць і довше: за день чи тиждень ОПР здебільшого з лідів, узятих раніше." : undefined} />
          <span style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 13 }} title={st.overfull ? overfullWhy : undefined}>
            <span><b style={{ fontSize: 16 }}>{st.conv == null ? "—" : pct1(st.conv)}</b> ліди → ОПР</span>
            <span style={{ color: MUTED }}>ціль {targets.oprOfLeads} %
              {st.ofTarget != null && <> · {st.ofTarget} % цілі</>}
              {st.overfull && <> · ⚠ понад 100 %</>}</span>
          </span>
        </span>
        <span style={{ display: "flex", gap: 14, flexWrap: "wrap", justifyContent: "space-between" }}>
          <Stat v={row.calls} l="Дзвінки" />
          <Stat v={row.leads} l="Ліди" />
          <Stat v={row.opr} l="ОПР" />
          <Stat v={row.quotes} l="Прорахунки" />
          <Stat v={row.warming} l="Підігрів" />
          <span style={{ textAlign: "center", minWidth: 64 }} title="Сума успішних угод з лідів, переданих у цьому періоді (стан — зараз)">
            <span style={{ display: "block", fontWeight: 750, fontSize: 16, fontVariantNumeric: "tabular-nums", lineHeight: 1.1, color: money?.success.sum ? "var(--ok)" : MUTED }}>{money ? formatAmount(money.success.sum) : "—"}</span>
            <span style={{ display: "block", fontSize: 10, color: MUTED, textTransform: "uppercase", letterSpacing: ".3px", marginTop: 2 }}>Успішні з передач ₴</span>
          </span>
        </span>
        <span aria-hidden="true" style={{ color: MUTED, fontSize: 14, transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" }}>▶</span>
      </button>

      {open && (
        <div style={{ borderTop: "1px solid var(--border)", padding: "12px 17px 16px" }}>
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 14, marginBottom: grain ? 12 : 0 }}>
            <span>Ліди → ОПР: <b style={{ color: st.conv != null && !st.overfull && st.conv < targets.oprOfLeads ? "var(--danger)" : "inherit" }}>{st.conv == null ? "—" : pct1(st.conv)}</b> <span style={{ color: MUTED }}>ціль {targets.oprOfLeads} %</span></span>
            <span>ОПР → прорахунок: <b style={{ color: quotesConv != null && quotesConv <= 100 && quotesConv < targets.quotesOfOpr ? "var(--danger)" : "inherit" }}>{quotesConv == null ? "—" : pct1(quotesConv)}</b>
              {quotesConv != null && quotesConv > 100 && <span style={{ color: "var(--warn)" }}> ⚠ понад 100 %</span>} <span style={{ color: MUTED }}>ціль {targets.quotesOfOpr} %</span></span>
            {st.overfull && <span style={{ color: "var(--warn)", flexBasis: "100%", fontSize: 12.5 }}>⚠ {overfullWhy}</span>}
          </div>
          <LeadgenMoneyDetails period={dataPeriod} managerId={row.managerId} summary={money} />
          {grain ? <Buckets row={row} rows={fillBuckets(units, buckets)} grain={grain} period={period} />
            : <p style={{ margin: "8px 0 0", fontSize: 12.5, color: MUTED }}>За один день розбивки немає — оберіть тиждень чи місяць.</p>}
        </div>
      )}
    </div>
  );
}

type F = "calls" | "leads" | "opr" | "quotes" | "warming";
const FIELD: Record<Exclude<F, "calls">, string> = { leads: "ліди", opr: "ОПР", quotes: "прорахунки", warming: "підігрів" };

/**
 * Примітка під розбивкою. Сума одиниць буває БІЛЬШОЮ за період: угода, що заходила в
 * етап двічі в різні дні/тижні, рахується в кожному з них, а в періоді — раз. МЕНШОЮ
 * вона бути не може — якщо таке сталось, це дефект даних, і ми кажемо про це прямо.
 */
export function BucketNote({ total, rows, grain, period }: { total: Record<F, number>; rows: LeadgenBucket[]; grain: LeadgenGrain; period: { from: string; to: string } }) {
  const sum = (f: F) => rows.reduce((s, w) => s + w[f], 0);
  const fields = ["leads", "opr", "quotes", "warming"] as const;
  const over = fields.filter((f) => sum(f) > total[f]);
  const under = fields.filter((f) => sum(f) < total[f]);
  const partial = grain === "week" && rows.some((w) => w.bucket < period.from || addDays(w.bucket, 6) > period.to);
  const unitPl = grain === "day" ? "дні" : "тижні";
  return (
    <p style={{ margin: "8px 0 0", fontSize: 12, color: MUTED, lineHeight: 1.5 }}>
      {partial && <>* тиждень обрізаний межами періоду. </>}
      Рядки без дій показано нулями.{" "}
      {over.length > 0 && <>Сума по рядках більша за період ({over.map((f) => `${FIELD[f]} ${n(sum(f))} проти ${n(total[f])}`).join(", ")}): угода, що заходила в етап двічі в різні {unitPl}, рахується в кожному з них, а в періоді — один раз. </>}
      {under.length > 0 && <span style={{ color: RED }}>⚠ Сума по рядках МЕНША за період ({under.map((f) => `${FIELD[f]} ${n(sum(f))} проти ${n(total[f])}`).join(", ")}) — так бути не може, це дефект даних; повідомте.</span>}
    </p>
  );
}

function Buckets({ row, rows, grain, period }: { row: Row; rows: LeadgenBucket[]; grain: LeadgenGrain; period: { from: string; to: string } }) {
  const cell: React.CSSProperties = { padding: "7px 10px", textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };
  const head: React.CSSProperties = { ...cell, fontWeight: 600, fontSize: 12.5, color: MUTED };
  if (rows.length === 0) return <p style={{ margin: 0, fontSize: 13, color: MUTED }}>Період ще не почався.</p>;
  return (
    <div style={{ overflowX: "auto", maxHeight: 420, overflowY: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
        <thead style={{ position: "sticky", top: 0, background: "var(--card-bg)" }}>
          <tr>
            <th style={{ ...head, textAlign: "left" }}>{grain === "day" ? "День" : "Тиждень"}</th>
            <th style={head}>Дзвінки</th><th style={head}>Ліди</th><th style={head}>ОПР</th>
            <th style={head}>Прорахунки</th><th style={head}>Підігрів</th><th style={head}>Ліди → ОПР</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((w) => {
            const c = ratio(w.opr, w.leads);
            const empty = !w.calls && !w.leads && !w.opr && !w.quotes && !w.warming;
            return (
              <tr key={w.bucket} style={{ borderTop: "1px solid var(--border)", color: empty ? MUTED : undefined }}>
                <td style={{ padding: "7px 10px", whiteSpace: "nowrap" }}>{bucketLabel(w.bucket, grain, period)}</td>
                <td style={cell}>{n(w.calls)}</td><td style={cell}>{n(w.leads)}</td><td style={cell}>{n(w.opr)}</td>
                <td style={cell}>{n(w.quotes)}</td><td style={cell}>{n(w.warming)}</td>
                <td style={cell}>{c == null ? "—" : c > 100 ? `${pct1(c)} ⚠` : pct1(c)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <BucketNote total={row} rows={rows} grain={grain} period={period} />
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return <span style={{ fontSize: 11, fontWeight: 600, padding: "1px 8px", borderRadius: 20, background: "var(--bg)", color: MUTED, border: "1px solid var(--border)" }}>{children}</span>;
}

function Stat({ v, l }: { v: number; l: string }) {
  return (
    <span style={{ textAlign: "center", minWidth: 52 }}>
      <span style={{ display: "block", fontWeight: 750, fontSize: 16, fontVariantNumeric: "tabular-nums", lineHeight: 1.1, color: v ? "var(--text)" : MUTED }}>{n(v)}</span>
      <span style={{ display: "block", fontSize: 10, color: MUTED, textTransform: "uppercase", letterSpacing: ".3px", marginTop: 2 }}>{l}</span>
    </span>
  );
}

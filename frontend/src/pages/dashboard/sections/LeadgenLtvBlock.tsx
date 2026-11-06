import { Fragment, useEffect, useMemo, useState } from "react";
import { fetchLeadgenLtv, type LeadgenLtvResp, type LtvAgg, type LtvClient, type LtvPerson } from "../../../api";
import { formatAmountFull } from "../format";
import { InfoHint } from "../widgets";

/**
 * 💎 «LTV КЛІЄНТІВ ЛІДОГЕНЕРАЦІЇ» (ТЗ 28.10.2026, погоджено з директором) — згорнутий блок «Статистики», такий самий, як
 * «👤 Інші, не з команди» / «Деталі відділу» / «📋 Плани лідгенів»: `<details className="chart-card">`, за замовчуванням
 * згорнутий. Усе рахує сервер (`core/leadgenLtv.ts`): «за весь час» не залежить від періоду, приріст і нові — від нього.
 * Клієнт закріплений за тим, хто передав лід (хто перевів угоду в «Кваліфіковано»), — не за поточним відповідальним.
 */
const MUTED = "var(--text-muted)";
const nf = (v: number) => v.toLocaleString("uk-UA");
const mln = (v: number) => (Math.abs(v) >= 1_000_000 ? `${(v / 1_000_000).toFixed(2).replace(".", ",")} млн ₴` : formatAmountFull(v));
const pct = (v: number | null) => (v == null ? "—" : `${v}%`);
const dpc = (v: number | null) => (v == null ? "—" : String(v).replace(".", ","));
const MONTHS = ["січ", "лют", "бер", "кві", "тра", "чер", "лип", "сер", "вер", "жов", "лис", "гру"];
const ymLabel = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const dmy = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const SEGMENT: Record<string, string> = { vip: "⚡ ВІП", regular: "🔁 Регулярний", episodic: "🌙 Епізодичний", unknown: "недостатньо історії" };
const STATE: Record<string, string> = { active: "активний", sleeping: "сплячий", lost: "втрачений" };
const RULES = "Клієнт лідгена — клієнт, чия ПЕРША успішна угода за всю історію виросла з ліда, який лідген передав. Закріплюється назавжди за тим, хто перевів угоду Продзвону в «Кваліфіковано», — зміна відповідального в Kommo цього не змінює. "
  + "Постійні до передачі (була успішна угода раніше або КВП позначив постійним) і перевізники з архіву не рахуються. LTV — маржа всіх успішних угод клієнта від першої до сьогодні; мінусові віднімаються. "
  + "Оборот — сума рахунків тих самих угод, довідково. Повернуті з «Пулу лідгенів» — окремо: лише маржа після повернення, в основний LTV не входять.";

type SortKey = "ltv" | "clients" | "avg" | "repeat" | "growth";

export function LeadgenLtvBlock({ from, to, periodLabel, who, own, onShowClients }: {
  from: string; to: string; periodLabel: string; who: number | "all"; own: boolean;
  /** «усі клієнти →» — таб «Клієнти LTV» у «Які угоди рахуємо» для цієї людини. */
  onShowClients: (managerId: number | null) => void;
}) {
  const [d, setD] = useState<LeadgenLtvResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [sort, setSort] = useState<SortKey>("ltv");
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [allCohorts, setAllCohorts] = useState(false);

  useEffect(() => {
    let alive = true;
    setErr(null);
    fetchLeadgenLtv({ from, to, managerId: own || who === "all" ? undefined : who })
      .then((r) => { if (alive) setD(r); })
      .catch((e) => { if (alive) { setD(null); setErr(e?.response?.data?.error ?? "Не вдалося завантажити LTV."); } });
    return () => { alive = false; };
  }, [from, to, who, own]);

  const sortVal = (a: LtvAgg) => (sort === "ltv" ? a.ltv : sort === "clients" ? a.clients : sort === "avg" ? a.avg ?? -1 : sort === "repeat" ? a.repeatPct ?? -1 : a.growth);
  const people = useMemo(() => [...(d?.people ?? [])].sort((a, b) => sortVal(b.agg) - sortVal(a.agg)), [d, sort]); // eslint-disable-line react-hooks/exhaustive-deps
  if (err) return <div className="chart-card" style={{ margin: "4px 0 14px", color: MUTED, fontSize: 13 }}>💎 LTV клієнтів лідогенерації: {err}</div>;
  if (!d) return null;
  const t = d.totals;
  const cell: React.CSSProperties = { padding: "7px 10px", textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };
  const head: React.CSSProperties = { ...cell, fontWeight: 600, fontSize: 12.5, color: MUTED };
  const sortTh = (k: SortKey, label: string) => (
    <th style={{ ...head, cursor: "pointer" }} onClick={() => setSort(k)} aria-sort={sort === k ? "descending" : "none"}>{label}{sort === k ? " ▼" : ""}</th>
  );
  const tile = (value: string, label: string, sub?: string) => (
    <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, padding: "9px 12px" }}>
      <div style={{ fontSize: 19, fontWeight: 700 }}>{value}</div>
      <div style={{ fontSize: 11.5, color: MUTED }}>{label}</div>
      {sub && <div style={{ fontSize: 11.5, color: MUTED, marginTop: 2 }}>{sub}</div>}
    </div>
  );
  const poolCell = (p: { clients: number; ltv: number }) => (p.clients ? `${p.clients} · ${nf(p.ltv)}` : "—");
  const row = (key: string, p: LtvPerson | null, label: React.ReactNode, agg: LtvAgg, pool: { clients: number; ltv: number } | null, bold = false) => (
    <tr key={key} onClick={p ? () => setOpenRow((x) => (x === key ? null : key)) : undefined} style={{ cursor: p ? "pointer" : undefined, borderTop: "1px solid var(--border)", fontWeight: bold ? 700 : undefined }}>
      <td style={{ ...cell, textAlign: "left" }}>{p ? (openRow === key ? "▾ " : "▸ ") : ""}{label}</td>
      <td style={cell}>{nf(agg.clients)}</td><td style={cell}>{nf(agg.ltv)}</td><td style={cell}>{agg.avg == null ? "—" : nf(agg.avg)}</td>
      <td style={cell}>{pct(agg.repeatPct)}</td><td style={cell}>{nf(agg.growth)}</td><td style={cell}>{pool ? poolCell(pool) : "—"}</td>
    </tr>
  );
  const top = (key: string, p: LtvPerson) => openRow === key && (
    <tr key={`${key}-top`}><td colSpan={7} style={{ background: "var(--bg)", padding: "8px 12px" }}>
      <div style={{ fontSize: 12, color: MUTED, marginBottom: 4 }}>
        Топ-10 клієнтів за LTV · <button type="button" onClick={() => onShowClients(p.managerId)}
          style={{ border: 0, background: "none", padding: 0, color: "var(--accent)", cursor: "pointer", fontSize: 12 }}>усі клієнти →</button>
      </div>
      {p.top.length ? <ClientTable rows={p.top} /> : <div style={{ fontSize: 12.5, color: MUTED }}>Клієнтів, приведених цією людиною, ще немає.</div>}
    </td></tr>
  );
  const cohorts = allCohorts ? d.cohorts : d.cohorts.slice(0, 12);

  return (
    <details className="chart-card" style={{ margin: "4px 0 14px" }} open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary style={{ cursor: "pointer", fontWeight: 650 }}>
        💎 LTV клієнтів лідогенерації · {nf(t.clients)} клієнтів · LTV {mln(t.ltv)} · сер. {t.avg == null ? "—" : formatAmountFull(t.avg)} · повторні {pct(t.repeatPct)}
        <span style={{ fontWeight: 400, color: MUTED, fontSize: 13 }}> — за весь час</span>
      </summary>
      {open && <>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8, margin: "12px 0 8px" }}>
          {tile(nf(t.clients), "клієнтів", "за весь час")}
          {tile(mln(t.ltv), "LTV разом, маржа", `оборот ${mln(t.turnover)}`)}
          {tile(t.avg == null ? "—" : formatAmountFull(t.avg), "середній LTV")}
          {tile(pct(t.repeatPct), "повторні", "2+ успішні угоди")}
          {tile(dpc(t.dealsPerClient), "угод на клієнта")}
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", fontSize: 13 }}>
          <span>за {periodLabel}: <b>+{formatAmountFull(t.growth)}</b> приросту LTV · <b>{nf(t.newClients)}</b> нових клієнтів</span>
          <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 6, background: "var(--bg)", border: "1px solid var(--border)" }}>
            повернуті з пулу: {nf(d.pool.clients)} клієнтів · {formatAmountFull(d.pool.ltv)} маржі після повернення
          </span>
          <InfoHint text={RULES} />
        </div>
        {(d.turnoverMissing > 0 || d.unknownActors > 0) && (
          <div style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>
            {d.turnoverMissing > 0 && <>Оборот без {nf(d.turnoverMissing)} угод — у них у дашборді немає сум рахунку з Kommo. </>}
            {d.unknownActors > 0 && <>{nf(d.unknownActors)} клієнтів передано з акаунтів Kommo, яких немає серед менеджерів, — вони в «Інші». </>}
          </div>
        )}

        {(people.length > 0 || d.others) && <>
          <div style={{ fontWeight: 650, margin: "16px 0 6px" }}>По лідгенах</div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 680 }}>
              <thead><tr>
                <th style={{ ...head, textAlign: "left" }}>Лідген</th>{sortTh("clients", "Клієнтів")}{sortTh("ltv", "LTV разом ₴")}{sortTh("avg", "Сер. LTV ₴")}
                {sortTh("repeat", "Повторні")}{sortTh("growth", `Приріст за період ₴`)}<th style={head}>З пулу</th>
              </tr></thead>
              <tbody>
                {people.map((p) => <Fragment key={`m${p.managerId}`}>{row(`m${p.managerId}`, p, p.name, p.agg, p.pool)}{top(`m${p.managerId}`, p)}</Fragment>)}
                {d.others && <>
                  {row("others", null, <span onClick={() => setOpenRow((x) => (x === "others" ? null : "others"))} style={{ cursor: "pointer" }}>{openRow === "others" || openRow?.startsWith("o:") ? "▾ " : "▸ "}👤 Інші, не з команди</span>, d.others.agg, d.others.pool)}
                  {(openRow === "others" || openRow?.startsWith("o:")) && d.others.people.map((p, i) => (
                    <Fragment key={`o${i}`}>
                      {row(`o:${i}`, p, <span style={{ paddingLeft: 14 }}>{p.name}{p.dismissed ? <span style={{ color: MUTED }}> · звільнений</span> : p.managerId != null ? <span style={{ color: MUTED }}> · не з команди</span> : null}</span>, p.agg, p.pool)}
                      {top(`o:${i}`, p)}
                    </Fragment>
                  ))}
                </>}
                {row("total", null, `Разом по ${own ? "своїх" : "відділу"}`, t, d.pool, true)}
              </tbody>
            </table>
          </div>
        </>}

        <div style={{ fontWeight: 650, margin: "18px 0 2px" }}>LTV по когортах</div>
        <div style={{ fontSize: 12.5, color: MUTED, marginBottom: 6 }}>Когорта — місяць першої успішної угоди клієнта. LTV — маржа всіх його успішних угод відтоді до сьогодні.</div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
            <thead><tr><th style={{ ...head, textAlign: "left" }}>Когорта</th><th style={head}>Клієнтів</th><th style={head}>LTV разом ₴</th><th style={head}>Сер. LTV ₴</th><th style={head}>Повторні</th><th style={head}>Угод на клієнта</th></tr></thead>
            <tbody>
              {cohorts.map((c) => (
                <tr key={c.ym} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={{ ...cell, textAlign: "left" }}>{ymLabel(c.ym)}{c.warn && <span title="Понад 20% передач цього місяця без угоди менеджера — гроші за ними прив'язати неможливо"
                    style={{ marginLeft: 6, fontSize: 11.5, padding: "1px 7px", borderRadius: 6, color: "var(--warn)", border: "1px solid var(--warn)" }}>⚠ {c.unlinkedPct}% без угоди менеджера</span>}</td>
                  <td style={cell}>{nf(c.clients)}</td><td style={cell}>{nf(c.ltv)}</td><td style={cell}>{c.avg == null ? "—" : nf(c.avg)}</td>
                  <td style={cell}>{pct(c.repeatPct)}</td><td style={cell}>{dpc(c.dealsPerClient)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {d.cohorts.length > 12 && (
          <button type="button" onClick={() => setAllCohorts((x) => !x)} style={{ border: 0, background: "none", padding: "6px 0", color: "var(--accent)", cursor: "pointer", fontSize: 12.5 }}>
            {allCohorts ? "▴ лише останні 12 місяців" : `▸ показати всі місяці (ще ${d.cohorts.length - 12})`}
          </button>
        )}
        <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>Свіжі когорти ще ростуть: низький LTV там означає вік клієнтів, а не якість.</div>
        {d.builtAt && <div style={{ fontSize: 11.5, color: MUTED, marginTop: 4 }}>Клієнтів зібрано {new Date(d.builtAt).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv" })} — оновлюється кожні 30 хв.</div>}
      </>}
    </details>
  );
}

/** Клієнти: дата першої угоди, угоди, LTV, менеджер зараз, сегмент і стан — ті самі, що в «Клієнтах». */
export function ClientTable({ rows, wide = false }: { rows: LtvClient[]; wide?: boolean }) {
  const th: React.CSSProperties = { textAlign: "left", padding: "6px 8px", fontSize: 11.5, color: MUTED, fontWeight: 600, borderBottom: "1px solid var(--border)" };
  const td: React.CSSProperties = { padding: "6px 8px", borderBottom: "1px solid var(--border)", fontSize: 13 };
  const num: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", minWidth: wide ? 860 : 620 }}>
        <thead><tr>
          <th style={th}>Клієнт</th><th style={th}>Перша успішна угода</th>{wide && <th style={th}>Хто передав</th>}
          <th style={{ ...th, textAlign: "right" }}>Угод</th><th style={{ ...th, textAlign: "right" }}>LTV ₴</th>
          {wide && <th style={{ ...th, textAlign: "right" }}>Оборот ₴</th>}<th style={th}>Менеджер зараз</th><th style={th}>{wide ? "Позначка" : "Сегмент · стан"}</th>
        </tr></thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.clientKey}>
              <td style={td}>{c.name}</td>
              <td style={{ ...td, whiteSpace: "nowrap" }}><a href={c.firstDealUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>#{c.firstDealId} ↗</a> · {dmy(c.firstDay)}</td>
              {wide && <td style={td}>{c.handedBy}</td>}
              <td style={num}>{nf(c.deals)}</td><td style={num}>{nf(c.ltv)}</td>
              {wide && <td style={{ ...num, color: MUTED }}>{nf(c.turnover)}</td>}
              <td style={td}>{c.ownerName ?? <span style={{ color: MUTED }}>не визначено</span>}</td>
              <td style={{ ...td, color: MUTED, fontSize: 12.5 }}>{wide
                ? (c.marks.includes("merged") ? "обʼєднано" : "—")
                : `${c.segment ? SEGMENT[c.segment] ?? c.segment : "—"} · ${c.state ? STATE[c.state] ?? c.state : "—"}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

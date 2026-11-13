import { Fragment, useEffect, useMemo, useState } from "react";
import { fetchLeadgenLtv, fetchLeadgenLtvClients, type LeadgenLtvResp, type LtvAgg, type LtvClient, type LtvGroup, type LtvPerson } from "../../../api";
import { formatAmountFull } from "../format";
import { InfoHint } from "../widgets";

/**
 * 💎 «LTV КЛІЄНТІВ ЛІДОГЕНЕРАЦІЇ» (ТЗ 28.10.2026, погоджено з директором) — згорнутий блок «Статистики», такий самий, як
 * «👤 Інші, не з команди» / «Деталі відділу» / «📋 Плани лідгенів»: `<details className="chart-card">`, за замовчуванням
 * згорнутий. Усе рахує сервер (`core/leadgenLtv.ts`): «за весь час» не залежить від періоду, приріст і нові — від нього.
 * Клієнт закріплений за тим, хто передав лід (хто перевів угоду в «Кваліфіковано»), — не за поточним відповідальним.
 *
 * 🧭 Задача 8729 (13.11.2026): «стали постійними» (2+ успішні угоди) і «працюють зараз» (стан «активний») — числом, і склад
 * клієнтів на чотири групи. Групи рахує сервер (`ltvGroupOf`), тут — лише та сама межа для фільтрів списку клієнтів.
 */
const MUTED = "var(--text-muted)";
const nf = (v: number) => v.toLocaleString("uk-UA");
const mln = (v: number) => (Math.abs(v) >= 1_000_000 ? `${(v / 1_000_000).toFixed(2).replace(".", ",")} млн ₴` : formatAmountFull(v));
const pct = (v: number | null) => (v == null ? "—" : `${v}%`);
const share = (a: number, n: number) => (n ? Math.round((a / n) * 100) : null);
const dpc = (v: number | null) => (v == null ? "—" : String(v).replace(".", ","));
const MONTHS = ["січ", "лют", "бер", "кві", "тра", "чер", "лип", "сер", "вер", "жов", "лис", "гру"];
const ymLabel = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const dmy = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const SEGMENT: Record<string, string> = { vip: "⚡ ВІП", regular: "🔁 Регулярний", episodic: "🌙 Епізодичний", unknown: "недостатньо історії" };
const STATE: Record<string, { label: string; bg: string; fg: string }> = {
  active: { label: "працює", bg: "var(--ok-bg)", fg: "var(--ok)" },
  sleeping: { label: "сплячий", bg: "var(--warn-bg)", fg: "var(--warn)" },
  lost: { label: "втрачений", bg: "var(--bg)", fg: MUTED },
};
const RULES = "Клієнт лідгена — клієнт, чия ПЕРША успішна угода за всю історію виросла з ліда, який лідген передав. Закріплюється назавжди за тим, хто перевів угоду Продзвону в «Кваліфіковано», — зміна відповідального в Kommo цього не змінює. "
  + "Постійні до передачі (була успішна угода раніше або КВП позначив постійним) і перевізники з архіву не рахуються. LTV — маржа всіх успішних угод клієнта від першої до сьогодні; мінусові віднімаються. "
  + "Оборот — сума рахунків тих самих угод, довідково. Повернуті з «Пулу лідгенів» — окремо: лише маржа після повернення, в основний LTV не входять. "
  + "Стали постійними — 2+ успішні угоди (те саме правило, що в «Клієнтах»). Працюють зараз — стан клієнта «активний»: замовляє у ритмі свого сегмента.";

/** Група клієнта — та сама межа, що в ядрі (`ltvGroupOf`): постійний — 2+ угоди, працює — лише стан «активний». */
const groupOf = (c: { deals: number; state: string | null }): LtvGroup =>
  c.deals >= 2 ? (c.state === "active" ? "rw" : "rs") : (c.state === "active" ? "ow" : "os");
const GROUP: Record<LtvGroup, { color: string; label: string }> = {
  rw: { color: "#15803d", label: "постійні, працюють" },
  rs: { color: "#d97706", label: "постійні, зараз не замовляють" },
  ow: { color: "#9fd5b2", label: "разові, працюють" },
  os: { color: "#dedcd8", label: "разові, не працюють" },
};
const GROUPS: LtvGroup[] = ["rw", "rs", "ow", "os"];
type ChipKey = "all" | "rep" | "act" | "rs";
const CHIP: Record<ChipKey, { label: string; test: (c: LtvClient) => boolean }> = {
  all: { label: "Усі", test: () => true },
  rep: { label: "Стали постійними", test: (c) => c.deals >= 2 },
  act: { label: "Працюють зараз", test: (c) => c.state === "active" },
  rs: { label: "Постійні, не замовляють", test: (c) => groupOf(c) === "rs" },
};
const LIST_MAX = 15;

/** Смуга складу: чотири групи тими самими кольорами, що й у підсумку. */
export function MixBar({ mix, height = 8, width, pick, selected }: {
  mix: Record<LtvGroup, number>; height?: number; width?: number; pick?: (g: LtvGroup) => void; selected?: LtvGroup | null;
}) {
  const total = GROUPS.reduce((a, g) => a + mix[g], 0);
  if (!total) return <span style={{ fontSize: 12, color: MUTED }}>клієнтів ще немає</span>;
  return (
    <div role="img" aria-label={GROUPS.map((g) => `${GROUP[g].label}: ${mix[g]}`).join(", ")}
      style={{ display: "flex", height, width: width ?? "100%", borderRadius: height / 2, overflow: "hidden", gap: height > 9 ? 2 : 1, background: "var(--border)" }}>
      {GROUPS.filter((g) => mix[g] > 0).map((g) => (
        <i key={g} title={`${GROUP[g].label}: ${mix[g]}`} onClick={pick ? () => pick(g) : undefined}
          style={{ display: "block", flex: mix[g], background: GROUP[g].color, cursor: pick ? "pointer" : undefined, opacity: selected && selected !== g ? 0.35 : 1 }} />
      ))}
    </div>
  );
}

type SortKey = "ltv" | "clients" | "avg" | "repeat" | "active" | "growth";

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
  const [group, setGroup] = useState<LtvGroup | null>(null);
  /** Усі клієнти в межах того, що бачить користувач, — для панелі групи й фільтрів людини; вантажимо за першим кліком. */
  const [clients, setClients] = useState<LtvClient[] | null>(null);
  const [clientsErr, setClientsErr] = useState<string | null>(null);
  const pickId = own || who === "all" ? undefined : who;

  useEffect(() => {
    let alive = true;
    setErr(null);
    fetchLeadgenLtv({ from, to, managerId: pickId })
      .then((r) => { if (alive) setD(r); })
      .catch((e) => { if (alive) { setD(null); setErr(e?.response?.data?.error ?? "Не вдалося завантажити LTV."); } });
    return () => { alive = false; };
  }, [from, to, pickId]);
  useEffect(() => { setClients(null); setGroup(null); }, [pickId]);

  const needClients = () => {
    if (clients || clientsErr) return;
    fetchLeadgenLtvClients({ managerId: pickId })
      .then((r) => setClients(r.clients))
      .catch((e) => setClientsErr(e?.response?.data?.error ?? "Не вдалося завантажити клієнтів."));
  };
  const pickGroup = (g: LtvGroup) => { setGroup((x) => (x === g ? null : g)); needClients(); };

  const sortVal = (a: LtvAgg) => (sort === "ltv" ? a.ltv : sort === "clients" ? a.clients : sort === "avg" ? a.avg ?? -1
    : sort === "repeat" ? a.repeat : sort === "active" ? a.activeNow : a.growth);
  const people = useMemo(() => [...(d?.people ?? [])].sort((a, b) => sortVal(b.agg) - sortVal(a.agg)), [d, sort]); // eslint-disable-line react-hooks/exhaustive-deps
  if (err) return <div className="chart-card" style={{ margin: "4px 0 14px", color: MUTED, fontSize: 13 }}>💎 LTV клієнтів лідогенерації: {err}</div>;
  if (!d) return null;
  const t = d.totals;
  const cell: React.CSSProperties = { padding: "7px 10px", textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };
  const head: React.CSSProperties = { ...cell, fontWeight: 600, fontSize: 12.5, color: MUTED };
  const sortTh = (k: SortKey, label: string) => (
    <th style={{ ...head, cursor: "pointer" }} onClick={() => setSort(k)} aria-sort={sort === k ? "descending" : "none"}>{label}{sort === k ? " ▼" : ""}</th>
  );
  const tile = (value: React.ReactNode, label: string, sub?: string) => (
    <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, padding: "9px 12px" }}>
      <div style={{ fontSize: 19, fontWeight: 700 }}>{value}</div>
      <div style={{ fontSize: 11.5, color: MUTED }}>{label}</div>
      {sub && <div style={{ fontSize: 11.5, color: MUTED, marginTop: 2 }}>{sub}</div>}
    </div>
  );
  const numPct = (v: number, n: number) => <>{nf(v)} <span style={{ color: MUTED, fontWeight: 400 }}>{pct(share(v, n))}</span></>;
  const poolCell = (p: { clients: number; ltv: number }) => (p.clients ? `${p.clients} · ${nf(p.ltv)}` : "—");
  const row = (key: string, p: LtvPerson | null, label: React.ReactNode, agg: LtvAgg, pool: { clients: number; ltv: number } | null, bold = false) => (
    <tr key={key} onClick={p && agg.clients ? () => { setOpenRow((x) => (x === key ? null : key)); needClients(); } : undefined}
      style={{ cursor: p && agg.clients ? "pointer" : undefined, borderTop: "1px solid var(--border)", fontWeight: bold ? 700 : undefined }}>
      <td style={{ ...cell, textAlign: "left" }}>{p && agg.clients ? (openRow === key ? "▾ " : "▸ ") : ""}{label}</td>
      <td style={cell}>{nf(agg.clients)}</td><td style={cell}>{nf(agg.ltv)}</td><td style={cell}>{agg.avg == null ? "—" : nf(agg.avg)}</td>
      <td style={cell}>{agg.clients ? numPct(agg.repeat, agg.clients) : "—"}</td>
      <td style={cell}>{agg.clients ? numPct(agg.activeNow, agg.clients) : "—"}</td>
      <td style={{ ...cell, textAlign: "left" }}><MixBar mix={agg.mix} width={130} /></td>
      <td style={cell}>{nf(agg.growth)}</td><td style={cell}>{pool ? poolCell(pool) : "—"}</td>
    </tr>
  );
  const top = (key: string, p: LtvPerson) => openRow === key && (
    <tr key={`${key}-top`}><td colSpan={9} style={{ background: "var(--bg)", padding: "8px 12px" }}>
      <PersonClients person={p} all={p.managerId == null ? null : clients} err={clientsErr} onShowAll={() => onShowClients(p.managerId)} />
    </td></tr>
  );
  const cohorts = allCohorts ? d.cohorts : d.cohorts.slice(0, 12);
  const groupRows = group && clients ? clients.filter((c) => groupOf(c) === group) : null;

  return (
    <details className="chart-card" style={{ margin: "4px 0 14px" }} open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary style={{ cursor: "pointer", fontWeight: 650 }}>
        💎 LTV клієнтів лідогенерації · {nf(t.clients)} клієнтів · LTV {mln(t.ltv)} · сер. {t.avg == null ? "—" : formatAmountFull(t.avg)} · стали постійними {nf(t.repeat)} ({pct(share(t.repeat, t.clients))}) · працюють зараз {nf(t.activeNow)}
        <span style={{ fontWeight: 400, color: MUTED, fontSize: 13 }}> — за весь час</span>
      </summary>
      {open && <>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8, margin: "12px 0 8px" }}>
          {tile(nf(t.clients), "клієнтів", "за весь час")}
          {tile(mln(t.ltv), "LTV разом, маржа", `оборот ${mln(t.turnover)}`)}
          {tile(t.avg == null ? "—" : formatAmountFull(t.avg), "середній LTV")}
          {tile(<>{nf(t.repeat)} · {pct(share(t.repeat, t.clients))}</>, "стали постійними", "2+ успішні угоди")}
          {tile(<span style={{ color: "var(--ok)" }}>{nf(t.activeNow)} · {pct(share(t.activeNow, t.clients))}</span>, "працюють зараз", "стан «активний» у «Клієнтах»")}
          {tile(dpc(t.dealsPerClient), "угод на клієнта")}
        </div>

        {t.clients > 0 && (
          <div style={{ margin: "4px 0 10px", padding: "10px 12px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", fontSize: 12.5, marginBottom: 6 }}>
              <b>Склад {nf(t.clients)} клієнтів</b><span style={{ color: MUTED }}>клік по групі показує її клієнтів</span>
            </div>
            <MixBar mix={t.mix} height={12} pick={pickGroup} selected={group} />
            <div style={{ marginTop: 8, fontSize: 12.5, display: "flex", flexWrap: "wrap", gap: "4px 6px" }}>
              {GROUPS.map((g) => (
                <button key={g} type="button" onClick={() => pickGroup(g)} aria-pressed={group === g}
                  style={{ border: `1px solid ${group === g ? "var(--text)" : "transparent"}`, background: group === g ? "var(--card-bg)" : "none", borderRadius: 999,
                    padding: "2px 9px", cursor: "pointer", display: "inline-flex", gap: 6, alignItems: "center", font: "inherit", color: "inherit" }}>
                  <span style={{ width: 9, height: 9, borderRadius: 3, background: GROUP[g].color }} /><b>{nf(t.mix[g])}</b> <span style={{ color: MUTED }}>{GROUP[g].label}</span>
                </button>
              ))}
            </div>
            {t.mix.rs > 0 && (
              <div style={{ marginTop: 8, fontSize: 12.5, padding: "7px 10px", borderRadius: 8, background: "var(--warn-bg)", color: "var(--warn)", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <span><b>{nf(t.mix.rs)} постійних клієнтів</b> зараз не замовляють — їх варто повертати першими.</span>
                {group !== "rs" && <button type="button" onClick={() => pickGroup("rs")}
                  style={{ border: 0, background: "none", padding: 0, color: "var(--accent)", fontWeight: 600, cursor: "pointer", fontSize: 12.5 }}>Показати →</button>}
              </div>
            )}
            {group && (
              <div style={{ marginTop: 10, background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--border)", fontSize: 13 }}>
                  <span><span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 3, background: GROUP[group].color, marginRight: 6 }} />
                    <b>{GROUP[group].label[0].toUpperCase() + GROUP[group].label.slice(1)}</b> · {nf(t.mix[group])} клієнтів
                    {groupRows && groupRows.length > LIST_MAX && <span style={{ color: MUTED }}> · показано {LIST_MAX} з найбільшим LTV</span>}</span>
                  <button type="button" aria-label="Закрити" onClick={() => setGroup(null)}
                    style={{ border: 0, background: "none", cursor: "pointer", fontSize: 16, color: MUTED, width: 28, height: 28, borderRadius: 6 }}>×</button>
                </div>
                <div style={{ padding: "6px 8px" }}>
                  {clientsErr ? <div style={{ fontSize: 12.5, color: MUTED, padding: 8 }}>{clientsErr}</div>
                    : !groupRows ? <div style={{ fontSize: 12.5, color: MUTED, padding: 8 }}>Завантаження клієнтів…</div>
                    : groupRows.length ? <ClientTable rows={groupRows.slice(0, LIST_MAX)} handedBy />
                    : <div style={{ fontSize: 12.5, color: MUTED, padding: 8 }}>У цій групі клієнтів немає.</div>}
                  {groupRows && groupRows.length > LIST_MAX && (
                    <button type="button" onClick={() => onShowClients(pickId ?? null)}
                      style={{ border: 0, background: "none", padding: "6px 4px", color: "var(--accent)", cursor: "pointer", fontSize: 12.5 }}>усі клієнти →</button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

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
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 900 }}>
              <thead><tr>
                <th style={{ ...head, textAlign: "left" }}>Лідген</th>{sortTh("clients", "Клієнтів")}{sortTh("ltv", "LTV разом ₴")}{sortTh("avg", "Сер. LTV ₴")}
                {sortTh("repeat", "Стали постійними")}{sortTh("active", "Працюють зараз")}<th style={{ ...head, textAlign: "left" }}>Склад</th>
                {sortTh("growth", `Приріст за період ₴`)}<th style={head}>З пулу</th>
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
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 720 }}>
            <thead><tr><th style={{ ...head, textAlign: "left" }}>Когорта</th><th style={head}>Клієнтів</th><th style={head}>LTV разом ₴</th><th style={head}>Сер. LTV ₴</th>
              <th style={head}>Стали постійними</th><th style={head}>Працюють зараз</th><th style={head}>Угод на клієнта</th></tr></thead>
            <tbody>
              {cohorts.map((c) => (
                <tr key={c.ym} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={{ ...cell, textAlign: "left" }}>{ymLabel(c.ym)}{c.warn && <span title="Понад 20% передач цього місяця без угоди менеджера — гроші за ними прив'язати неможливо"
                    style={{ marginLeft: 6, fontSize: 11.5, padding: "1px 7px", borderRadius: 6, color: "var(--warn)", border: "1px solid var(--warn)" }}>⚠ {c.unlinkedPct}% без угоди менеджера</span>}</td>
                  <td style={cell}>{nf(c.clients)}</td><td style={cell}>{nf(c.ltv)}</td><td style={cell}>{c.avg == null ? "—" : nf(c.avg)}</td>
                  <td style={cell}>{numPct(c.repeat, c.clients)}</td><td style={cell}>{numPct(c.activeNow, c.clients)}</td><td style={cell}>{dpc(c.dealsPerClient)}</td>
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

/**
 * Клієнти однієї людини у розкритому рядку: чипи «Усі / Стали постійними / Працюють зараз / Постійні, не замовляють».
 * Лічильники чипів — з підсумку людини (сервер); список — усі її клієнти, коли вони завантажені (`all`), інакше топ-10 з
 * відповіді блоку. Для «Інших» без людини (`managerId` нема) — лише топ-10, бо окремого списку такого рядка немає.
 */
function PersonClients({ person, all, err, onShowAll }: { person: LtvPerson; all: LtvClient[] | null; err: string | null; onShowAll: () => void }) {
  const [chip, setChip] = useState<ChipKey>("all");
  const mine = all ? all.filter((c) => c.handedBy === person.name) : null;
  const base = mine && mine.length ? mine : person.top;
  const rows = base.filter(CHIP[chip].test);
  const count: Record<ChipKey, number> = { all: person.agg.clients, rep: person.agg.repeat, act: person.agg.activeNow, rs: person.agg.mix.rs };
  const full = base === mine;
  return <>
    <div style={{ fontSize: 12, color: MUTED, marginBottom: 4 }}>
      {full ? "Клієнти за LTV" : "Топ-10 клієнтів за LTV"} · <button type="button" onClick={onShowAll}
        style={{ border: 0, background: "none", padding: 0, color: "var(--accent)", cursor: "pointer", fontSize: 12 }}>усі клієнти →</button>
      {err && <span> · {err}</span>}
    </div>
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "6px 0 8px" }}>
      {(Object.keys(CHIP) as ChipKey[]).map((k) => (
        <button key={k} type="button" aria-pressed={chip === k} onClick={() => setChip(k)}
          style={{ fontSize: 12.5, padding: "4px 11px", borderRadius: 999, cursor: "pointer", font: "inherit",
            border: `1px solid ${chip === k ? "var(--text)" : "var(--border)"}`, background: chip === k ? "var(--text)" : "var(--card-bg)", color: chip === k ? "var(--card-bg)" : "var(--text)" }}>
          {CHIP[k].label} · {nf(count[k])}
        </button>
      ))}
    </div>
    {rows.length ? <ClientTable rows={rows.slice(0, LIST_MAX)} />
      : <div style={{ fontSize: 12.5, color: MUTED }}>{base.length ? `У ${full ? "списку" : "топ-10"} таких клієнтів немає.` : "Клієнтів, приведених цією людиною, ще немає."}</div>}
    {rows.length > LIST_MAX && <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>Показано {LIST_MAX} з {nf(rows.length)} — решта в «усі клієнти →».</div>}
  </>;
}

/** Клієнти: дата першої угоди, угоди, LTV, менеджер зараз, чи постійний, стан і ритм — ті самі, що в «Клієнтах». */
export function ClientTable({ rows, wide = false, handedBy = false }: { rows: LtvClient[]; wide?: boolean; handedBy?: boolean }) {
  const th: React.CSSProperties = { textAlign: "left", padding: "6px 8px", fontSize: 11.5, color: MUTED, fontWeight: 600, borderBottom: "1px solid var(--border)" };
  const td: React.CSSProperties = { padding: "6px 8px", borderBottom: "1px solid var(--border)", fontSize: 13 };
  const num: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };
  const showHanded = wide || handedBy;
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", minWidth: wide ? 1000 : showHanded ? 900 : 780 }}>
        <thead><tr>
          <th style={th}>Клієнт</th><th style={th}>Перша успішна угода</th>{showHanded && <th style={th}>Хто передав</th>}
          <th style={{ ...th, textAlign: "right" }}>Угод</th><th style={{ ...th, textAlign: "right" }}>LTV ₴</th>
          {wide && <th style={{ ...th, textAlign: "right" }}>Оборот ₴</th>}<th style={th}>Менеджер зараз</th>
          <th style={th}>Постійний</th><th style={th}>Зараз</th><th style={th}>Ритм</th>{wide && <th style={th}>Позначка</th>}
        </tr></thead>
        <tbody>
          {rows.map((c) => {
            const g = groupOf(c), st = c.state ? STATE[c.state] : undefined;
            return (
              <tr key={c.clientKey}>
                <td style={td}>{c.name}</td>
                <td style={{ ...td, whiteSpace: "nowrap" }}><a href={c.firstDealUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>#{c.firstDealId} ↗</a> · {dmy(c.firstDay)}</td>
                {showHanded && <td style={td}>{c.handedBy}</td>}
                <td style={num}>{nf(c.deals)}</td><td style={num}>{nf(c.ltv)}</td>
                {wide && <td style={{ ...num, color: MUTED }}>{nf(c.turnover)}</td>}
                <td style={td}>{c.ownerName ?? <span style={{ color: MUTED }}>не визначено</span>}</td>
                <td style={{ ...td, whiteSpace: "nowrap" }}>{c.deals >= 2
                  ? <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}><span style={{ width: 8, height: 8, borderRadius: 3, background: GROUP[g].color }} />так</span>
                  : <span style={{ color: MUTED }}>разовий</span>}</td>
                <td style={td}>{st
                  ? <span style={{ fontSize: 11.5, fontWeight: 600, padding: "2px 9px", borderRadius: 999, background: st.bg, color: st.fg, whiteSpace: "nowrap" }}>{st.label}</span>
                  : <span style={{ color: MUTED, fontSize: 12.5 }}>стан невідомий</span>}</td>
                <td style={{ ...td, color: MUTED, fontSize: 12.5 }}>{c.segment ? SEGMENT[c.segment] ?? c.segment : "—"}</td>
                {wide && <td style={{ ...td, color: MUTED, fontSize: 12.5 }}>{c.marks.includes("merged") ? "обʼєднано" : "—"}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { fetchAdsClients, type AdsClient, type AdsClientsAgg, type AdsClientsReport, type LtvGroup } from "../../../api";
import { todayKyiv } from "../periodRules";
import { MixBar } from "./LeadgenLtvBlock";
import { TH, TH_L, TD, TD_L, LAB, DIM, CARD, money, dayLabel, campKey, wrapName } from "./adsUi";
import { AdsClientsList } from "./AdsClientsList";

/**
 * 👥 КЛІЄНТИ З РЕКЛАМИ: LTV, ПОСТІЙНІ, ПОВТОРНІ ЗАМОВЛЕННЯ (задачі #8709, #8704).
 *
 *  • Зустріч 09.11.2026 (Сергій): «LTV по постійних клієнтах починаючи з Нового року… окрема вкладка… скільки з
 *    реклами ми отримали VIP, епізодичних». Зустріч 12.11.2026: «скільки постійних дали повторних замовлень, скільки
 *    ми з них заробляємо далі — як історія з лідгенами»; Олександр: «скільки разів у середньому замовляє постійний».
 *    Тому вкладка повторює блок «LTV клієнтів лідогенерації» (плитки, склад на 4 групи тим самим `MixBar`, когорти,
 *    список із фільтрами), а від реклами додає «заробили на повторних».
 *  • Клієнт з реклами — заплатив хоч раз після першого рекламного ліда. Постійний — 2+ успішні угоди (правило ядра,
 *    рішення Романа 11.11), «працює зараз» — стан «активний» ядра. Тип — ВІП / регулярний / епізодичний ядра;
 *    «сезонний» — після ручної позначки (окрема задача, Роман 16.11: поки без нього).
 *  • Клієнт належить кампанії ПЕРШОГО свого рекламного ліда; усі його угоди далі (і ручні) — LTV цієї кампанії.
 *  • Вікно — «Весь час» з 01.01.2026 або обраний зверху період (відбір за датою першого ліда; LTV — до сьогодні).
 */
const ALL_FROM = "2026-01-01";
const nf = (v: number) => v.toLocaleString("uk-UA");
const pct = (a: number, n: number) => (n > 0 ? `${Math.round((a / n) * 100)}%` : "—");
const per = (a: number, n: number) => (n > 0 ? (a / n).toLocaleString("uk-UA", { maximumFractionDigits: 1 }) : "—");
const avg = (a: number, n: number) => (n > 0 ? `${money(a / n)} ₴` : "—");
const MONTHS = ["січ", "лют", "бер", "кві", "тра", "чер", "лип", "сер", "вер", "жов", "лис", "гру"];
const ymLabel = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const SUB: React.CSSProperties = { ...DIM, fontSize: 11.5, marginTop: 2 };

const GROUP: Record<LtvGroup, { color: string; label: string }> = {
  rw: { color: "#15803d", label: "постійні, працюють" },
  rs: { color: "#d97706", label: "постійні, зараз не замовляють" },
  ow: { color: "#9fd5b2", label: "разові, працюють" },
  os: { color: "#dedcd8", label: "разові, не працюють" },
};
const GROUPS: LtvGroup[] = ["rw", "rs", "ow", "os"];
const SEG: Record<AdsClient["segment"], { label: string; color: string }> = {
  vip: { label: "⚡ ВІП", color: "var(--rpt-ok, #1a7f4b)" },
  regular: { label: "🔁 Регулярний", color: "var(--rpt-link, #2563eb)" },
  episodic: { label: "🌙 Епізодичний", color: "var(--rpt-warn, #a06a08)" },
  unknown: { label: "ще без типу", color: "var(--rpt-muted, #8a8f98)" },
};
type SortKey = "margin" | "clients" | "avg" | "regular" | "active" | "repeat" | "deals";
const SORT: Record<SortKey, (a: AdsClientsAgg) => number> = {
  margin: (a) => a.margin, clients: (a) => a.clients, avg: (a) => (a.clients ? a.margin / a.clients : -1),
  regular: (a) => a.regular, active: (a) => a.active, repeat: (a) => a.repeatMargin, deals: (a) => (a.clients ? a.deals / a.clients : -1),
};

export function AdsRegulars({ from, to }: { from: string; to: string }) {
  const [scope, setScope] = useState<"all" | "period">("all");
  const [rep, setRep] = useState<AdsClientsReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("margin");
  const [group, setGroup] = useState<LtvGroup | null>(null);
  const [allCohorts, setAllCohorts] = useState(false);

  const [qFrom, qTo] = scope === "all" ? [ALL_FROM, todayKyiv()] : [from, to];
  useEffect(() => {
    let alive = true;
    setRep(null); setErr(null); setGroup(null);
    fetchAdsClients(qFrom, qTo).then((r) => { if (alive) setRep(r); })
      .catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : "не вдалося"); });
    return () => { alive = false; };
  }, [qFrom, qTo]);

  const camps = useMemo(() => [...(rep?.campaigns ?? [])].sort((a, b) =>
    Number(a.campaign === null) - Number(b.campaign === null) || SORT[sort](b) - SORT[sort](a)), [rep, sort]);

  const seg2 = (btn: "all" | "period", label: string) => (
    <button type="button" onClick={() => setScope(btn)} aria-pressed={scope === btn}
      style={{ padding: "6px 14px", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer", border: "none",
               background: scope === btn ? "var(--rpt-ink, #16181d)" : "transparent",
               color: scope === btn ? "var(--rpt-card, #fff)" : "var(--rpt-muted, #8a8f98)" }}>{label}</button>
  );
  const scopeBar = (
    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <div style={{ display: "inline-flex", gap: 2, padding: 3, borderRadius: 10, background: "var(--rpt-card, #fff)",
                    border: "1px solid var(--rpt-line, #e8e6e3)" }}>
        {seg2("all", "Весь час · з 01.01.2026")}
        {seg2("period", `Обраний період · ${dayLabel(from)}–${dayLabel(to)}`)}
      </div>
      <span style={{ ...DIM, fontSize: 12.5 }}>
        {scope === "all" ? "клієнти, що прийшли з реклами з Нового року" : "клієнти, чий перший рекламний лід — у цьому періоді"}
        {" "}· LTV — маржа від першого ліда до сьогодні
      </span>
    </div>
  );
  if (err) return <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>{scopeBar}
    <div style={{ ...CARD, padding: "18px 20px", color: "var(--rpt-bad, #b4231d)" }}>Помилка: {err}</div></div>;
  if (!rep) return <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>{scopeBar}
    <div style={{ ...CARD, padding: "18px 20px", ...DIM }}>Завантаження…</div></div>;

  const t = rep.totals;
  const noType = t.regular - t.vip - t.regularSeg - t.episodic;
  const cohorts = allCohorts ? rep.cohorts : rep.cohorts.slice(-12);
  const typeMargin = (k: AdsClient["segment"]) => rep.clients.filter((c) => c.qualified && c.segment === k).reduce((s, c) => s + c.margin, 0);
  const typeCount = (k: AdsClient["segment"]) => rep.clients.filter((c) => c.qualified && c.segment === k).length;

  const tile = (value: React.ReactNode, label: string, sub?: React.ReactNode, accent = false) => (
    <div style={{ ...CARD, padding: "16px 18px", ...(accent ? { borderColor: "var(--rpt-ink, #16181d)" } : {}) }}>
      <div style={{ ...LAB, ...(accent ? { color: "var(--rpt-ink, #16181d)" } : {}) }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-.8px", marginTop: 6, lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ ...DIM, fontSize: 12, marginTop: 6 }}>{sub}</div>}
    </div>
  );
  const sortTh = (k: SortKey, label: string, title?: string) => (
    <th style={{ ...TH, cursor: "pointer", color: sort === k ? "var(--rpt-ink, #16181d)" : TH.color }} title={title}
        onClick={() => setSort(k)} aria-sort={sort === k ? "descending" : "none"}>{label}{sort === k ? " ↓" : ""}</th>
  );
  const aggCells = (a: AdsClientsAgg) => <>
    <td style={TD}>{nf(a.clients)}</td>
    <td style={TD}><b>{money(a.margin)} ₴</b></td>
    <td style={TD}>{avg(a.margin, a.clients)}</td>
    <td style={TD}>{nf(a.regular)}<div style={SUB}>{pct(a.regular, a.clients)}</div></td>
    <td style={TD}><span style={{ color: "var(--rpt-ok, #1a7f4b)" }}>{nf(a.active)}</span><div style={SUB}>{pct(a.active, a.clients)}</div></td>
    <td style={TD}>{per(a.deals, a.clients)}</td>
    <td style={TD}>{money(a.repeatMargin)} ₴<div style={SUB}>{pct(a.repeatMargin, a.margin)} LTV</div></td>
  </>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {scopeBar}

      {/* Плитки — як у блоці «LTV клієнтів лідогенерації». */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12 }}>
        {tile(nf(t.clients), "Клієнтів з реклами", "заплатили хоча б раз")}
        {tile(`${money(t.margin)} ₴`, "LTV разом, маржа", "і з повторних, і з ручних угод")}
        {tile(avg(t.margin, t.clients), "Середній LTV клієнта")}
        {tile(<>{nf(t.regular)} <span style={{ fontSize: 15, color: "var(--rpt-muted, #8a8f98)" }}>· {pct(t.regular, t.clients)}</span></>,
          "Стали постійними", "2+ успішні угоди")}
        {tile(<span style={{ color: "var(--rpt-ok, #1a7f4b)" }}>{nf(t.active)} <span style={{ fontSize: 15 }}>· {pct(t.active, t.clients)}</span></span>,
          "Працюють зараз", "стан «активний» у «Клієнтах»")}
        {tile(per(t.deals, t.clients), "Угод на клієнта", `у постійного — ${per(t.regularDeals, t.regular)}`)}
      </div>

      {/* 🔁 Повторні замовлення — головне з зустрічі 12.11. */}
      <div style={{ ...CARD, padding: "18px 20px", borderColor: "var(--rpt-ink, #16181d)" }}>
        <div style={{ ...LAB, color: "var(--rpt-ink, #16181d)" }}>Що дали постійні після першого замовлення</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 18, marginTop: 12 }}>
          <div>
            <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: "-1px", color: "var(--rpt-ok, #1a7f4b)" }}>{money(t.repeatMargin)} ₴</div>
            <div style={{ ...DIM, fontSize: 12.5, marginTop: 4 }}>заробили на <b style={{ color: "var(--rpt-ink, #16181d)" }}>повторних замовленнях</b> · {pct(t.repeatMargin, t.margin)} усього LTV</div>
          </div>
          <div>
            <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: "-1px" }}>{per(t.regularDeals, t.regular)} <span style={{ fontSize: 16, fontWeight: 600 }}>разів</span></div>
            <div style={{ ...DIM, fontSize: 12.5, marginTop: 4 }}>у середньому замовляє <b style={{ color: "var(--rpt-ink, #16181d)" }}>постійний клієнт</b> з реклами</div>
          </div>
          <div>
            <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: "-1px" }}>{avg(t.regularMargin, t.regular)}</div>
            <div style={{ ...DIM, fontSize: 12.5, marginTop: 4 }}><b style={{ color: "var(--rpt-ink, #16181d)" }}>LTV постійного</b> · разом {money(t.regularMargin)} ₴</div>
          </div>
        </div>
      </div>

      {/* Склад на 4 групи — той самий `MixBar`, що в лідгенів; клік показує клієнтів групи. */}
      {t.clients > 0 && (
        <div style={{ ...CARD, padding: "16px 20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
            <div style={LAB}>Склад {nf(t.clients)} клієнтів</div>
            <span style={{ ...DIM, fontSize: 12.5 }}>клік по групі показує її клієнтів у списку нижче</span>
          </div>
          <MixBar mix={t.mix} height={14} pick={(g) => setGroup((x) => (x === g ? null : g))} selected={group} />
          <div style={{ marginTop: 10, fontSize: 13, display: "flex", flexWrap: "wrap", gap: "4px 6px" }}>
            {GROUPS.map((g) => (
              <button key={g} type="button" onClick={() => setGroup((x) => (x === g ? null : g))} aria-pressed={group === g}
                style={{ border: `1px solid ${group === g ? "var(--rpt-ink, #16181d)" : "transparent"}`, background: group === g ? "var(--rpt-card, #fff)" : "none",
                         borderRadius: 999, padding: "3px 10px", cursor: "pointer", display: "inline-flex", gap: 6, alignItems: "center",
                         fontFamily: "inherit", fontSize: 13, color: "inherit" }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: GROUP[g].color }} />
                <b>{nf(t.mix[g])}</b> <span style={DIM}>{GROUP[g].label}</span>
              </button>
            ))}
          </div>
          {t.mix.rs > 0 && (
            <div style={{ marginTop: 10, fontSize: 13, padding: "8px 12px", borderRadius: 8, background: "var(--rpt-warn-bg, #fdf2e0)",
                          color: "var(--rpt-warn, #a06a08)", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <span><b>{nf(t.mix.rs)} постійних клієнтів з реклами</b> зараз не замовляють — їх варто повертати першими.</span>
              {group !== "rs" && <button type="button" onClick={() => setGroup("rs")}
                style={{ all: "unset", cursor: "pointer", color: "var(--rpt-link, #2563eb)", fontWeight: 600 }}>Показати →</button>}
            </div>
          )}
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginTop: 12, fontSize: 13 }}>
            <span style={DIM}>Постійні за типом:</span>
            {(["vip", "regular", "episodic"] as const).map((k) => (
              <span key={k}><span style={{ color: SEG[k].color, fontWeight: 600 }}>{SEG[k].label}</span> <b>{nf(typeCount(k))}</b>
                <span style={DIM}> · LTV {typeCount(k) ? `${money(typeMargin(k) / typeCount(k))} ₴` : "—"}</span></span>
            ))}
            <span style={DIM}>ще без типу {nf(noType)} (менше 3 оплат)</span>
          </div>
        </div>
      )}

      {/* По кампаніях — колонки як у таблиці «По лідгенах». */}
      <div style={{ ...CARD, padding: "20px 8px 8px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", padding: "0 14px 14px" }}>
          <div style={LAB}>По кампаніях · кампанія першого рекламного ліда</div>
          <div style={{ ...DIM, fontSize: 12.5 }}>клік по заголовку сортує</div>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontVariantNumeric: "tabular-nums", minWidth: 960 }}>
            <thead><tr>
              <th style={TH_L}>Кампанія</th>
              {sortTh("clients", "Клієнтів")}{sortTh("margin", "LTV разом")}{sortTh("avg", "Сер. LTV")}
              {sortTh("regular", "Стали постійними")}{sortTh("active", "Працюють зараз")}
              {sortTh("deals", "Угод на клієнта")}{sortTh("repeat", "З повторних", "Маржа угод після першої оплаченої")}
              <th style={TH_L}>Склад</th>
            </tr></thead>
            <tbody>
              {camps.map((c) => (
                <tr key={c.campaign === null ? "—" : campKey(c.campaign)} style={c.campaign === null ? { color: "var(--rpt-muted, #8a8f98)" } : undefined}>
                  <td style={{ ...TD_L, whiteSpace: "normal", maxWidth: 280 }}>
                    {c.campaign ? wrapName(c.campaign) : "Без мітки кампанії"}{c.campaign === null && <div style={SUB}>органіка, дзвінок без мітки</div>}
                  </td>
                  {aggCells(c)}
                  <td style={TD_L}><MixBar mix={c.mix} width={120} /></td>
                </tr>
              ))}
              <tr style={{ background: "var(--rpt-soft, #f6f5f3)", fontWeight: 700 }}>
                <td style={TD_L}>Разом</td>{aggCells(t)}<td style={TD_L}><MixBar mix={t.mix} width={120} /></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Когорти — місяць першого рекламного ліда, як «LTV по когортах» у лідгенів. */}
      <div style={{ ...CARD, padding: "20px 8px 8px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", padding: "0 14px 14px" }}>
          <div style={LAB}>LTV по когортах · місяць, коли клієнт прийшов з реклами</div>
          <div style={{ ...DIM, fontSize: 12.5 }}>свіжі місяці ще ростуть — клієнти не встигли повторити</div>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontVariantNumeric: "tabular-nums", minWidth: 820 }}>
            <thead><tr>
              <th style={TH_L}>Когорта</th><th style={TH}>Клієнтів</th><th style={TH}>LTV разом</th><th style={TH}>Сер. LTV</th>
              <th style={TH}>Стали постійними</th><th style={TH}>Працюють зараз</th><th style={TH}>Угод на клієнта</th><th style={TH}>З повторних</th>
            </tr></thead>
            <tbody>
              {cohorts.map((c) => <tr key={c.ym}><td style={TD_L}><b>{ymLabel(c.ym)}</b></td>{aggCells(c)}</tr>)}
            </tbody>
          </table>
        </div>
        {rep.cohorts.length > 12 && (
          <button type="button" onClick={() => setAllCohorts((x) => !x)}
            style={{ all: "unset", cursor: "pointer", color: "var(--rpt-link, #2563eb)", fontSize: 13, fontWeight: 600, padding: "10px 14px 6px" }}>
            {allCohorts ? "▴ лише останні 12 місяців" : `▸ показати всі місяці (ще ${rep.cohorts.length - 12})`}
          </button>
        )}
      </div>

      {/* Список клієнтів — дизайн варіант А з фільтрами й посиланням на Kommo (Роман 19.11.2026), `AdsClientsList.tsx`. */}
      <AdsClientsList clients={rep.clients} group={group} groupLabel={group ? GROUP[group].label : null} onClearGroup={() => setGroup(null)}
        campaigns={rep.campaigns.filter((c) => c.campaign !== null).sort((x, y) => y.clients - x.clients).map((c) => c.campaign as string)} />

      <div style={{ ...DIM, fontSize: 12, lineHeight: 1.5 }}>
        Клієнт з реклами — той, хто заплатив хоча б раз після першого рекламного ліда; належить кампанії цього ліда. LTV — маржа всіх його
        успішних угод від першого ліда до сьогодні, і не з реклами теж. «З повторних» — усе після першої оплаченої угоди. Постійний — 2+
        успішні угоди, тип і «працює зараз» — ті самі правила, що в «Клієнти та реактивація» й у блоці LTV лідгенів. «Сезонний» з'явиться
        після ручної позначки.
      </div>
    </div>
  );
}

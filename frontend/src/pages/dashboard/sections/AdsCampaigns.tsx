import { useEffect, useState } from "react";
import { fetchAds, type AdsReport } from "../../../api";
import { todayKyiv } from "../periodRules";
import { TH, TH_L, TD, TD_L, LAB, DIM, CARD, money, dayLabel, times, HINT_EARNED, campKey } from "./adsUi";

/**
 * 📊 АНАЛІТИКА КАМПАНІЙ (задача #8709, зустріч 09.11.2026: «які кампанії за весь час зʼїли найбільше грошей, скільки дали
 * зароблених, скільки прийшло постійних клієнтів, LTV, конверсія, середній чек»).
 *
 *  • Витрати й кліки — GA4; ліди й гроші — мітка кампанії в угоді (перший захід на сайт), за датою ЛІДА (#8702).
 *  • Клієнт належить кампанії ПЕРШОГО свого рекламного ліда; «постійний» і його тип (ВІП/регулярний/епізодичний) —
 *    правила ядра, ті самі, що на екрані «Клієнти та реактивація». LTV — уся маржа клієнта, і не з реклами теж:
 *    саме вона показує, що кампанія привела не одне перевезення.
 *  • «Весь час» — від 01.01.2026: раніше витрат GA4 у базі немає, і окупність без витрат порахувати нема з чого.
 * Рядок «Органіка / без мітки» стоїть завжди, щоб «Разом» сходилось із плитками.
 */
const ALL_FROM = "2026-01-01";

type Row = {
  key: string; campaign: string; channelGroup: string | null; cost: number; clicks: number;
  leads: number; earned: number; earnedDeals: number; inherited: number;
  clients: number; regular: number; vip: number; regularSeg: number; episodic: number; margin: number; regularMargin: number;
};
type SortKey = "cost" | "leads" | "conv" | "check" | "earned" | "x" | "clients" | "ltv";

const empty = (key: string, campaign: string, channelGroup: string | null): Row => ({
  key, campaign, channelGroup, cost: 0, clicks: 0, leads: 0, earned: 0, earnedDeals: 0, inherited: 0,
  clients: 0, regular: 0, vip: 0, regularSeg: 0, episodic: 0, margin: 0, regularMargin: 0,
});

/** Згортка звіту в рядки кампаній: GA4 ∪ ліди/гроші ∪ клієнти за ключем `campKey`; `null` → рядок «без мітки». */
function rowsOf(r: AdsReport): { rows: Row[]; untagged: Row } {
  const map = new Map<string, Row>();
  const untagged = empty("—", "Органіка / без мітки кампанії", null);
  const rowOf = (name: string | null, channelGroup: string | null) => {
    if (name === null) return untagged;
    const key = campKey(name);
    const row = map.get(key) ?? empty(key, name, channelGroup);
    if (!row.channelGroup && channelGroup) row.channelGroup = channelGroup;
    map.set(key, row);
    return row;
  };
  for (const c of r.campaigns) { if (c.cost > 0) { const x = rowOf(c.campaign, c.channelGroup); x.cost += c.cost; x.clicks += c.clicks; } }
  for (const l of r.campaignLeads ?? []) { const x = rowOf(l.campaign, null); x.leads += l.leads; x.earned += l.earned; x.earnedDeals += l.earnedDeals; x.inherited += l.earnedInherited ?? 0; }
  for (const k of r.campaignClients ?? []) {
    const x = rowOf(k.campaign, null);
    x.clients += k.clients; x.regular += k.regular; x.vip += k.vip; x.regularSeg += k.regularSeg; x.episodic += k.episodic;
    x.margin += k.margin; x.regularMargin += k.regularMargin;
  }
  return { rows: [...map.values()], untagged };
}

const conv = (r: Row) => (r.leads > 0 ? r.earnedDeals / r.leads : null);
const check = (r: Row) => (r.earnedDeals > 0 ? r.earned / r.earnedDeals : null);
const ltv = (r: Row) => (r.clients > 0 ? r.margin / r.clients : null);
const SORT: Record<SortKey, (r: Row) => number> = {
  cost: (r) => r.cost, leads: (r) => r.leads, conv: (r) => conv(r) ?? -1, check: (r) => check(r) ?? -1,
  earned: (r) => r.earned, x: (r) => (r.cost > 0 ? r.earned / r.cost : -1), clients: (r) => r.clients, ltv: (r) => ltv(r) ?? -1,
};
const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toLocaleString("uk-UA", { maximumFractionDigits: 1 })}%`);
const SUB: React.CSSProperties = { ...DIM, fontSize: 11.5, marginTop: 2 };

export function AdsCampaigns({ data, from, to }: { data: AdsReport; from: string; to: string }) {
  const [scope, setScope] = useState<"period" | "all">("period");
  const [allData, setAllData] = useState<AdsReport | null>(null);
  const [allErr, setAllErr] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("cost");

  // «Весь час» тягнеться окремо й один раз: важкий запит, і потрібен лише тим, хто перемкнувся.
  useEffect(() => {
    if (scope !== "all" || allData) return;
    fetchAds({ from: ALL_FROM, to: todayKyiv() }).then(setAllData).catch((e: unknown) => setAllErr(e instanceof Error ? e.message : "не вдалося"));
  }, [scope, allData]);

  const src = scope === "all" ? allData : data;
  const { rows, untagged } = src ? rowsOf(src) : { rows: [], untagged: empty("—", "", null) };
  rows.sort((a, b) => SORT[sort](b) - SORT[sort](a) || b.cost - a.cost);
  const all = [...rows, untagged];
  const tot = all.reduce((t, r) => {
    t.cost += r.cost; t.leads += r.leads; t.earned += r.earned; t.earnedDeals += r.earnedDeals; t.clicks += r.clicks; t.inherited += r.inherited;
    t.clients += r.clients; t.regular += r.regular; t.vip += r.vip; t.regularSeg += r.regularSeg; t.episodic += r.episodic;
    t.margin += r.margin; t.regularMargin += r.regularMargin;
    return t;
  }, empty("Σ", "Разом", null));
  const hasLeads = !!src?.campaignLeads;
  const hasClients = !!src?.campaignClients;
  const taggedPct = tot.earned > 0 ? Math.round(((tot.earned - untagged.earned) / tot.earned) * 100) : null;

  const seg = (btn: "period" | "all", label: string) => (
    <button type="button" onClick={() => setScope(btn)} aria-pressed={scope === btn}
      style={{ padding: "6px 14px", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer", border: "none",
               background: scope === btn ? "var(--rpt-ink, #16181d)" : "transparent",
               color: scope === btn ? "var(--rpt-card, #fff)" : "var(--rpt-muted, #8a8f98)" }}>{label}</button>
  );
  const th = (k: SortKey, label: string, title?: string) => (
    <th style={{ ...TH, cursor: "pointer", color: sort === k ? "var(--rpt-ink, #16181d)" : TH.color }} title={title}
        onClick={() => setSort(k)} aria-sort={sort === k ? "descending" : "none"}>
      {label}{sort === k ? " ↓" : ""}
    </th>
  );
  const segTitle = (r: Row) => `Постійних ${r.regular}: ⚡ ВІП ${r.vip} · 🔁 регулярні ${r.regularSeg} · 🌙 епізодичні ${r.episodic}`
    + ` · ще без типу ${r.regular - r.vip - r.regularSeg - r.episodic} (менше 3 оплат)`;

  const line = (r: Row, isUntagged = false) => {
    const share = tot.cost > 0 && r.cost > 0 ? Math.round((r.cost / tot.cost) * 100) : null;
    const x = times(r.earned, r.cost);
    return (
      <tr key={r.key} style={isUntagged ? { color: "var(--rpt-muted, #8a8f98)" } : undefined}>
        <td style={{ ...TD_L, whiteSpace: "normal", wordBreak: "break-word", maxWidth: 260, lineHeight: 1.3 }}
            title={isUntagged ? "Угоди без мітки кампанії, а також «(organic)», «(direct)», «(referral)», «(not set)»" : undefined}>
          {r.campaign}
          <div style={SUB}>{isUntagged ? "клієнти без жодної рекламної мітки" : r.cost === 0 ? "у періоді не крутилась" : r.channelGroup ?? ""}</div>
        </td>
        <td style={TD}>
          <b>{r.cost > 0 ? `${money(r.cost)} ₴` : "—"}</b>
          {r.cost > 0 && <div style={SUB}>{share}% · {r.clicks} кл · {(r.cost / Math.max(1, r.clicks)).toLocaleString("uk-UA", { maximumFractionDigits: 1 })} ₴</div>}
        </td>
        {hasLeads && <>
          <td style={TD}>{r.leads}{r.cost > 0 && r.leads > 0 && <div style={SUB}>{money(r.cost / r.leads)} ₴ / лід</div>}</td>
          <td style={TD}>{pct(conv(r))}<div style={SUB}>{r.earnedDeals} оплач.</div></td>
          <td style={TD}>{check(r) === null ? "—" : `${money(check(r)!)} ₴`}</td>
          <td style={TD}>
            <b style={{ color: r.earned > 0 ? "var(--rpt-ok, #1a7f4b)" : undefined }}>{money(r.earned)} ₴</b>
            {x && <div style={{ ...SUB, fontWeight: 700, color: r.earned >= r.cost ? "var(--rpt-ok, #1a7f4b)" : "var(--rpt-bad, #b4231d)" }}>{x}</div>}
            {r.inherited > 0 && <div style={SUB} title="Угоди без мітки, які менеджер створив клієнтам, що прийшли з цієї кампанії">з них ручні угоди {money(r.inherited)} ₴</div>}
          </td>
        </>}
        {hasClients && <>
          <td style={{ ...TD, cursor: "help" }} title={segTitle(r)}>
            {r.clients}
            <div style={SUB}>постійних {r.regular}{r.clients > 0 ? ` · ${Math.round((r.regular / r.clients) * 100)}%` : ""}</div>
          </td>
          <td style={TD}>
            <b>{ltv(r) === null ? "—" : `${money(ltv(r)!)} ₴`}</b>
            {r.regular > 0 && <div style={SUB}>постійного {money(r.regularMargin / r.regular)} ₴</div>}
          </td>
        </>}
      </tr>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "inline-flex", gap: 2, padding: 3, borderRadius: 10, background: "var(--rpt-card, #fff)",
                      border: "1px solid var(--rpt-line, #e8e6e3)" }}>
          {seg("period", `Обраний період · ${dayLabel(from)}–${dayLabel(to)}`)}
          {seg("all", "Весь час · з 01.01.2026")}
        </div>
        <span style={{ ...DIM, fontSize: 12.5 }}>
          {scope === "all" ? "від 01.01.2026 — раніше витрат Google Ads у даних немає" : "той самий період, що й угорі"}
        </span>
      </div>

      {scope === "all" && !allData && (
        <div style={{ ...CARD, padding: "18px 20px", ...DIM }}>{allErr ? `Помилка: ${allErr}` : "Завантаження за весь час…"}</div>
      )}

      {src && (
        <div style={{ ...CARD, padding: "20px 8px 8px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", padding: "0 14px 14px" }}>
            <div style={LAB}>Кампанії · клік по заголовку сортує</div>
            <div style={{ ...DIM, fontSize: 12.5 }}>
              {hasLeads ? <>ліди й гроші — за міткою кампанії в угоді{taggedPct !== null && <> · з міткою {taggedPct}% заробленого</>}</>
                : "ліди й дохід по кампаніях сервер ще не віддає"}
            </div>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontVariantNumeric: "tabular-nums", minWidth: 940 }}>
              <thead>
                <tr>
                  <th style={TH_L}>Кампанія</th>
                  {th("cost", "Витрати", "Витрати з GA4 без ПДВ; під сумою — частка, кліки й ціна кліку")}
                  {hasLeads && <>
                    {th("leads", "Лідів", "Ліди з міткою кампанії, «Узято» в роботу в періоді; під числом — ціна ліда")}
                    {th("conv", "Конверсія", "Оплачені угоди ÷ ліди кампанії")}
                    {th("check", "Сер. чек", "Заробили ÷ оплачені угоди — маржа на одну угоду")}
                    {th("earned", "Заробили ліди", HINT_EARNED)}
                  </>}
                  {hasClients && <>
                    {th("clients", "Клієнтів", "Клієнти, що заплатили хоч раз і чий перший рекламний лід — з цієї кампанії; під числом — скільки стали постійними")}
                    {th("ltv", "LTV клієнта", "Уся маржа цих клієнтів за весь час ÷ кількість клієнтів")}
                  </>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => line(r))}
                {(untagged.leads > 0 || untagged.earned > 0 || untagged.clients > 0) && line(untagged, true)}
                <tr style={{ background: "var(--rpt-soft, #f6f5f3)" }}>
                  <td style={TD_L}><b>Разом</b></td>
                  <td style={TD}><b>{money(tot.cost)} ₴</b><div style={SUB}>{tot.clicks} кл</div></td>
                  {hasLeads && <>
                    <td style={TD}><b>{tot.leads}</b>{tot.leads > 0 && <div style={SUB}>{money(tot.cost / tot.leads)} ₴ / лід</div>}</td>
                    <td style={TD}><b>{pct(conv(tot))}</b><div style={SUB}>{tot.earnedDeals} оплач.</div></td>
                    <td style={TD}><b>{check(tot) === null ? "—" : `${money(check(tot)!)} ₴`}</b></td>
                    <td style={TD} title="= плитці «Заробили ліди періоду»">
                      <b style={{ color: "var(--rpt-ok, #1a7f4b)" }}>{money(tot.earned)} ₴</b>
                      <div style={{ ...SUB, fontWeight: 700 }}>{times(tot.earned, tot.cost) ?? ""}</div>
                    </td>
                  </>}
                  {hasClients && <>
                    <td style={TD}><b>{tot.clients}</b><div style={SUB}>постійних {tot.regular}</div></td>
                    <td style={TD}><b>{ltv(tot) === null ? "—" : `${money(ltv(tot)!)} ₴`}</b></td>
                  </>}
                </tr>
              </tbody>
            </table>
          </div>
          <div style={{ ...DIM, fontSize: 12, padding: "10px 14px 6px" }}>
            Кампанію бере мітка першого заходу на сайт (utm_campaign / ADV_CAMP). Угода без мітки (менеджер створив вручну) йде в кампанію, з якої
            клієнт прийшов уперше — «з них ручні угоди». Назви з Google зведені без хвоста дати й різниці «_»/пробіл. Постійні, типи й LTV з Нового
            року — вкладка «Постійні клієнти з реклами».
          </div>
        </div>
      )}
    </div>
  );
}

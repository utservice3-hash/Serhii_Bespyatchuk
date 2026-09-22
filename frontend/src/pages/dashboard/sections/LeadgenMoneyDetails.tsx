import { useEffect, useMemo, useRef, useState } from "react";
import { fetchLeadgenHandoffDeals } from "../../../api";
import type { LeadgenHandoffDeal, LeadgenHandoffDealsResp, LeadgenHandoffMoney, LeadgenDealClass } from "../../../api";
import { formatAmount, formatAmountFull } from "../format";
import { plural } from "../receivablesView";
import { ddmm } from "../periodRules";

const MUTED = "var(--text-muted)";
const LINK = "var(--lg-link)";
const n = (v: number) => v.toLocaleString("uk-UA");

/**
 * Стани — у порядку «гроші вже є → грошей не буде»; той самий порядок у кнопках і сортуванні.
 * Кольори — токени теми (у темній темі вони свої), а не зашиті hex: інакше «Програно» й посилання не читаються.
 */
const CLS: { k: LeadgenDealClass; tab: string; color: string; hint: string }[] = [
  { k: "success", tab: "Успішні", color: "var(--ok)", hint: "Угода менеджера в «Успішна угода» (142) — це й є гроші ① ядра" },
  { k: "paid", tab: "Оплачено", color: "var(--info)", hint: "Етап «Оплата отримана», угоду ще не закрито успіхом" },
  { k: "expect", tab: "Зона «Очікуємо»", color: "var(--warn)",
    hint: "Етапи зони «Очікуємо» Звіту: виставлення рахунку, авто працює, перевезення завершено, виставлено рахунок, документи отримані, очікуємо оплату. "
      + "Це знімок стану ЗАРАЗ; «Очікування оплат» грошового ядра — вужче (лише етап «Очікуємо оплату»)" },
  { k: "work", tab: "В роботі", color: MUTED,
    hint: "Відкрита угода менеджера поза зоною «Очікуємо»: у Кваліфікації або в повному циклі до «Контроль перед завантаженням». Більшість тут — «Відкладений запит»; бюджет здебільшого ще не проставлений" },
  { k: "lost", tab: "Програно", color: "var(--danger)",
    hint: "Угода менеджера закрита без реалізації (143, у Кваліфікації — «Не цільові»/«Сміття») або борг по ній списано" },
  { k: "none", tab: "Без угоди менеджера", color: MUTED, hint: "Угоди менеджера (той самий клієнт, до 2 хв після передачі) не знайшлося — гроші не прив'язати" },
  { k: "same", tab: "Та сама угода", color: MUTED, hint: "Ця передача привела в угоду, вже пораховану іншою передачею: гроші не двоїмо" },
];
const ORDER = Object.fromEntries(CLS.map((c, i) => [c.k, i])) as Record<LeadgenDealClass, number>;
const META = Object.fromEntries(CLS.map((c) => [c.k, c])) as Record<LeadgenDealClass, (typeof CLS)[number]>;
const PAGE = 12;
const NO_SALES = "— угоди менеджера немає";

type Field = [string, (m: LeadgenHandoffMoney) => number];
/** Поля підсумку, які мусять збігтися з числами рядка — УСІ, а не лише передачі й успіх. */
const FIELDS: Field[] = [
  ["передач", (m) => m.handoffs], ["без угоди менеджера", (m) => m.unlinked], ["програно", (m) => m.lost], ["у ту саму угоду", (m) => m.sameDeal],
  ...(["success", "paid", "expect", "work"] as const).flatMap((k): Field[] => [
    [`${META[k].tab}: угод`, (m) => m[k].n],
    [`${META[k].tab}: сума`, (m) => m[k].sum],
    [`${META[k].tab}: з бюджетом`, (m) => m[k].priced],
  ]),
];

/** «дд.мм», а рік — щоразу, коли він не рік періоду: закриття в січні з передачі в грудні інакше читається як минуле. */
function dayLbl(s: string, period: { from: string; to: string }) {
  const y = s.slice(0, 4);
  return y === period.from.slice(0, 4) && y === period.to.slice(0, 4) ? ddmm(s) : `${ddmm(s)}.${s.slice(2, 4)}`;
}
/**
 * Назви етапів (і Кваліфікації теж) дає бекенд (`core/stageNames.ts`); статус, якому там ще не дали
 * назви, приходить як «—» — зокрема з префіксом воронки («Кваліфікація · —»). Такий показуємо словами.
 */
const unnamedStage = (s: string | null) => !s || s === "—" || s.endsWith("· —");
/** «Михальчевська Дарина Олександрівна» → «Михальчевська Д.»: повне ім'я — у підказці. */
const shortName = (full: string) => { const p = full.trim().split(/\s+/); return p.length >= 2 ? `${p[0]} ${p[1][0]}.` : full; };

/**
 * 💰 ГРОШІ З ПЕРЕДАЧ — РОЗКРИВНИЙ СПИСОК У РЯДКУ ЛІДГЕНА (прохання 22.09.2026: «клік по лідгену →
 * список і деталі по грошах»). Кожна передача періоду → угода менеджера, що з неї виросла, і її стан ЗАРАЗ:
 * бюджет, менеджер продажу, етап, дата закриття / план оплати / причина відмови, посилання в Kommo.
 *
 * ⚓ Анкер — дата ПЕРЕДАЧІ, а не дата успіху. Тому ці гроші НЕ дорівнюють доходу з лідогену у Звіті/КВП
 * (там — за датою входу в «Успішна угода»), і це сказано в підписі, а не лише тут.
 *
 * `period` — період УЖЕ ЗАВАНТАЖЕНИХ лічильників рядка (не той, на який щойно перемкнули): так список і число
 * в рядку завжди про той самий період, і звірка між ними не бреше під час перезавантаження.
 */
export function LeadgenMoneyDetails({ period, managerId, summary }: {
  period: { from: string; to: string }; managerId: number | null; summary?: LeadgenHandoffMoney;
}) {
  // Відповідь зберігається разом із ключем запиту: у тому рендері, де вже прийшли нові числа рядка, ефект ще не
  // встиг скинути старий список — без ключа старий список на мить звірявся б із новим рядком («не збігся»).
  const key = `${period.from}|${period.to}|${managerId ?? "all"}`;
  const [loaded, setLoaded] = useState<{ key: string; r: LeadgenHandoffDealsResp } | null>(null);
  const data = loaded && loaded.key === key ? loaded.r : null;
  const [err, setErr] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [tab, setTab] = useState<LeadgenDealClass | "all">("all");
  const [sales, setSales] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);
  const topRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    setErr(false); setShown(PAGE); setSales(null); setTab("all");
    fetchLeadgenHandoffDeals({ from: period.from, to: period.to, ...(managerId != null ? { managerId } : {}) })
      .then((r) => { if (live) setLoaded({ key, r }); })
      .catch(() => { if (live) setErr(true); });
    return () => { live = false; };
  }, [key, attempt]); // eslint-disable-line react-hooks/exhaustive-deps -- key складено з period і managerId

  const bySales = useMemo(() => {
    const m = new Map<string, { name: string; n: number; success: number; successSum: number; pipe: number; pipeSum: number; work: number; lost: number }>();
    for (const d of data?.deals ?? []) {
      const name = d.salesManager ?? NO_SALES;
      const x = m.get(name) ?? { name, n: 0, success: 0, successSum: 0, pipe: 0, pipeSum: 0, work: 0, lost: 0 };
      x.n++;
      if (d.cls === "success") { x.success++; x.successSum += d.price; }
      else if (d.cls === "paid" || d.cls === "expect") { x.pipe++; x.pipeSum += d.price; }
      else if (d.cls === "work") x.work++;
      else if (d.cls === "lost") x.lost++;
      m.set(name, x);
    }
    return [...m.values()].sort((a, b) => b.successSum - a.successSum || b.n - a.n || a.name.localeCompare(b.name, "uk"));
  }, [data]);

  if (err) return (
    <Box>
      <span style={{ color: MUTED }}>Не вдалося завантажити угоди з передач. </span>
      <button type="button" onClick={() => setAttempt((a) => a + 1)} style={linkBtn}>Спробувати знову</button>
    </Box>
  );
  if (!data) return <Box><span style={{ color: MUTED }}>Завантажую угоди з передач…</span></Box>;

  const t = data.totals;
  if (t.handoffs === 0) return <Box><span style={{ color: MUTED }}>💰 За цей період передач немає — і грошей з них теж.</span></Box>;

  const diff = summary ? FIELDS.find(([, f]) => f(summary) !== f(t)) : undefined;
  // Кнопки станів рахують те, що зараз у списку: з фільтром менеджера — лише його угоди.
  const scoped = sales == null ? data.deals : data.deals.filter((d) => (d.salesManager ?? NO_SALES) === sales);
  const of = (k: LeadgenDealClass) => scoped.filter((d) => d.cls === k);
  const rows = scoped.filter((d) => tab === "all" || d.cls === tab)
    .sort((a, b) => ORDER[a.cls] - ORDER[b.cls] || b.price - a.price || b.day.localeCompare(a.day));
  // Під фільтром «без угоди менеджера» стану угоди немає за визначенням — кнопки станів там завжди нулі, їх не показуємо.
  const tabs = sales === NO_SALES ? [] : CLS.filter((c) => c.k === "success" || c.k === "expect" || c.k === "work" || c.k === "lost" || of(c.k).length > 0);

  const pickSales = (name: string) => {
    const off = sales === name;
    setSales(off ? null : name); setTab("all"); setShown(PAGE);
    // Фільтр змінює список ВИЩЕ; якщо він за межею екрана — підводимо до нього, інакше клік виглядає як «нічого».
    if (!off) requestAnimationFrame(() => {
      const top = topRef.current?.getBoundingClientRect().top;
      if (top != null && top < 0) window.scrollBy({ top: top - 12, behavior: "smooth" });
    });
  };

  return (
    <Box>
      <div ref={topRef} style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
        <b style={{ fontSize: 14 }}>💰 Гроші з переданих лідів — {n(t.handoffs)} {plural(t.handoffs, "передача", "передачі", "передач")}</b>
        <span style={{ fontSize: 12, color: MUTED }}>за датою передачі · стан угоди — зараз · сума — бюджет угоди менеджера · це не «Дохід лідогену» КВП (там — отримані кошти угод каналу «лідоген» за датою оплати)</span>
      </div>
      {diff && (
        <p style={{ margin: "0 0 8px", fontSize: 12.5, color: "var(--warn)" }}>
          ⚠ Список не збігся з числом у рядку ({diff[0]} — {n(diff[1](t))} у списку проти {n(diff[1](summary!))} у рядку): угоди в CRM змінились між двома запитами. Оновіть сторінку.
        </p>
      )}

      <div role="group" aria-label="Стан угод" style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
        <Pill on={tab === "all"} onClick={() => { setTab("all"); setShown(PAGE); }} color="var(--text)">Усі · {n(scoped.length)}</Pill>
        {tabs.map((c) => {
          const xs = of(c.k), s = xs.reduce((a, d) => a + d.price, 0), priced = xs.filter((d) => d.price).length;
          const money = c.k === "work" ? (s > 0 ? ` · бюджет у ${n(priced)}: ${formatAmount(s)}` : "")
            : c.k === "success" || c.k === "paid" || c.k === "expect" ? (s > 0 ? ` · ${formatAmount(s)}` : "") : "";
          return (
            <Pill key={c.k} on={tab === c.k} onClick={() => { setTab(c.k); setShown(PAGE); }} color={c.color} title={c.hint}>
              {c.tab} · {n(xs.length)}{money}
            </Pill>
          );
        })}
      </div>

      {sales != null && (
        <div style={{ fontSize: 12.5, marginBottom: 8 }}>
          {sales === NO_SALES ? <b>Передачі без угоди менеджера</b> : <>Менеджер продажу: <b>{sales}</b></>}{" "}
          <button type="button" onClick={() => { setSales(null); setShown(PAGE); }} style={linkBtn}>✕ зняти фільтр</button>
        </div>
      )}

      {rows.length === 0 ? (
        <p style={{ margin: "4px 0 10px", fontSize: 13, color: MUTED }}>
          {sales != null && sales !== NO_SALES && tab !== "all" ? `Менеджер ${shortName(sales)}: угод у стані ${META[tab].tab} немає.` : "У цьому стані угод немає."}
        </p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="lg-deals" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: "left" }}>Передано</th>
                <th style={{ ...th, textAlign: "left" }}>Угода · клієнт</th>
                <th style={{ ...th, textAlign: "left" }}>Менеджер продажу</th>
                <th style={{ ...th, textAlign: "left" }}>Стан зараз</th>
                <th style={th}>Бюджет</th>
                <th style={{ ...th, textAlign: "left" }}>Деталь</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, shown).map((d) => <DealRow key={d.pzId} d={d} period={period} />)}
            </tbody>
          </table>
          {rows.length > shown && (
            <button type="button" onClick={() => setShown((s) => s + PAGE * 3)} style={{ ...linkBtn, marginTop: 8 }}>
              Показати ще {n(Math.min(PAGE * 3, rows.length - shown))} з {n(rows.length - shown)}
            </button>
          )}
        </div>
      )}

      {bySales.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 4 }}>Кому передано <span style={{ fontWeight: 400, color: MUTED }}>· натисніть менеджера, щоб побачити лише його угоди</span></div>
          <div style={{ overflowX: "auto" }}>
            <table className="lg-sales" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead>
                <tr>
                  <th style={{ ...th, textAlign: "left" }}>Менеджер продажу</th>
                  <th style={th}>Передано</th><th style={th}>Успішні</th><th style={th} className="lg-opt">Оплачено / «Очікуємо»</th>
                  <th style={th} className="lg-opt">В роботі</th><th style={th} className="lg-opt">Програно</th>
                  <th style={th} className="lg-opt" title="Успішні ÷ передано. Для свіжих передач низька, бо угоди ще не закрились">Успіх</th>
                </tr>
              </thead>
              <tbody>
                {bySales.map((x) => {
                  const on = sales === x.name;
                  return (
                    <tr key={x.name} style={{ borderTop: "1px solid var(--border)", background: on ? "var(--lg-tint)" : undefined, boxShadow: on ? `inset 3px 0 0 ${LINK}` : undefined }}>
                      <td style={{ ...td, textAlign: "left" }}>
                        <button type="button" aria-pressed={on} onClick={() => pickSales(x.name)} title={x.name}
                          style={{ ...plainBtn, fontWeight: on ? 700 : 500, color: on ? (x.name === NO_SALES ? "var(--text)" : "var(--lg-link-strong)") : x.name === NO_SALES ? MUTED : LINK }}>
                          {x.name === NO_SALES ? x.name : shortName(x.name)}
                        </button>
                      </td>
                      <td style={td}>{n(x.n)}</td>
                      <td style={{ ...td, color: x.success ? "var(--ok)" : MUTED }}>{x.success ? `${n(x.success)} · ${formatAmount(x.successSum)}` : "—"}</td>
                      <td className="lg-opt" style={{ ...td, color: x.pipe ? "var(--warn)" : MUTED }}>{x.pipe ? `${n(x.pipe)} · ${formatAmount(x.pipeSum)}` : "—"}</td>
                      <td className="lg-opt" style={td}>{x.work ? n(x.work) : "—"}</td>
                      <td className="lg-opt" style={td}>{x.lost ? n(x.lost) : "—"}</td>
                      <td className="lg-opt" style={td}>{x.name === NO_SALES ? "—" : `${Math.round((x.success / x.n) * 100)} %`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Box>
  );
}

function DealRow({ d, period }: { d: LeadgenHandoffDeal; period: { from: string; to: string } }) {
  const m = META[d.cls];
  const detail =
    d.cls === "success" ? (d.closedDay ? `закрито ${dayLbl(d.closedDay, period)}` : "")
    : d.cls === "expect" || d.cls === "paid" ? (d.planPayDay ? `план оплати ${dayLbl(d.planPayDay, period)}` : "")
    : d.cls === "lost" ? `${d.reason ?? "причину не вказано"}${d.closedDay ? ` · ${dayLbl(d.closedDay, period)}` : ""}`
    : d.cls === "none" ? "посилання — на угоду лідгена в Продзвоні"
    : d.cls === "same" ? "гроші пораховано в іншій передачі"
    : "";
  const hasMoney = d.cls !== "none" && d.cls !== "same" && d.cls !== "lost";
  const title = d.route ?? "угода без назви";
  return (
    <tr style={{ borderTop: "1px solid var(--border)" }}>
      <td style={{ ...td, textAlign: "left" }}>{dayLbl(d.day, period)}</td>
      <td style={{ ...td, textAlign: "left", whiteSpace: "normal", overflowWrap: "anywhere", minWidth: 160, maxWidth: 280 }}>
        {d.url
          ? <a href={d.url} target="_blank" rel="noreferrer" style={{ fontWeight: 600, color: LINK }}
              title={d.cls === "none" ? "Відкрити угоду лідгена в Продзвоні (Kommo)" : "Відкрити угоду менеджера в Kommo"}>{title} ↗</a>
          : <span style={{ fontWeight: 600 }}>{title}</span>}
        {d.client && <div style={{ fontSize: 11.5, color: MUTED }}>{d.client}</div>}
      </td>
      <td style={{ ...td, textAlign: "left", color: d.salesManager ? undefined : MUTED }} title={d.salesManager ?? undefined}>{d.salesManager ? shortName(d.salesManager) : "—"}</td>
      <td style={{ ...td, textAlign: "left", whiteSpace: "normal", minWidth: 120, maxWidth: 190 }} title={m.hint}>
        <span aria-hidden="true" style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: m.color, marginRight: 6 }} />
        {d.cls === "none" || d.cls === "same" ? m.tab
          : unnamedStage(d.stage) ? <span style={{ color: MUTED }} title="Статус угоди є в Kommo, але в дашборді йому ще не дали назви">етап без назви в дашборді</span>
          : d.stage}
      </td>
      <td style={{ ...td, fontWeight: hasMoney && d.price ? 700 : 400, color: hasMoney && d.price ? undefined : MUTED }}>
        {d.price ? formatAmountFull(d.price) : hasMoney ? "не проставлено" : "—"}
      </td>
      <td style={{ ...td, textAlign: "left", color: MUTED, whiteSpace: "normal", minWidth: 110, maxWidth: 220 }}>{detail}</td>
    </tr>
  );
}

function Box({ children }: { children: React.ReactNode }) {
  // Фон — картковий (білий), а не --bg: на --bg приглушений текст давав 4,36:1 — нижче 4,5.
  return <div style={{ margin: "0 0 14px", padding: "10px 12px", borderRadius: 10, background: "var(--card-bg)", border: "1px solid var(--border)" }}>{children}</div>;
}
/** Кнопка-перемикач стану (aria-pressed), а не role=tab: повного патерну вкладок (стрілки, tabpanel) тут немає. */
function Pill({ on, onClick, color, title, children }: { on: boolean; onClick: () => void; color: string; title?: string; children: React.ReactNode }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} title={title}
      style={{ border: `1px solid ${on ? color : "var(--border)"}`, background: on ? "var(--card-bg)" : "transparent", color: "var(--text)",
        boxShadow: on ? `inset 0 -2px 0 ${color}` : undefined,
        borderRadius: 20, padding: "4px 11px", fontSize: 12.5, fontWeight: on ? 700 : 500, cursor: "pointer", fontVariantNumeric: "tabular-nums" }}>
      {children}
    </button>
  );
}
const th: React.CSSProperties = { padding: "6px 8px", textAlign: "right", whiteSpace: "nowrap", fontWeight: 600, fontSize: 12, color: MUTED };
const td: React.CSSProperties = { padding: "6px 8px", textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", verticalAlign: "top" };
const linkBtn: React.CSSProperties = { border: 0, background: "transparent", padding: 0, color: LINK, fontWeight: 600, fontSize: 12.5, cursor: "pointer" };
/** Без `all: unset` — він знімає і кільце фокусу; тут лишається стандартне :focus-visible браузера. */
const plainBtn: React.CSSProperties = { border: 0, background: "transparent", padding: 0, font: "inherit", textAlign: "left", cursor: "pointer" };

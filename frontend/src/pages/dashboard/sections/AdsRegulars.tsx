import { useEffect, useState } from "react";
import { fetchAdsClients, type AdsClientsReport, type AdsRegularClient } from "../../../api";
import { todayKyiv } from "../periodRules";
import { TH, TH_L, TD, TD_L, LAB, DIM, CARD, money, dayLabel, campKey } from "./adsUi";

/**
 * 👥 ПОСТІЙНІ КЛІЄНТИ З РЕКЛАМИ (задача #8709; зустріч 09.11.2026, Сергій: «LTV по постійних клієнтах починаючи з Нового
 * року… окрема вкладка… скільки з реклами ми отримали VIP, епізодичних і сезонних»).
 *
 *  • Постійний — правило ЯДРА: 2+ успішні угоди (`QUALIFY_MIN_PAYMENTS`, рішення Романа 11.11 — не «2+ за місяць»).
 *    Тип — `segmentOf` ядра (медіана між оплатами): ВІП / регулярний / епізодичний; менше 3 оплат — ще без типу.
 *    «Сезонний» — ручна позначка з окремої задачі; зʼявиться тут, щойно її введуть.
 *  • Клієнт належить кампанії ПЕРШОГО свого рекламного ліда; усі його угоди далі (і створені менеджером вручну, без
 *    мітки) — гроші цієї кампанії. Саме так описав Сергій: «перший контакт — геомітка, далі надходження відносяться
 *    до цієї реклами».
 *  • Вікно — «Весь час» з 01.01.2026 (за замовчуванням, як просив Сергій) або обраний зверху період (Роман 11.11:
 *    «тут можна вибрати період?»). Період відбирає клієнтів за датою ПЕРШОГО рекламного ліда; їхня маржа (LTV) —
 *    від першого ліда до сьогодні, інакше LTV клієнта, що прийшов 31-го, був би нулем.
 */
const ALL_FROM = "2026-01-01";
const SEG: Record<AdsRegularClient["segment"], { label: string; color: string }> = {
  vip: { label: "⚡ ВІП", color: "var(--rpt-ok, #1a7f4b)" },
  regular: { label: "🔁 Регулярний", color: "var(--rpt-link, #2563eb)" },
  episodic: { label: "🌙 Епізодичний", color: "var(--rpt-warn, #a06a08)" },
  unknown: { label: "ще без типу", color: "var(--rpt-muted, #8a8f98)" },
};
const SUB: React.CSSProperties = { ...DIM, fontSize: 11.5, marginTop: 2 };
const BIGN: React.CSSProperties = { fontSize: 30, fontWeight: 800, letterSpacing: "-1px", marginTop: 8 };

export function AdsRegulars({ from, to }: { from: string; to: string }) {
  const [scope, setScope] = useState<"all" | "period">("all");
  const [rep, setRep] = useState<AdsClientsReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [seg, setSeg] = useState<AdsRegularClient["segment"] | "all">("all");
  const [showAll, setShowAll] = useState(false);

  const [qFrom, qTo] = scope === "all" ? [ALL_FROM, todayKyiv()] : [from, to];
  useEffect(() => {
    let alive = true;
    setRep(null); setErr(null);
    fetchAdsClients(qFrom, qTo).then((r) => { if (alive) setRep(r); })
      .catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : "не вдалося"); });
    return () => { alive = false; };
  }, [qFrom, qTo]);

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
        {scope === "all" ? "клієнти з першим рекламним лідом з Нового року" : "клієнти, чий перший рекламний лід — у цьому періоді"}
        {" "}· маржа — від першого ліда до сьогодні
      </span>
    </div>
  );

  if (err) return <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>{scopeBar}
    <div style={{ ...CARD, padding: "18px 20px", color: "var(--rpt-bad, #b4231d)" }}>Помилка: {err}</div></div>;
  if (!rep) return <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>{scopeBar}
    <div style={{ ...CARD, padding: "18px 20px", ...DIM }}>Завантаження…</div></div>;

  const regs = rep.regulars;
  const regMargin = regs.reduce((s, r) => s + r.margin, 0);
  const count = (k: AdsRegularClient["segment"]) => regs.filter((r) => r.segment === k).length;
  const marginOf = (k: AdsRegularClient["segment"]) => regs.filter((r) => r.segment === k).reduce((s, r) => s + r.margin, 0);
  const list = regs.filter((r) => seg === "all" || r.segment === seg).sort((a, b) => b.margin - a.margin);
  const shown = showAll ? list : list.slice(0, 15);
  const camps = [...rep.campaigns].filter((c) => c.regular > 0).sort((a, b) => b.regularMargin - a.regularMargin);
  const campName = (c: string | null) => c ?? "Без мітки кампанії (органіка, дзвінок)";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {scopeBar}
      <div style={{ ...DIM, fontSize: 12.5 }}>
        Постійний — 2+ успішні угоди (правило ядра, як у «Клієнти та реактивація») · клієнт рахується за кампанією свого
        першого рекламного ліда, і всі його угоди далі — теж її
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 16 }}>
        <div style={{ ...CARD, padding: "18px 20px" }}>
          <div style={LAB}>Постійних клієнтів з реклами</div>
          <div style={BIGN}>{regs.length}</div>
          <div style={{ ...DIM, fontSize: 12.5, marginTop: 6 }}>
            із {rep.totals.clients} клієнтів з реклами, що заплатили хоч раз · {rep.totals.clients > 0 ? Math.round((regs.length / rep.totals.clients) * 100) : 0}% стали постійними
          </div>
        </div>
        <div style={{ ...CARD, padding: "18px 20px", borderColor: "var(--rpt-ink, #16181d)" }}>
          <div style={{ ...LAB, color: "var(--rpt-ink, #16181d)" }}>LTV постійного клієнта</div>
          <div style={{ ...BIGN, color: "var(--rpt-ok, #1a7f4b)" }}>{regs.length ? `${money(regMargin / regs.length)} ₴` : "—"}</div>
          <div style={{ ...DIM, fontSize: 12.5, marginTop: 6 }}>
            разом {money(regMargin)} ₴ маржі · LTV будь-якого клієнта з реклами — {rep.totals.clients ? money(rep.totals.margin / rep.totals.clients) : "—"} ₴
          </div>
        </div>
        <div style={{ ...CARD, padding: "18px 20px" }}>
          <div style={LAB}>За типом</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: "6px 14px", marginTop: 10, fontSize: 13.5, alignItems: "baseline" }}>
            {(["vip", "regular", "episodic", "unknown"] as const).map((k) => (
              <div key={k} style={{ display: "contents" }}>
                <span style={{ color: SEG[k].color, fontWeight: 600 }}>{SEG[k].label}</span>
                <b style={{ textAlign: "right" }}>{count(k)}</b>
                <span style={{ ...DIM, textAlign: "right" }}>{count(k) ? `LTV ${money(marginOf(k) / count(k))} ₴` : "—"}</span>
              </div>
            ))}
          </div>
          <div style={{ ...DIM, fontSize: 11.5, marginTop: 8 }}>«Сезонний» — після ручної позначки (окрема задача)</div>
        </div>
      </div>

      <div style={{ ...CARD, padding: "20px 8px 8px" }}>
        <div style={{ ...LAB, padding: "0 14px 14px" }}>З яких кампаній прийшли постійні</div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontVariantNumeric: "tabular-nums", minWidth: 820 }}>
            <thead>
              <tr>
                <th style={TH_L}>Кампанія першого ліда</th>
                <th style={TH}>Клієнтів</th>
                <th style={TH}>Постійних</th>
                <th style={TH}>⚡ ВІП</th>
                <th style={TH}>🔁 Регулярні</th>
                <th style={TH}>🌙 Епізодичні</th>
                <th style={TH}>Маржа постійних</th>
                <th style={TH}>LTV постійного</th>
              </tr>
            </thead>
            <tbody>
              {camps.map((c) => (
                <tr key={c.campaign === null ? "—" : campKey(c.campaign)} style={c.campaign === null ? { color: "var(--rpt-muted, #8a8f98)" } : undefined}>
                  <td style={{ ...TD_L, whiteSpace: "normal", maxWidth: 300 }}>{campName(c.campaign)}</td>
                  <td style={TD}>{c.clients}</td>
                  <td style={TD}><b>{c.regular}</b><div style={SUB}>{c.clients ? Math.round((c.regular / c.clients) * 100) : 0}%</div></td>
                  <td style={TD}>{c.vip}</td>
                  <td style={TD}>{c.regularSeg}</td>
                  <td style={TD}>{c.episodic}</td>
                  <td style={TD}><b style={{ color: "var(--rpt-ok, #1a7f4b)" }}>{money(c.regularMargin)} ₴</b></td>
                  <td style={TD}>{c.regular ? `${money(c.regularMargin / c.regular)} ₴` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ ...CARD, padding: "20px 8px 8px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", padding: "0 14px 14px" }}>
          <div style={LAB}>Список постійних · за маржею</div>
          <div style={{ display: "inline-flex", gap: 2, padding: 3, borderRadius: 10, border: "1px solid var(--rpt-line, #e8e6e3)" }}>
            {(["all", "vip", "regular", "episodic", "unknown"] as const).map((k) => (
              <button key={k} type="button" aria-pressed={seg === k} onClick={() => setSeg(k)}
                style={{ padding: "5px 11px", borderRadius: 7, fontSize: 12.5, fontWeight: 700, cursor: "pointer", border: "none",
                         background: seg === k ? "var(--rpt-ink, #16181d)" : "transparent",
                         color: seg === k ? "var(--rpt-card, #fff)" : "var(--rpt-muted, #8a8f98)" }}>
                {k === "all" ? `Усі · ${regs.length}` : `${SEG[k].label} · ${count(k)}`}
              </button>
            ))}
          </div>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontVariantNumeric: "tabular-nums", minWidth: 820 }}>
            <thead>
              <tr>
                <th style={TH_L}>Клієнт</th>
                <th style={TH_L}>Кампанія першого ліда</th>
                <th style={TH}>Перший лід</th>
                <th style={TH}>Тип</th>
                <th style={TH}>Успішних угод</th>
                <th style={TH}>Маржа</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.clientKey}>
                  <td style={{ ...TD_L, whiteSpace: "normal" }}><b>{r.name}</b></td>
                  <td style={{ ...TD_L, whiteSpace: "normal", maxWidth: 280, ...(r.campaign ? {} : DIM) }}>{campName(r.campaign)}</td>
                  <td style={TD}>{r.firstLead.slice(8)}.{r.firstLead.slice(5, 7)}</td>
                  <td style={{ ...TD, color: SEG[r.segment].color, fontWeight: 600 }}>{SEG[r.segment].label}</td>
                  <td style={TD}>{r.deals}</td>
                  <td style={TD}><b>{money(r.margin)} ₴</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {list.length > 15 && (
          <div style={{ padding: "10px 14px 6px" }}>
            <button type="button" onClick={() => setShowAll((v) => !v)}
              style={{ all: "unset", cursor: "pointer", color: "var(--rpt-link, #2563eb)", fontSize: 13, fontWeight: 600 }}>
              {showAll ? "Згорнути" : `Показати всіх · ${list.length}`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { fetchAds, fetchAdsDeals, saveAdPlan, type AdsReport, type AdsDeal } from "../../../api";

/**
 * 📣 РЕКЛАМА — день × кампанія, макет «Смуга днів» (рішення власника 09.09.2026).
 *
 * 🔴 ЧОТИРИ ПИТАННЯ, НА ЯКІ ЕКРАН ВІДПОВІДАЄ ЧИСЛАМИ. Дослівне формулювання замовника:
 * «по днях, скільки витратили грошей · скільки угод в роботі · скільки закрито ·
 * скільки взагалі ми на рекламі заробляємо». Кожне — окреме велике число вгорі.
 *
 * ⚠️ ЦЕ ПЕРЕГЛЯДАЄ РІШЕННЯ 08.09, І ПЕРЕГЛЯД СВІДОМИЙ. Тоді дохід свідомо лишили лише
 * у звіті КВП, щоб не було двох рахунків. Тепер він тут — але тим САМИМ викликом
 * (`money.receivedByChannel`), із якого КВП рахує ROMI, тож двох обчислень не зʼявилось.
 * Те саме з планом: одне джерело `core/adBudget` на обидва екрани.
 *
 * 🔴 ПІДПИСИ ТУТ — ЧАСТИНА ПРАВИЛЬНОСТІ, А НЕ ОФОРМЛЕННЯ.
 *  • «Закрито» показує `won` — грошову зону РАЗОМ із «Виставленням рахунку», тож поруч
 *    окремо стоїть «з них оплачено» (142). Одне число без другого читалось би як
 *    «гроші вже отримані», і це був би той самий клас, що «сер.чек ÷ авто».
 *  • «У роботі» — не закрита ні виграною, ні програною (означення власника 09.09.2026).
 *    Разом з «оплачено» і «втрачено» дає РІВНО «взято»; із «закрито» воно
 *    ПЕРЕТИНАЄТЬСЯ (рахунок виставлено, але угода ще жива) — складати їх не можна.
 *  • «Заробили» — гроші, ЩО НАДІЙШЛИ в періоді, від реклами будь-якого часу. Не
 *    «принесли саме ці ліди»: угода з ліда 4 липня оплатиться у серпні.
 *
 * ⚠️ АТРИБУЦІЇ «цей лід із цієї кампанії» НЕМАЄ і бути не може — мітка `gclid` у CRM
 * порожня в усіх угодах. Тому в розкритті кампанії й ліди стоять ПОРУЧ, двома блоками,
 * а не одні всередині одних; на екрані це сказано словами.
 */

/* Числа ПРАВОРУЧ — не смак: числа різної довжини, вирівняні ліворуч, неможливо
   порівнювати оком по стовпчику. */
const TH: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, letterSpacing: ".9px", textTransform: "uppercase",
  color: "var(--rpt-muted, #8a8f98)", textAlign: "right", padding: "0 14px 10px", whiteSpace: "nowrap",
};
const TH_L: React.CSSProperties = { ...TH, textAlign: "left" };
const TD: React.CSSProperties = {
  textAlign: "right", padding: "12px 14px",
  borderTop: "1px solid var(--rpt-line, #e8e6e3)", whiteSpace: "nowrap",
};
const TD_L: React.CSSProperties = { ...TD, textAlign: "left" };
const LAB: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, letterSpacing: ".9px", textTransform: "uppercase",
  color: "var(--rpt-muted, #8a8f98)",
};
const BIG: React.CSSProperties = { fontSize: 38, fontWeight: 800, letterSpacing: "-1.4px", lineHeight: 1.05, marginTop: 10 };
const UNIT: React.CSSProperties = { fontSize: 15, fontWeight: 600, color: "var(--rpt-ink-soft, #3f434b)", letterSpacing: 0 };
const DIM: React.CSSProperties = { color: "var(--rpt-muted, #8a8f98)" };
const CARD: React.CSSProperties = {
  background: "var(--rpt-card, #fff)", border: "1px solid var(--rpt-line, #e8e6e3)", borderRadius: 14,
};
const STRIP: React.CSSProperties = {
  fontSize: 12, color: "var(--rpt-muted, #8a8f98)", background: "var(--rpt-soft, #f6f5f3)",
  padding: "10px 20px", borderTop: "1px solid var(--rpt-line, #e8e6e3)",
  borderBottom: "1px solid var(--rpt-line, #e8e6e3)",
};

const money = (n: number) => n.toLocaleString("uk-UA", { maximumFractionDigits: 0 });
/** `2026-07-14` → `14.07`. Рік зайвий: період обрано зверху. */
const dayLabel = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}.${m[2]}` : iso;
};
const WD = ["нд", "пн", "вт", "ср", "чт", "пт", "сб"];
const weekday = (iso: string) => WD[new Date(`${iso}T00:00:00`).getDay()] ?? "";

const STATE: Record<AdsDeal["state"], { text: string; bg: string; fg: string }> = {
  paid: { text: "Оплачено", bg: "var(--rpt-ok-bg, #e9f5ee)", fg: "var(--rpt-ok, #1a7f4b)" },
  inWork: { text: "У роботі", bg: "var(--rpt-warn-bg, #fdf2e0)", fg: "var(--rpt-warn, #a06a08)" },
  lost: { text: "Не реалізовано", bg: "var(--rpt-bad-bg, #fdecea)", fg: "var(--rpt-bad, #b4231d)" },
};

export function AdsSection({ from, to, canEditPlan }: { from: string; to: string; canEditPlan?: boolean }) {
  const [data, setData] = useState<AdsReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [deals, setDeals] = useState<AdsDeal[] | null>(null);
  const [planDraft, setPlanDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setErr(null);
    // ⚠️ Швидкий період «Весь час» віддає ПОРОЖНІ дати, і вони не безневинні: сервер
    // отримує "", запит іде по всій історії. Та сама охорона стоїть у сусідньому
    // `LeadgenSection`; другий рубіж — `dateParam` на бекенді.
    if (!from || !to) return;
    fetchAds({ from, to })
      .then((d) => { setData(d); setOpenDay(d.days.length ? d.days[d.days.length - 1].day : null); })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : "не вдалося завантажити"));
  }, [from, to]);

  // Склад дня тягнеться ОКРЕМО і лише для розкритого: тягнути угоди всіх днів наперед
  // означало б платити за те, чого ніхто не дивиться.
  useEffect(() => {
    if (!openDay) { setDeals(null); return; }
    let alive = true;
    setDeals(null);
    fetchAdsDeals(openDay)
      .then((r) => { if (alive) setDeals(r.deals); })
      .catch(() => { if (alive) setDeals([]); });
    return () => { alive = false; };
  }, [openDay]);

  if (err) return <div className="chart-card"><p style={{ color: "var(--rpt-bad, #b4231d)" }}>Помилка: {err}</p></div>;
  if (!from || !to) return <div className="chart-card"><p>Оберіть період — «Весь час» тут не працює: рекламу показуємо по днях.</p></div>;
  if (!data) return <div className="chart-card"><p>Завантаження…</p></div>;

  const totalCost = data.days.reduce((s, d) => s + d.cost, 0);
  const totalLeads = data.days.reduce((s, d) => s + d.leads, 0);
  const totalWon = data.days.reduce((s, d) => s + d.won, 0);
  const totalPaid = data.days.reduce((s, d) => s + d.paid, 0);
  const totalInWork = data.days.reduce((s, d) => s + d.inWork, 0);
  const totalClicks = data.days.reduce((s, d) => s + d.clicks, 0);
  const maxCost = Math.max(1, ...data.days.map((d) => d.cost));
  const cpl = totalLeads > 0 ? Math.round(totalCost / totalLeads) : null;
  const wonPct = totalLeads > 0 ? Math.round((totalWon / totalLeads) * 100) : null;
  const ratio = totalCost > 0 ? data.revenue / totalCost : null;
  const planLeft = data.planMonth === null ? null : data.planMonth - totalCost;
  const openRow = data.days.find((d) => d.day === openDay) ?? null;
  const openCampaigns = openDay ? data.campaigns.filter((c) => c.day === openDay) : [];
  const paidCampaigns = openCampaigns.filter((c) => c.cost > 0);
  const freeCampaigns = openCampaigns.filter((c) => c.cost === 0);
  const freeSessions = freeCampaigns.reduce((s, c) => s + c.sessions, 0);

  const savePlan = async () => {
    if (planDraft === null || !from) return;
    const v = Number(planDraft.replace(/\s/g, "").replace(",", "."));
    if (!Number.isFinite(v) || v < 0) return;
    setSaving(true);
    try {
      await saveAdPlan(from, v);
      setData(await fetchAds({ from, to }));
      setPlanDraft(null);
    } finally { setSaving(false); }
  };

  return (
    <div className="rpt" style={{ display: "flex", flexDirection: "column", gap: 20 }}>

      {!data.ga4Configured && (
        <div style={{ ...CARD, padding: "14px 20px", borderLeft: "3px solid var(--rpt-warn, #a06a08)" }}>
          ⚠️ GA4 ще не підключено на сервері — витрати показані лише за те, що встигло
          завантажитись. Це не помилка екрана.
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 16 }}>
        <div style={{ ...CARD, padding: "20px 22px" }}>
          <div style={LAB}>Витратили</div>
          <div style={BIG}>{money(totalCost)} <span style={UNIT}>₴</span></div>
          <div style={{ ...DIM, fontSize: 12.5, marginTop: 8 }}>
            {data.planMonth === null
              ? "плану на цей місяць не задано"
              : <>з плану {money(data.planMonth)} ₴ ·{" "}
                  <b style={{ color: planLeft! < 0 ? "var(--rpt-bad, #b4231d)" : "var(--rpt-ink, #16181d)" }}>
                    {planLeft! < 0 ? `перевитрата ${money(-planLeft!)} ₴` : `лишилось ${money(planLeft!)} ₴`}
                  </b></>}
            {canEditPlan && (
              <> · <button onClick={() => setPlanDraft(data.planMonth === null ? "" : String(data.planMonth))}
                style={{ border: "none", background: "transparent", color: "var(--rpt-link, #2563eb)",
                         cursor: "pointer", padding: 0, font: "inherit", fontWeight: 600 }}>змінити</button></>
            )}
          </div>
          {planDraft !== null && (
            <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
              <input value={planDraft} onChange={(e) => setPlanDraft(e.target.value)} autoFocus
                placeholder="на місяць, без ПДВ"
                style={{ width: 160, padding: "7px 10px", borderRadius: 8, fontSize: 14,
                         border: "1px solid var(--rpt-line, #e8e6e3)" }} />
              <button onClick={savePlan} disabled={saving}
                style={{ padding: "7px 14px", borderRadius: 8, fontSize: 13, fontWeight: 600, border: "none",
                         background: "var(--rpt-ink, #16181d)", color: "#fff", cursor: "pointer" }}>
                {saving ? "…" : "Зберегти"}
              </button>
              <button onClick={() => setPlanDraft(null)}
                style={{ padding: "7px 10px", borderRadius: 8, fontSize: 13, background: "transparent",
                         border: "1px solid var(--rpt-line, #e8e6e3)", cursor: "pointer" }}>Скасувати</button>
            </div>
          )}
        </div>

        <div style={{ ...CARD, padding: "20px 22px" }}>
          <div style={LAB}>Угод у роботі</div>
          <div style={BIG}>{totalInWork}</div>
          <div style={{ ...DIM, fontSize: 12.5, marginTop: 8 }}>
            із {totalLeads} узятих · не закриті ні виграною, ні програною
          </div>
        </div>

        <div style={{ ...CARD, padding: "20px 22px" }}>
          <div style={LAB}>Закрито</div>
          <div style={BIG}>{totalWon}{wonPct !== null && <span style={UNIT}> · {wonPct}%</span>}</div>
          <div style={{ ...DIM, fontSize: 12.5, marginTop: 8 }}>
            дійшли до грошей, з них оплачено{" "}
            <b style={{ color: "var(--rpt-ok, #1a7f4b)" }}>{totalPaid}</b>
          </div>
        </div>

        <div style={{ ...CARD, padding: "20px 22px", borderColor: "var(--rpt-ink, #16181d)" }}>
          <div style={{ ...LAB, color: "var(--rpt-ink, #16181d)" }}>Заробили</div>
          <div style={BIG}>{money(data.revenue)} <span style={UNIT}>₴</span></div>
          <div style={{ ...DIM, fontSize: 12.5, marginTop: 8 }}>
            {ratio !== null && <>×{ratio.toFixed(1)} до витрат · </>}
            {data.revenueDeals} угод · надійшло за період
          </div>
        </div>
      </div>

      <div style={{ ...CARD, padding: "18px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, gap: 12, flexWrap: "wrap" }}>
          <div style={LAB}>Оберіть день</div>
          <div style={{ ...DIM, fontSize: 12.5 }}>
            смужка — витрати дня · ціна ліда за період {cpl === null ? "—" : `${money(cpl)} ₴`}
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {data.days.map((d) => {
            const on = d.day === openDay;
            return (
              <button key={d.day} onClick={() => setOpenDay(on ? null : d.day)}
                style={{ minWidth: 78, textAlign: "center", padding: "8px 12px", borderRadius: 10, lineHeight: 1.2,
                         border: `1px solid ${on ? "var(--rpt-ink, #16181d)" : "var(--rpt-line, #e8e6e3)"}`,
                         background: on ? "var(--rpt-ink, #16181d)" : "var(--rpt-card, #fff)",
                         color: on ? "#fff" : "var(--rpt-ink, #16181d)", cursor: "pointer" }}>
                <small style={{ display: "block", fontSize: 10.5, fontWeight: 700, letterSpacing: ".7px",
                                textTransform: "uppercase", opacity: on ? 0.7 : 1,
                                color: on ? "#fff" : "var(--rpt-muted, #8a8f98)" }}>{weekday(d.day)}</small>
                <b style={{ fontSize: 19, fontWeight: 800, letterSpacing: "-.4px" }}>{dayLabel(d.day).slice(0, 2)}</b>
                <span style={{ display: "block", fontSize: 11, marginTop: 2, opacity: on ? 0.7 : 1,
                               color: on ? "#fff" : "var(--rpt-muted, #8a8f98)" }}>{money(d.cost)} ₴</span>
                <span style={{ display: "block", height: 5, borderRadius: 999, marginTop: 8,
                               background: on ? "rgba(255,255,255,.25)" : "var(--rpt-line, #e8e6e3)" }}>
                  <span style={{ display: "block", height: "100%", borderRadius: 999,
                                 width: `${Math.round((d.cost / maxCost) * 100)}%`,
                                 background: on ? "#fff" : "var(--brand, #c5141c)" }} />
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {openRow && (
        <div style={{ ...CARD, overflow: "hidden" }}>
          <div style={{ padding: "20px 22px 16px", display: "flex", alignItems: "baseline",
                        justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
            <div>
              <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-.5px" }}>
                {dayLabel(openRow.day)} · {weekday(openRow.day)}
              </div>
              <div style={{ ...DIM, fontSize: 12.5, marginTop: 2 }}>
                {openRow.clicks} кліків · {openRow.sessions} сесій · {openCampaigns.length} джерел
              </div>
            </div>
            <div style={{ display: "flex", gap: 28, textAlign: "right" }}>
              <div><div style={LAB}>Витрачено</div>
                <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-.5px", marginTop: 4 }}>{money(openRow.cost)} ₴</div></div>
              <div><div style={LAB}>Узято</div>
                <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-.5px", marginTop: 4 }}>{openRow.leads}</div></div>
              <div><div style={LAB}>Закрито</div>
                <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-.5px", marginTop: 4,
                              color: "var(--rpt-ok, #1a7f4b)" }}>{openRow.won}</div></div>
            </div>
          </div>

          <div style={STRIP}>Куди пішли гроші цього дня</div>
          <div style={{ padding: "16px 22px", display: "flex", flexDirection: "column", gap: 12 }}>
            {paidCampaigns.length === 0 && <div style={DIM}>Цього дня платних показів не було.</div>}
            {paidCampaigns.map((c) => (
              <div key={`${c.campaign}-${c.channelGroup ?? ""}`} style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <div style={{ flexGrow: 1, fontSize: 14 }}>
                  {c.campaign}
                  <span style={{ ...DIM, fontSize: 11 }}> · {c.channelGroup || "канал не вказано"}</span>
                </div>
                <div style={{ width: 220, height: 5, borderRadius: 999, background: "var(--rpt-line, #e8e6e3)" }}>
                  <div style={{ height: "100%", borderRadius: 999, background: "var(--brand, #c5141c)",
                                width: `${Math.round((c.cost / Math.max(1, openRow.cost)) * 100)}%` }} />
                </div>
                <div style={{ ...DIM, width: 70, textAlign: "right", fontSize: 12.5 }}>{c.clicks} кл.</div>
                <div style={{ width: 90, textAlign: "right", fontWeight: 700 }}>{money(c.cost)} ₴</div>
              </div>
            ))}
            {freeCampaigns.length > 0 && (
              <div style={{ ...DIM, fontSize: 12.5, paddingTop: 4, borderTop: "1px solid var(--rpt-line, #e8e6e3)" }}>
                Органіка та прямі заходи — {freeCampaigns.length} джерел, {freeSessions} сесій, 0 ₴
              </div>
            )}
          </div>

          <div style={{ ...STRIP, display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <span>Ліди цього дня в CRM · {openRow.leads}</span>
            <span>клік відкриває угоду в Kommo · звʼязати лід із кампанією неможливо: мітка gclid порожня</span>
          </div>
          <div style={{ padding: "14px 22px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
            {deals === null && <div style={DIM}>Завантаження…</div>}
            {deals !== null && deals.length === 0 && <div style={DIM}>Цього дня платних лідів не було.</div>}
            {deals?.map((d) => {
              const st = STATE[d.state];
              return (
                <div key={d.kommoId} style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 14 }}>
                  <div style={{ flexGrow: 1 }}>
                    <a href={d.url} target="_blank" rel="noreferrer"
                       style={{ color: "var(--rpt-link, #2563eb)", textDecoration: "none" }}>{d.name}</a>
                  </div>
                  <div style={{ width: 190 }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700,
                                   padding: "4px 11px", borderRadius: 999, background: st.bg, color: st.fg,
                                   whiteSpace: "nowrap" }}>
                      <span style={{ width: 7, height: 7, borderRadius: "50%", background: st.fg, flex: "none" }} />
                      {st.text}
                    </span>
                  </div>
                  <div style={{ width: 90, textAlign: "right", fontWeight: 700 }}>{money(d.price)} ₴</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div style={{ ...CARD, padding: "20px 8px 8px" }}>
        <div style={{ ...LAB, padding: "0 14px 14px" }}>Весь період</div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontVariantNumeric: "tabular-nums", minWidth: 760 }}>
            <thead>
              <tr>
                <th style={TH_L}>День</th>
                <th style={TH}>Витрати</th>
                <th style={TH}>Таблиця</th>
                <th style={TH}>Кліки</th>
                <th style={TH}>Узято</th>
                <th style={TH}>У роботі</th>
                <th style={TH}>Закрито</th>
                <th style={TH}>Оплачено</th>
              </tr>
            </thead>
            <tbody>
              {data.days.map((d) => (
                <tr key={d.day} onClick={() => setOpenDay(d.day)}
                    style={{ cursor: "pointer",
                             background: d.day === openDay ? "var(--rpt-tint, rgba(197,20,28,.05))" : undefined }}>
                  <td style={TD_L}>{dayLabel(d.day)} <span style={DIM}>{weekday(d.day)}</span></td>
                  <td style={TD}><b>{money(d.cost)} ₴</b></td>
                  <td style={TD}>{d.sheetCost === null ? <span style={DIM}>немає в аркуші</span> : `${money(d.sheetCost)} ₴`}</td>
                  <td style={TD}>{d.clicks}</td>
                  <td style={TD}>{d.leads}</td>
                  <td style={{ ...TD, color: "var(--rpt-warn, #a06a08)" }}>{d.inWork}</td>
                  <td style={TD}>{d.won}</td>
                  <td style={{ ...TD, color: "var(--rpt-ok, #1a7f4b)", fontWeight: 700 }}>{d.paid}</td>
                </tr>
              ))}
              <tr style={{ background: "var(--rpt-soft, #f6f5f3)" }}>
                <td style={TD_L}><b>Разом</b></td>
                <td style={TD}><b>{money(totalCost)} ₴</b></td>
                <td style={TD} />
                <td style={TD}><b>{totalClicks}</b></td>
                <td style={TD}><b>{totalLeads}</b></td>
                <td style={{ ...TD, color: "var(--rpt-warn, #a06a08)" }}><b>{totalInWork}</b></td>
                <td style={TD}><b>{totalWon}</b></td>
                <td style={{ ...TD, color: "var(--rpt-ok, #1a7f4b)" }}><b>{totalPaid}</b></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

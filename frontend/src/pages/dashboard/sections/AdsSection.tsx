import { useEffect, useState } from "react";
import { TH, TH_L, TD, TD_L, LAB, BIG, UNIT, DIM, CARD, STRIP, money, dayLabel, times, HINT_EARNED } from "./adsUi";
import { AdsCampaigns } from "./AdsCampaigns";
import { AdsRegulars } from "./AdsRegulars";
import { fetchAds, fetchAdsDeals, saveAdPlan, type AdsReport, type AdsDeal, type AdsReceivedDeal, type AdsEarnedDeal } from "../../../api";

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
 *  • 📅 ПО ДНЯХ (Роман 02.11.2026: «не зрозуміло, скільки зароблено за один день») — ДВІ колонки, і їх не
 *    можна зливати: «Принесли ліди дня» — маржа оплачених (142) угод із лідів, узятих ЦЬОГО дня (окупність
 *    дня реклами; росте, поки угоди в роботі; = Σ «Оплачено» в розкритті); «Надійшло» — маржа, що зайшла
 *    ЦЬОГО дня від реклами будь-якого часу (Σ днів == плитці «Заробили»). Поруч із витратами дня має сенс
 *    лише перша — друга про касу, а не про цей день реклами.
 *
 * ⚠️ АТРИБУЦІЇ «цей лід із цієї кампанії» НЕМАЄ і бути не може — мітка `gclid` у CRM
 * порожня в усіх угодах. Тому в розкритті кампанії й ліди стоять ПОРУЧ, двома блоками,
 * а не одні всередині одних; на екрані це сказано словами.
 */

const WD = ["нд", "пн", "вт", "ср", "чт", "пт", "сб"];
const HINT_RECEIVED = "Надійшло цього дня: маржа угод із реклами, закритих або оплачених саме цього дня, хоч би коли прийшов лід. "
  + "Сума днів дорівнює плитці «Заробили». З витратами цього ж дня майже не повʼязана — угоди закриваються тижнями.";
const weekday = (iso: string) => WD[new Date(`${iso}T00:00:00`).getDay()] ?? "";

const STATE: Record<AdsDeal["state"], { text: string; bg: string; fg: string }> = {
  paid: { text: "Оплачено", bg: "var(--rpt-ok-bg, #e9f5ee)", fg: "var(--rpt-ok, #1a7f4b)" },
  inWork: { text: "У роботі", bg: "var(--rpt-warn-bg, #fdf2e0)", fg: "var(--rpt-warn, #a06a08)" },
  lost: { text: "Не реалізовано", bg: "var(--rpt-bad-bg, #fdecea)", fg: "var(--rpt-bad, #b4231d)" },
};
const RECEIVED_STATE: Record<AdsReceivedDeal["state"], string> = { success: "Успішно", paid: "Оплата отримана" };
const MONTHS = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
const monthLabel = (ym: string) => MONTHS[Number(ym.slice(5, 7)) - 1] ?? ym;
/** Частка лідів із результатом. Порожній місяць — null («—»), а не 100%. */
const ripe = (settled: number, leads: number) => (leads > 0 ? Math.round((settled / leads) * 100) : null);
/** Місяць «дозріває» ~3 місяці (Олександр, 09.11): нижче 90% позначаємо, щоб свіже число не читали як остаточне. */
const RIPE_OK = 90;

export function AdsSection({ from, to, canEditPlan }: { from: string; to: string; canEditPlan?: boolean }) {
  const [data, setData] = useState<AdsReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [deals, setDeals] = useState<AdsDeal[] | null>(null);
  // 🧾 За які угоди «Надійшло цього дня» (Роман 05.11.2026) — приходить тим самим запитом, що й склад дня.
  const [received, setReceived] = useState<AdsReceivedDeal[] | null>(null);
  const [showReceived, setShowReceived] = useState(false);
  // 💰 #8702: «Заробили ліди дня» — фільтр списку лідів дня на ті, що вже принесли гроші (Роман 10.11: угоди дня й
  // їхній дохід видно в самому дні, навіть якщо оплатились пізніше).
  const [earnedOnly, setEarnedOnly] = useState(false);
  const [earnedList, setEarnedList] = useState<AdsEarnedDeal[] | null>(null);
  // 🗂 Вкладки замість довгої стрічки (Роман 10.11): дні / окупність по місяцях / кампанії за період.
  const [view, setView] = useState<"days" | "months" | "campaigns" | "clients">("days");
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
    if (!openDay) { setDeals(null); setReceived(null); setEarnedList(null); return; }
    let alive = true;
    setDeals(null);
    setReceived(null);
    setEarnedList(null);
    fetchAdsDeals(openDay)
      .then((r) => { if (alive) { setDeals(r.deals); setReceived(r.received); setEarnedList(r.earned); } })
      .catch(() => { if (alive) { setDeals([]); setReceived([]); setEarnedList([]); } });
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
  const totalReceived = data.days.reduce((s, d) => s + d.received, 0);
  const dayEarned = (d: AdsReport["days"][number]) => d.earned ?? d.paidMargin;
  const dayEarnedDeals = (d: AdsReport["days"][number]) => d.earnedDeals ?? d.paid;
  const totalEarned = data.days.reduce((s, d) => s + dayEarned(d), 0);
  const totalEarnedDeals = data.days.reduce((s, d) => s + dayEarnedDeals(d), 0);
  const totalRipe = ripe(totalLeads - totalInWork, totalLeads);
  const periodMonths = new Set(data.days.map((d) => d.day.slice(0, 7)));
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
          <div style={LAB}>Закрито</div>
          <div style={BIG}>{totalWon}{wonPct !== null && <span style={UNIT}> · {wonPct}%</span>}</div>
          <div style={{ ...DIM, fontSize: 12.5, marginTop: 8 }}>
            із {totalLeads} узятих · оплачено{" "}
            <b style={{ color: "var(--rpt-ok, #1a7f4b)" }}>{totalPaid}</b> · у роботі{" "}
            <b style={{ color: "var(--rpt-warn, #a06a08)" }}>{totalInWork}</b>
          </div>
        </div>

        {/* 💰 #8702 — головне число екрана: скільки принесли ліди САМЕ цього періоду. Рамка — як була в «Заробили». */}
        <div title={HINT_EARNED} style={{ ...CARD, padding: "20px 22px", borderColor: "var(--rpt-ink, #16181d)" }}>
          <div style={{ ...LAB, color: "var(--rpt-ink, #16181d)" }}>Заробили ліди періоду ⓘ</div>
          <div style={{ ...BIG, color: "var(--rpt-ok, #1a7f4b)" }}>{money(totalEarned)} <span style={UNIT}>₴</span></div>
          <div style={{ ...DIM, fontSize: 12.5, marginTop: 8 }}>
            {times(totalEarned, totalCost) && <><b style={{ color: "var(--rpt-ink, #16181d)" }}>{times(totalEarned, totalCost)}</b> до витрат · </>}
            {totalEarnedDeals} угод{totalRipe !== null && totalRipe < 100 ? " · ще росте" : ""}
          </div>
          {totalRipe !== null && (
            <>
              <div style={{ height: 5, borderRadius: 999, background: "var(--rpt-line, #e8e6e3)", marginTop: 10, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${totalRipe}%`, background: "var(--rpt-ok, #1a7f4b)", borderRadius: 999 }} />
              </div>
              <div style={{ ...DIM, fontSize: 11.5, marginTop: 4 }}>
                дозріло {totalRipe}% — по {totalLeads - totalInWork} із {totalLeads} лідів уже є результат
              </div>
            </>
          )}
        </div>

        <div style={{ ...CARD, padding: "20px 22px" }}>
          <div style={LAB} title={HINT_RECEIVED}>Надійшло за період ⓘ</div>
          <div style={BIG}>{money(data.revenue)} <span style={UNIT}>₴</span></div>
          <div style={{ ...DIM, fontSize: 12.5, marginTop: 8 }}>
            {ratio !== null && <>×{ratio.toFixed(1)} до витрат · </>}
            {data.revenueDeals} угод · від лідів будь-яких місяців
          </div>
        </div>
      </div>

      {/*
        🟣 eLogist — ОКРЕМИЙ рядок, НЕ частина реклами UTS (рішення власника 27.10.2026).
        Плитки вище його більше не включають: ні в ліди, ні в «Заробили». Витрат eLogist у нас
        немає (ні GA4, ні аркуша) — тому тут лише ліди й гроші, без ціни ліда та «× до витрат»,
        і це сказано словами, щоб порожнє місце не читалось як нуль витрат.
      */}
      {data.elogist && (
        <div style={{ ...CARD, padding: "14px 20px", display: "flex", gap: 24, flexWrap: "wrap", alignItems: "baseline" }}>
          <div style={LAB}>eLogist · окремий канал</div>
          <div><b style={{ fontSize: 18 }}>{data.elogist.leads}</b> <span style={DIM}>лідів створено за період</span></div>
          <div><b style={{ fontSize: 18 }}>{money(data.elogist.revenue)} ₴</b>{" "}
            <span style={DIM}>надійшло · {data.elogist.revenueDeals} угод</span></div>
          <div style={{ ...DIM, fontSize: 12.5 }}>
            не реклама UTS і в плитки вище не входить; витрат eLogist немає в даних — ціни ліда й окупності не рахуємо
          </div>
        </div>
      )}

      {/* 🗂 Вкладки (Роман 10.11.2026): замість довгої стрічки — три окремі погляди. */}
      <div role="tablist" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {([["days", "По днях"], ["months", "Окупність по місяцях"], ["campaigns", "Кампанії"], ["clients", "Постійні клієнти з реклами"]] as const).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={view === k} onClick={() => setView(k)}
            style={{ padding: "9px 16px", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer",
                     border: `1px solid ${view === k ? "var(--rpt-ink, #16181d)" : "var(--rpt-line, #e8e6e3)"}`,
                     background: view === k ? "var(--rpt-ink, #16181d)" : "var(--rpt-card, #fff)",
                     color: view === k ? "#fff" : "var(--rpt-ink, #16181d)" }}>
            {label}
          </button>
        ))}
      </div>

      {/* 📅 #8702 — окупність по місяцях: «відкотити на 3 місяці й побачити, скільки реально принесла реклама» (Олександр). */}
      {view === "months" && !data.months?.length && (
        <div style={{ ...CARD, padding: "18px 20px", ...DIM }}>Помісячної окупності сервер ще не віддає.</div>
      )}
      {view === "months" && data.months && data.months.length > 0 && (
        <div style={{ ...CARD, padding: "20px 8px 8px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", padding: "0 14px 14px" }}>
            <div style={LAB}>Окупність по місяцях · гроші привʼязані до місяця, коли прийшов лід</div>
            <div style={{ ...DIM, fontSize: 12.5 }}>місяць «дозріває» ~3 місяці — тоді число майже остаточне</div>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontVariantNumeric: "tabular-nums", minWidth: 760 }}>
              <thead>
                <tr>
                  <th style={TH_L}>Місяць</th>
                  <th style={TH}>Витрати</th>
                  <th style={TH}>Лідів</th>
                  <th style={TH} title={HINT_EARNED}>Заробили ліди місяця ⓘ</th>
                  <th style={TH}>× до витрат</th>
                  <th style={TH}>Дозріло</th>
                  <th style={TH} title={HINT_RECEIVED}>Надійшло в місяці ⓘ</th>
                </tr>
              </thead>
              <tbody>
                {data.months.map((m) => {
                  const r = ripe(m.settled, m.leads);
                  const x = times(m.earned, m.cost);
                  return (
                    <tr key={m.month} style={{ background: periodMonths.has(m.month) ? "var(--rpt-tint, rgba(197,20,28,.05))" : undefined }}>
                      <td style={TD_L}><b>{monthLabel(m.month)}</b></td>
                      <td style={TD}>{money(m.cost)} ₴</td>
                      <td style={TD}>{m.leads}</td>
                      <td style={TD}><b style={{ color: m.earned >= m.cost ? "var(--rpt-ok, #1a7f4b)" : "var(--rpt-bad, #b4231d)" }}>{money(m.earned)} ₴</b></td>
                      <td style={TD}>
                        {x ?? "—"}
                        {r !== null && r < RIPE_OK && (
                          <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 999,
                                         background: "var(--rpt-warn-bg, #fdf2e0)", color: "var(--rpt-warn, #a06a08)" }}>дозріває</span>
                        )}
                      </td>
                      <td style={TD}>
                        {r === null ? "—" : (
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                            <span style={{ width: 70, height: 5, borderRadius: 999, background: "var(--rpt-line, #e8e6e3)", overflow: "hidden" }}>
                              <span style={{ display: "block", height: "100%", width: `${r}%`, background: "var(--rpt-ok, #1a7f4b)" }} />
                            </span>
                            {r}%
                          </span>
                        )}
                      </td>
                      <td style={{ ...TD, ...DIM }}>{money(m.received)} ₴</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ ...DIM, fontSize: 12, padding: "10px 14px 6px" }}>
            За весь час Σ «заробили ліди» = Σ «надійшло» — це ті самі гроші, лише за датою ліда, а не оплати.
          </div>
        </div>
      )}

      {/* 📊 Кампанії (#8709): витрати, ліди, конверсія, чек, заробили, клієнти й LTV — за період або за весь час. */}
      {view === "campaigns" && <AdsCampaigns data={data} from={from} to={to} />}
      {/* 👥 #8709 — постійні з реклами (окрема вкладка — Сергій 09.11): за замовчуванням з Нового року, або обраний період. */}
      {view === "clients" && <AdsRegulars from={from} to={to} />}

      {view === "days" && (<>
      {/* Один день у періоді (режим «День») — смуга з однієї кнопки нічого не вибирає; день обрано шкалою вгорі. */}
      {from !== to && <div style={{ ...CARD, padding: "18px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, gap: 12, flexWrap: "wrap" }}>
          <div style={LAB}>Оберіть день</div>
          <div style={{ ...DIM, fontSize: 12.5 }}>
            смужка — витрати дня · ціна ліда за період {cpl === null ? "—" : `${money(cpl)} ₴`}
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(78px, 1fr))", gap: 8 }}>
          {data.days.map((d) => {
            const on = d.day === openDay;
            return (
              <button key={d.day} onClick={() => setOpenDay(on ? null : d.day)}
                style={{ textAlign: "center", padding: "8px 10px", borderRadius: 10, lineHeight: 1.2,
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
      </div>}

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
              <button type="button" title={HINT_EARNED} aria-pressed={earnedOnly}
                      disabled={dayEarnedDeals(openRow) === 0} onClick={() => setEarnedOnly((v) => !v)}
                      style={{ all: "unset", textAlign: "right", cursor: dayEarnedDeals(openRow) ? "pointer" : "default" }}>
                <div style={LAB}>Заробили ліди дня ⓘ</div>
                <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-.5px", marginTop: 4,
                              color: "var(--rpt-ok, #1a7f4b)" }}>{money(dayEarned(openRow))} ₴</div>
                <div style={{ fontSize: 11.5, color: dayEarnedDeals(openRow) ? "var(--rpt-link, #2563eb)" : undefined, opacity: dayEarnedDeals(openRow) ? 1 : .6 }}>
                  {times(dayEarned(openRow), openRow.cost) ?? "без витрат"} · {dayEarnedDeals(openRow)} угод
                  {dayEarnedDeals(openRow) ? (earnedOnly ? " · усі ліди" : " · лише вони") : ""}
                </div>
              </button>
              <button type="button" title={HINT_RECEIVED} aria-expanded={showReceived}
                      disabled={openRow.receivedDeals === 0} onClick={() => setShowReceived((v) => !v)}
                      style={{ all: "unset", textAlign: "right", cursor: openRow.receivedDeals ? "pointer" : "default" }}>
                <div style={LAB}>Надійшло цього дня ⓘ</div>
                <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-.5px", marginTop: 4 }}>{money(openRow.received)} ₴</div>
                <div style={{ fontSize: 11.5, color: openRow.receivedDeals ? "var(--rpt-link, #2563eb)" : undefined, opacity: openRow.receivedDeals ? 1 : .6 }}>
                  {openRow.receivedDeals} угод · {openRow.receivedDeals ? (showReceived ? "сховати ▴" : "за які угоди ▾") : "будь-яких днів"}
                </div>
              </button>
            </div>
          </div>

          {/* 💰 Ліди ЦЬОГО дня і їхній дохід (Роман 10.11): угода, створена цього дня, лишається тут і тоді, коли
              оплатилась тижнями пізніше — поруч видно, коли прийшли гроші. Оплачені — першими. */}
          <div style={{ ...STRIP, display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <span>
              Ліди цього дня · {openRow.leads} · заробили{" "}
              <b style={{ color: "var(--rpt-ok, #1a7f4b)" }}>{money(dayEarned(openRow))} ₴</b>
              {earnedOnly && " · показано лише ті, що принесли гроші"}
            </span>
            <span>клік відкриває угоду в Kommo · гроші лишаються на дні ліда, навіть якщо оплата пізніше</span>
          </div>
          <div style={{ padding: "14px 22px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
            {deals === null && <div style={DIM}>Завантаження…</div>}
            {deals !== null && deals.length === 0 && <div style={DIM}>Цього дня платних лідів не було.</div>}
            {/* Гроші рядка — ЛИШЕ зі складу «Заробили ліди дня» (`earned`, та сама вибірка, що число дня), тож Σ зелених
                сум == числу вгорі. Угода, створена цього дня, але не в «Узято» (лід пізніше взяли в роботу), дописується в кінець. */}
            {(() => {
              const byId = new Map((earnedList ?? []).map((e) => [e.kommoId, e]));
              const rows = [
                ...(deals ?? []).map((d) => ({ d, e: byId.get(d.kommoId) ?? null })),
                ...(earnedList ?? []).filter((e) => !(deals ?? []).some((d) => d.kommoId === e.kommoId)).map((e) => ({
                  d: { kommoId: e.kommoId, name: e.name, price: e.price, state: "paid" as const, reachedMoney: true, url: e.url }, e,
                })),
              ];
              return rows
                .filter((r) => !earnedOnly || r.e)
                .sort((a, b) => (Number(!!b.e) - Number(!!a.e)) || ((b.e?.price ?? 0) - (a.e?.price ?? 0)))
                .map(({ d, e }) => {
                  const st = STATE[d.state];
                  return (
                    <div key={d.kommoId} style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 14, flexWrap: "wrap" }}>
                      <div style={{ flexGrow: 1, minWidth: 180 }}>
                        <a href={d.url} target="_blank" rel="noreferrer"
                           style={{ color: "var(--rpt-link, #2563eb)", textDecoration: "none" }}>{d.name}</a>
                        <span style={{ ...DIM, fontSize: 12 }}>
                          {e ? ` · гроші ${dayLabel(e.paidDay)}` : ""}{e?.manager ? ` · ${e.manager}` : ""}
                        </span>
                      </div>
                      <div style={{ width: 190 }}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700,
                                       padding: "4px 11px", borderRadius: 999, background: st.bg, color: st.fg, whiteSpace: "nowrap" }}>
                          <span style={{ width: 7, height: 7, borderRadius: "50%", background: st.fg, flex: "none" }} />
                          {e ? RECEIVED_STATE[e.state] : st.text}
                        </span>
                      </div>
                      <div style={{ width: 90, textAlign: "right", fontWeight: 700,
                                    color: e ? "var(--rpt-ok, #1a7f4b)" : "var(--rpt-muted, #8a8f98)" }}
                           title={!e && d.state === "paid" ? "гроші цієї угоди — у дні, коли її створили" : undefined}>
                        {e ? `${money(e.price)} ₴` : d.state === "inWork" ? "ще в роботі" : "—"}
                      </div>
                    </div>
                  );
                });
            })()}
          </div>

          {showReceived && openRow.receivedDeals > 0 && (
            <>
              <div style={{ ...STRIP, display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <span>Надійшло цього дня · {openRow.receivedDeals} угод · {money(openRow.received)} ₴</span>
                <span>гроші за угоди з реклами, закриті або оплачені цього дня; лід міг прийти будь-коли</span>
              </div>
              <div style={{ padding: "14px 22px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
                {received === null && <div style={DIM}>Завантаження…</div>}
                {received?.map((d) => (
                  <div key={d.kommoId} style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 14, flexWrap: "wrap" }}>
                    <div style={{ flexGrow: 1, minWidth: 180 }}>
                      <a href={d.url} target="_blank" rel="noreferrer"
                         style={{ color: "var(--rpt-link, #2563eb)", textDecoration: "none" }}>{d.name}</a>
                      <span style={{ ...DIM, fontSize: 12 }}> · лід {dayLabel(d.leadDay)}{d.manager ? ` · ${d.manager}` : ""}</span>
                    </div>
                    <div style={{ width: 150, fontSize: 12, fontWeight: 700, color: "var(--rpt-ok, #1a7f4b)" }}>{RECEIVED_STATE[d.state]}</div>
                    <div style={{ width: 90, textAlign: "right", fontWeight: 700 }}>{money(d.price)} ₴</div>
                  </div>
                ))}
              </div>
            </>
          )}

          <div style={{ ...STRIP, display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <span>Куди пішли гроші цього дня</span>
            <span>звʼязати лід із кампанією неможливо: мітка gclid порожня · за весь період — вкладка «Кампанії за період»</span>
          </div>
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

        </div>
      )}

      <div style={{ ...CARD, padding: "20px 8px 8px" }}>
        <div style={{ ...LAB, padding: "0 14px 14px" }}>Весь період</div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontVariantNumeric: "tabular-nums", minWidth: 980 }}>
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
                <th style={TH} title={HINT_EARNED}>Заробили ліди дня ⓘ</th>
                <th style={TH} title={HINT_RECEIVED}>Надійшло ⓘ</th>
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
                  <td style={TD}>
                    {dayEarnedDeals(d) > 0
                      ? <button type="button" title="Показати, які угоди цього дня вже принесли гроші"
                                onClick={(e) => { e.stopPropagation(); setOpenDay(d.day); setEarnedOnly(true); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                                style={{ all: "unset", cursor: "pointer", fontWeight: 700, color: "var(--rpt-ok, #1a7f4b)", borderBottom: "1px dashed currentColor" }}>
                          {money(dayEarned(d))} ₴
                        </button>
                      : <b>{money(dayEarned(d))} ₴</b>}
                    {times(dayEarned(d), d.cost) && <span style={{ ...DIM, fontSize: 11.5 }}> · {times(dayEarned(d), d.cost)}</span>}
                  </td>
                  <td style={TD}>
                    {d.receivedDeals > 0
                      ? <button type="button" title="Показати, за які угоди надійшли гроші"
                                onClick={(e) => { e.stopPropagation(); setOpenDay(d.day); setShowReceived(true); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                                style={{ all: "unset", cursor: "pointer", color: "var(--rpt-link, #2563eb)", borderBottom: "1px dashed currentColor" }}>
                          {money(d.received)} ₴
                        </button>
                      : `${money(d.received)} ₴`}
                  </td>
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
                <td style={TD}>
                  <b style={{ color: "var(--rpt-ok, #1a7f4b)" }}>{money(totalEarned)} ₴</b>
                  {times(totalEarned, totalCost) && <span style={{ ...DIM, fontSize: 11.5 }}> · {times(totalEarned, totalCost)}</span>}
                </td>
                <td style={TD} title="= плитці «Надійшло за період»"><b>{money(totalReceived)} ₴</b></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      </>)}
    </div>
  );
}

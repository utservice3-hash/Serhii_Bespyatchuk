import { Fragment, useEffect, useState } from "react";
import { fetchAds, type AdsReport } from "../../../api";

/**
 * 📣 РЕКЛАМА — день × кампанія з GA4.
 *
 * 🔴 ЩО ТУТ НОВОГО (рішення власника 08.09.2026: «нова гранулярність»). ROMI, CPA,
 * бюджет і дохід уже рахує КВП-звіт — сюди їх НЕ переносимо, інакше зʼявиться другий
 * екран тих самих чисел, і виправлення лягатиме в одну копію (урок «жоден показник не
 * має двох джерел на одному екрані»). Новим є рівень: **день × кампанія**, якого не
 * було ніде.
 *
 * 🔴 ДВА ДЖЕРЕЛА ВИТРАТ ПОРУЧ, І РОЗБІЖНІСТЬ ВИДНА ЧИСЛОМ. GA4 і аркуш Сергія
 * лишаються обидва (рішення власника). Показуємо їх сусідніми колонками з різницею —
 * саме щоб розбіжність не була тихою.
 *
 * ⚠️ НЕВІДОМЕ ЧИТАЄТЬСЯ ЯК НЕВІДОМЕ (правило зони фронту): день, якого немає в
 * аркуші, дає «—» з підписом, а не 0 — нуль означав би «витрат не було».
 */
/* Стилі клітинок — числа ПРАВОРУЧ, підписи ліворуч. Це не смак: числа різної
   довжини, вирівняні ліворуч, неможливо порівнювати оком по стовпчику. */
const TH_L = { textAlign: "left" as const, padding: "10px 12px", whiteSpace: "nowrap" as const };
const TH_R = { ...TH_L, textAlign: "right" as const };
const TD_L = { padding: "10px 12px", whiteSpace: "nowrap" as const };
const TD_R = { ...TD_L, textAlign: "right" as const };
const DIM = { color: "var(--text-muted)" };

/** `2026-07-14` → `14.07`. Рік у колонці днів зайвий — період і так обрано зверху. */
function dayLabel(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}.${m[2]}` : iso;
}

/** «кампанія / кампанії / кампаній» — щоб лічильник читався як речення. */
function plural(n: number): string {
  const t = n % 10, h = n % 100;
  if (t === 1 && h !== 11) return "кампанія";
  if (t >= 2 && t <= 4 && (h < 12 || h > 14)) return "кампанії";
  return "кампаній";
}

export function AdsSection({ from, to }: { from: string; to: string }) {
  const [data, setData] = useState<AdsReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    setErr(null);
    // ⚠️ Швидкий період «Весь час» віддає ПОРОЖНІ дати, і вони не безневинні:
    // axios шле `?from=&to=`, сервер отримує `""`, і роут висить 20 с до 503.
    // Та сама охорона стоїть у сусідньому `LeadgenSection`. Другий рубіж — на
    // бекенді (`dateParam`), бо роут мусить витримувати будь-який запит.
    if (!from || !to) return;
    fetchAds({ from, to })
      .then(setData)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : "не вдалося завантажити"));
  }, [from, to]);

  if (err) return <div className="chart-card"><p style={{ color: "#dc2626" }}>Помилка: {err}</p></div>;
  // Порожній період — це стан екрана, а не завантаження: кажемо словами, що робити.
  if (!from || !to) return <div className="chart-card"><p>Оберіть період — «Весь час» тут не працює: рекламу показуємо по днях.</p></div>;
  if (!data) return <div className="chart-card"><p>Завантаження…</p></div>;

  const money = (n: number) => n.toLocaleString("uk-UA", { maximumFractionDigits: 0 });
  const totalCost = data.days.reduce((s, d) => s + d.cost, 0);
  const totalLeads = data.days.reduce((s, d) => s + d.leads, 0);
  const cpl = totalLeads > 0 ? Math.round(totalCost / totalLeads) : null;

  return (
    <div className="chart-card">
      <h2 className="chart-title">📣 Реклама — день × кампанія</h2>

      {!data.ga4Configured && (
        <p style={{ background: "#fef3c7", padding: 10, borderRadius: 8, marginBottom: 12 }}>
          ⚠️ GA4 ще не підключено на сервері — таблиця показує лише те, що встигло
          завантажитись. Це не помилка екрана.
        </p>
      )}

      <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 12 }}>
        Витрати й кліки — з Google Ads через GA4. Ліди — з того самого ядра, що рахує
        конверсію реклами. Зіставлення <b>поденне</b>: звʼязати конкретний клік із
        конкретною угодою неможливо — мітка <code>gclid</code> у CRM порожня в усіх угодах.
        {" "}Показано <b>всі канали з витратами</b>, включно з Performance Max — тому сума
        може бути більшою за таблицю бюджету, і це не помилка.
      </p>

      <div style={{ display: "flex", gap: 24, marginBottom: 16, flexWrap: "wrap" }}>
        <div><div style={{ fontSize: 12, color: "var(--text-muted)" }}>Витрати GA4</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{money(totalCost)} ₴</div></div>
        <div><div style={{ fontSize: 12, color: "var(--text-muted)" }}>Платних лідів</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{totalLeads}</div></div>
        <div><div style={{ fontSize: 12, color: "var(--text-muted)" }}>Ціна ліда</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{cpl === null ? "—" : `${money(cpl)} ₴`}</div></div>
      </div>

      {data.days.length === 0 ? (
        <p>За цей період витрат у GA4 немає. Це може означати і що реклама не крутилась —
          перевірте період і стан кампаній.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          {/* `data-table` — спільний клас проєкту: без нього таблиця йде зовсім без
              стилів і колонки злипаються. `tabular-nums` вирівнює цифри в стовпчик,
              інакше числа різної ширини «пливуть» і суми важко порівнювати оком. */}
          <table className="data-table" style={{ fontVariantNumeric: "tabular-nums", minWidth: 720 }}>
            <thead>
              <tr>
                <th style={TH_L}>День</th>
                <th style={TH_R}>Витрати GA4</th>
                <th style={TH_R}>Таблиця бюджету</th>
                <th style={TH_R}>Різниця</th>
                <th style={TH_R}>Кліки</th>
                <th style={TH_R}>Сесії</th>
                <th style={TH_R}>Ліди CRM</th>
                <th style={{ ...TH_R, width: 1 }} />
              </tr>
            </thead>
            <tbody>
              {data.days.map((d) => {
                const diff = d.sheetCost === null ? null : Math.round(d.cost - d.sheetCost);
                const rows = data.campaigns.filter((c) => c.day === d.day);
                const isOpen = open === d.day;
                return (
                  <Fragment key={d.day}>
                    <tr onClick={() => setOpen(isOpen ? null : d.day)}
                        style={{ cursor: rows.length ? "pointer" : "default",
                                 background: isOpen ? "var(--surface-2, rgba(127,127,127,0.06))" : undefined }}>
                      <td style={TD_L}>{dayLabel(d.day)}</td>
                      <td style={TD_R}><b>{money(d.cost)} ₴</b></td>
                      <td style={TD_R} title={d.sheetCost === null ? "аркуш бюджету не має цього дня" : undefined}>
                        {d.sheetCost === null ? <span style={DIM}>немає в аркуші</span> : `${money(d.sheetCost)} ₴`}
                      </td>
                      <td style={{ ...TD_R, color: diff ? "#b45309" : undefined }}>
                        {diff === null ? <span style={DIM}>—</span>
                          : diff === 0 ? <span style={DIM}>збігається</span>
                          : `${diff > 0 ? "+" : "−"}${money(Math.abs(diff))} ₴`}
                      </td>
                      <td style={TD_R}>{d.clicks}</td>
                      <td style={TD_R}>{d.sessions}</td>
                      <td style={TD_R}>{d.leads}</td>
                      <td style={{ ...TD_R, whiteSpace: "nowrap" }}>
                        {rows.length > 0 && (
                          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                            {isOpen ? "▾" : "▸"} {rows.length} {plural(rows.length)}
                          </span>
                        )}
                      </td>
                    </tr>
                    {isOpen && rows.map((c) => (
                      /* Дочірні рядки лягають у ТУ САМУ сітку, що й день (правило зони
                         звітних екранів): дві різні сітки на одному екрані читаються
                         як два різні звіти. Колонки, яких на рівні кампанії не існує,
                         підписані словами, а не лишені порожніми. */
                      <tr key={`${c.day}-${c.campaign}-${c.channelGroup ?? ""}`}>
                        <td style={{ ...TD_L, paddingLeft: 26 }}>
                          <div>{c.campaign}</div>
                          <div style={{ ...DIM, fontSize: 11 }}>{c.channelGroup || "канал не вказано"}</div>
                        </td>
                        <td style={TD_R}>{money(c.cost)} ₴</td>
                        <td style={TD_R}><span style={DIM}>аркуш не ділиться</span></td>
                        <td style={TD_R}><span style={DIM}>—</span></td>
                        <td style={TD_R}>{c.clicks}</td>
                        <td style={TD_R}>{c.sessions}</td>
                        <td style={TD_R} title="ліди не діляться по кампаніях: мітка gclid у CRM порожня">
                          <span style={DIM}>не ділиться</span>
                        </td>
                        <td />
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

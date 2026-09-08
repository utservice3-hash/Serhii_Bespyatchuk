import { useEffect, useState } from "react";
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
export function AdsSection({ from, to }: { from: string; to: string }) {
  const [data, setData] = useState<AdsReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    setErr(null);
    fetchAds({ from, to })
      .then(setData)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : "не вдалося завантажити"));
  }, [from, to]);

  if (err) return <div className="chart-card"><p style={{ color: "#dc2626" }}>Помилка: {err}</p></div>;
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
          <table>
            <thead><tr>
              <th>ДЕНЬ</th><th>ВИТРАТИ GA4</th><th>ТАБЛИЦЯ</th><th>Δ</th>
              <th>КЛІКИ</th><th>СЕСІЇ</th><th>ЛІДИ CRM</th><th></th>
            </tr></thead>
            <tbody>
              {data.days.map((d) => {
                const diff = d.sheetCost === null ? null : Math.round(d.cost - d.sheetCost);
                const rows = data.campaigns.filter((c) => c.day === d.day);
                return (
                  <>
                    <tr key={d.day}>
                      <td>{d.day}</td>
                      <td>{money(d.cost)} ₴</td>
                      <td title={d.sheetCost === null ? "аркуш цього дня не містить" : undefined}>
                        {d.sheetCost === null ? "—" : `${money(d.sheetCost)} ₴`}
                      </td>
                      <td style={{ color: diff && Math.abs(diff) > 0 ? "#b45309" : undefined }}>
                        {diff === null ? "—" : `${diff > 0 ? "+" : ""}${money(diff)} ₴`}
                      </td>
                      <td>{d.clicks}</td>
                      <td>{d.sessions}</td>
                      <td>{d.leads}</td>
                      <td>
                        <button onClick={() => setOpen(open === d.day ? null : d.day)}
                          style={{ border: "none", background: "transparent", cursor: "pointer" }}>
                          {open === d.day ? "▾" : "▸"} {rows.length}
                        </button>
                      </td>
                    </tr>
                    {open === d.day && rows.map((c) => (
                      <tr key={`${c.day}-${c.campaign}`} style={{ background: "var(--card-bg)" }}>
                        <td style={{ paddingLeft: 24, color: "var(--text-muted)" }}>{c.campaign}</td>
                        <td>{money(c.cost)} ₴</td>
                        <td colSpan={2} style={{ color: "var(--text-muted)" }}>{c.channelGroup ?? "канал не вказано"}</td>
                        <td>{c.clicks}</td>
                        <td>{c.sessions}</td>
                        <td colSpan={2} style={{ color: "var(--text-muted)" }}>конверсій GA4: {c.conversions}</td>
                      </tr>
                    ))}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

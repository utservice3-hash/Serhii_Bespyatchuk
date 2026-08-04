import { useEffect, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, Cell } from "recharts";
import { fetchClientCard, type ClientCard } from "../../../api";
import { formatAmountFull } from "../format";

/**
 * 💳 КАРТКА КЛІЄНТА — «як він платив».
 *
 * 🔴 ГІСТОГРАМУ РАХУЄ ЯДРО (`successByClientBucket` по канонічному ключу) — та сама
 * функція, що дає факт менеджера у Звіті. Тому стовпчик «липень» тут і рядок
 * «липень» там — одна цифра, а не дві схожі.
 *
 * ⚠️ ДВА РІЗНІ ЯКОРІ, І ЦЕ ПІДПИСАНО. Стовпчики — гроші ① (анкер = дата входу в
 * «успішно реалізовано»). Список унизу — журнал угод (дата закриття, для
 * незакритих — створення) і показує ВСІ стадії, не лише виграні. Тому Σ списку не
 * дорівнює Σ стовпчиків, і зводити їх не треба.
 */
export function ClientCardPanel({ clientKey }: { clientKey: string }) {
  const [card, setCard] = useState<ClientCard | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setCard(null); setErr(null);
    fetchClientCard(clientKey).then(setCard)
      .catch((e) => setErr((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "не вдалося завантажити картку"));
  }, [clientKey]);

  if (err) return <div style={{ fontSize: 12, color: "#b91c1c" }}>{err}</div>;
  if (!card) return <div style={{ fontSize: 12, color: "#9ca3af" }}>завантаження картки…</div>;

  const data = card.months.map((m) => ({
    label: m.month.slice(2).split("-").reverse().join("."),   // 07.26
    revenue: m.revenue, deals: m.deals, month: m.month,
  }));
  const maxIdx = data.reduce((best, r, i) => (r.revenue > data[best].revenue ? i : best), 0);
  const empty = card.monthsTotal === 0;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 13 }}>📊 Надходження за 12 міс. · «успішно реалізовано» ①</div>
        <div style={{ fontSize: 11, color: "#6b7280" }}>
          за 12 міс: <b style={{ color: "#111827" }}>{formatAmountFull(card.monthsTotal)}</b>
          {" · "}lifetime: {formatAmountFull(card.lifetimeRevenue)} / {card.orders} опл
          {card.firstPaid ? ` · з ${card.firstPaid.slice(0, 7)}` : ""}
        </div>
      </div>

      {empty ? (
        // Порожньо — це відповідь, а не помилка: клієнт не платив 12 міс.
        <div style={{ marginTop: 8, background: "#f8fafc", border: "1px dashed #cbd5e1", borderRadius: 8,
                      padding: "12px 14px", fontSize: 12, color: "#64748b" }}>
          За останні 12 місяців оплат ①  немає. Остання оплата: {card.lastPaid ?? "—"}.
        </div>
      ) : (
        <div style={{ height: 190, marginTop: 8 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `${Math.round(Number(v) / 1000)}k`} width={44} />
              <Tooltip
                formatter={(v, _n, p) => [`${formatAmountFull(Number(v))} · ${(p?.payload as { deals: number })?.deals ?? 0} угод`, "Успішно реалізовано"]}
                labelFormatter={(l) => `Місяць ${l}`} />
              <Bar dataKey="revenue" radius={[4, 4, 0, 0]}>
                {data.map((r, i) => (
                  // Найбільший місяць виділено, останній — акцентом: це форма, не шкала.
                  <Cell key={r.month} fill={i === data.length - 1 ? "#c5141c" : i === maxIdx ? "#2563eb" : "#93c5fd"} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      <div style={{ fontWeight: 700, fontSize: 13, margin: "12px 0 6px" }}>🧾 Останні угоди</div>
      {card.deals.length === 0 ? (
        <div style={{ fontSize: 12, color: "#9ca3af" }}>угод немає</div>
      ) : (
        <div style={{ maxHeight: 210, overflowY: "auto", border: "1px solid #f1f5f9", borderRadius: 8 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <tbody>
              {card.deals.map((d) => (
                <tr key={d.kommoId} style={{ borderBottom: "1px solid #f1f5f9" }}>
                  <td style={{ padding: "6px 8px", whiteSpace: "nowrap", color: "#6b7280" }}>
                    {d.date ?? "—"}
                    {/* Підпис якоря рядка: закрита угода чи ще ні — інакше дата читалась
                        би як «дата оплати», якої в CRM не існує взагалі. */}
                    <div style={{ fontSize: 10, color: "#9ca3af" }}>{d.dateKind === "closed" ? "закрито" : "створено"}</div>
                  </td>
                  <td style={{ padding: "6px 8px" }}>
                    <a href={d.crmUrl} target="_blank" rel="noreferrer" style={{ color: "#1d4ed8", textDecoration: "none" }}>
                      {d.name ?? `Угода ${d.kommoId}`}
                    </a>
                    <div style={{ fontSize: 10, color: "#9ca3af" }}>{d.manager ?? "—"}</div>
                  </td>
                  <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>
                    <span style={{ display: "inline-block", padding: "1px 7px", borderRadius: 999, fontSize: 10, fontWeight: 700,
                                   background: d.won ? "#dcfce7" : "#f3f4f6", color: d.won ? "#166534" : "#4b5563" }}>
                      {d.stage}
                    </span>
                  </td>
                  <td style={{ padding: "6px 8px", textAlign: "right", fontWeight: 700, whiteSpace: "nowrap",
                               color: d.price < 0 ? "#b91c1c" : "#111827" }}>
                    {d.price.toLocaleString("uk-UA")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ fontSize: 11, color: "#6b7280", marginTop: 6, lineHeight: 1.5 }}>{card.anchorNote}</div>
    </div>
  );
}

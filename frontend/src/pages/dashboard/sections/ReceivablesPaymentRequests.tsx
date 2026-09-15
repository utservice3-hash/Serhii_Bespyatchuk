import { useEffect, useState } from "react";
import { fetchPaymentRequests, type PaymentRequestRow, type PaymentRequestsResp } from "../../../api";
import { formatAmount, formatAmountFull } from "../format";
import { formatDateSafe } from "../receivablesView";
import { Hint } from "../../../components/Hint";

/**
 * 📋 РЕЄСТР ЗАЯВОК НА ОПЛАТУ ПЕРЕВІЗНИКАМ (рішення власника 07.09.2026).
 * «Для компанії такої-то менеджер подав таку-то суму для такого-то перевізника;
 * менеджер бачить лише свої заявки. Спочатку просто історія» — тому тут лише
 * список і підсумок, жодних дій: подача й статус живуть у CRM.
 *
 * 🔴 СКОУП — ПО МЕНЕДЖЕРУ, ЩО ПОДАВ, а не по клієнту (на відміну від реєстру
 * рахунків): так сказав власник, і колонка «Менеджер» тут — це «хто подав».
 */
const KIND_LABEL: Record<string, string> = {
  pending: "Заявка", accepted: "Прийнято", problem: "Проблемна", paid: "Оплачено", rejected: "Відмовлено", unsorted: "Нерозібране", unknown: "інше",
};
const KIND_COLOR: Record<string, string> = {
  pending: "var(--warn)", accepted: "var(--info, #1d4ed8)", problem: "var(--danger)", paid: "var(--ok, #16a34a)", rejected: "var(--text-muted)", unsorted: "var(--text-muted)", unknown: "var(--danger)",
};

const isoDaysAgo = (n: number) => new Date(Date.now() - n * 864e5).toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });

export function ReceivablesPaymentRequests() {
  const [from, setFrom] = useState(isoDaysAgo(30));
  const [to, setTo] = useState(isoDaysAgo(0));
  const [kind, setKind] = useState("");
  const [data, setData] = useState<PaymentRequestsResp | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null); setErr(null);
    fetchPaymentRequests({ from, to, status: kind || undefined })
      .then((d) => { if (alive) setData(d); })
      .catch((e: unknown) => {
        const r = (e as { response?: { data?: { error?: string } } }).response;
        if (alive) setErr(r?.data?.error ?? "Не вдалось завантажити реєстр заявок");
      });
    return () => { alive = false; };
  }, [from, to, kind]);

  const inp: React.CSSProperties = { fontSize: "var(--fs-sm)", padding: "4px 6px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--paper, #fff)", color: "var(--text)" };

  return (
    <div className="chart-card">
      <h3 style={{ margin: "0 0 4px", fontSize: "var(--fs-lg)" }}>
        Реєстр заявок на оплату перевізникам{data ? ` (${data.rows.length})` : ""}
        <Hint title="Звідки заявки"
          body="Кожна заявка — угода «Автосделка» у воронці «Оплата перевозчикам» в CRM. Дата — момент подачі. Менеджер бачить лише ті, що подав сам; тімлід — свою команду." />
      </h3>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", margin: "6px 0 10px", fontSize: "var(--fs-sm)" }}>
        <span style={{ color: "var(--text-muted)" }}>подано з</span>
        <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} style={inp} />
        <span style={{ color: "var(--text-muted)" }}>по</span>
        <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} style={inp} />
        <select value={kind} onChange={(e) => setKind(e.target.value)} style={inp}>
          <option value="">усі стани</option>
          {(["pending", "accepted", "problem", "paid", "rejected", "unsorted"] as const).map((k) => (
            <option key={k} value={k}>{KIND_LABEL[k]}</option>
          ))}
        </select>
      </div>

      {err ? <p className="loading-text" style={{ color: "var(--danger)" }}>🔴 {err}</p>
        : !data ? <p className="loading-text">Завантаження заявок…</p>
        : (
        <>
          {/* Підсумок: кожен стан — числом, порожній стан теж (нуль, а не пропуск). */}
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: "var(--fs-sm)", margin: "0 0 10px" }}>
            {(["pending", "accepted", "problem", "paid", "rejected"] as const).map((k) => (
              <span key={k} style={{ color: KIND_COLOR[k] }}>
                {KIND_LABEL[k]}: <b>{data.summary[k].n}</b>
                <span style={{ color: "var(--text-muted)" }} title={formatAmountFull(data.summary[k].amount)}> · {formatAmount(data.summary[k].amount)}</span>
              </span>
            ))}
            {data.summary.unknown.n > 0 && (
              <span style={{ color: "var(--danger)" }}>невідомий етап: <b>{data.summary.unknown.n}</b></span>
            )}
          </div>
          {data.rows.length === 0 ? (
            <p className="loading-text">За цей період заявок у вашому скоупі немає.</p>
          ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="data-table recv-table">
              <thead>
                <tr>
                  <th style={{ textAlign: "left", width: 96 }}>Подано</th>
                  <th style={{ textAlign: "left", width: 220 }}>Клієнт</th>
                  <th style={{ textAlign: "left", width: 240 }}>Перевізник</th>
                  <th style={{ textAlign: "left", width: 90 }}>Тип</th>
                  <th className="recv-num" style={{ textAlign: "right", width: 110 }}>Сума</th>
                  <th style={{ textAlign: "left", width: 130 }}>Стан</th>
                  <th style={{ textAlign: "left", width: 150 }}>
                    Менеджер
                    <Hint title="Хто подав заявку" body="Відповідальний за угоду-заявку в CRM. Менеджер бачить у цьому реєстрі лише свої." />
                  </th>
                  <th style={{ textAlign: "center", width: 60 }}>CRM</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((x: PaymentRequestRow) => (
                  <tr key={x.kommoId}>
                    <td className="recv-num" style={{ textAlign: "left" }}>{formatDateSafe(x.submittedOn)}</td>
                    <td style={{ textAlign: "left" }} title={x.clientName ?? ""}>
                      <span className="recv-cname">{x.clientName ?? <i style={{ color: "var(--text-muted)" }}>клієнта не вказано</i>}</span>
                    </td>
                    <td style={{ textAlign: "left" }} title={x.carrierEdrpou ? `ЄДРПОУ ${x.carrierEdrpou}` : ""}>
                      {x.carrierName ?? <i style={{ color: "var(--text-muted)" }}>перевізника не вказано</i>}
                    </td>
                    <td style={{ textAlign: "left", fontSize: "var(--fs-sm)", color: "var(--text-muted)" }}>{x.payType ?? "—"}</td>
                    <td className="recv-num" style={{ textAlign: "right", fontWeight: 600 }} title={x.amount == null ? "" : formatAmountFull(x.amount)}>
                      {x.amount == null ? <span style={{ color: "var(--text-muted)" }}>суми немає</span> : formatAmount(x.amount)}
                    </td>
                    <td style={{ textAlign: "left", fontSize: "var(--fs-sm)", color: KIND_COLOR[x.kind] }} title={x.status}>{x.status}</td>
                    <td style={{ textAlign: "left", fontSize: "var(--fs-sm)", color: "var(--text-muted)" }}>{x.managerName ?? <i>без менеджера</i>}</td>
                    <td style={{ textAlign: "center" }}>
                      <a href={x.crmUrl} target="_blank" rel="noreferrer" title="Відкрити заявку в CRM" style={{ textDecoration: "none" }}>🔗</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
        </>
      )}
    </div>
  );
}

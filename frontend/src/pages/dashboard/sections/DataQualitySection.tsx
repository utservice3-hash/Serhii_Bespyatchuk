import { useEffect, useState } from "react";
import { fetchDataQuality, type DataQualityCheck } from "../../../api";

const HINT: Record<string, string> = {
  noManager: "Угоди повного циклу без відповідального. Випадають з усіх per-manager звітів.",
  noAmount: "Угоди на грошових етапах (Авто працює/Рахунок) із сумою 0. Занижують «очікувані» та «відправлено авто».",
  unmapped: "Статус угоди не змаплено у воронку — угода невидима для аналітики. 143 = «закрито/втрачено» (нормально), інші — треба змапити.",
  negatives: "Відʼємна сума без слова «мінус» у назві — ймовірна помилка вводу (нетить суми хибно).",
  duplicates: "Один клієнт має 2+ активні угоди повного циклу. Або кілька перевезень (норм), або дубль — треба перевірити вручну.",
};

const KOMMO_BASE = "https://uts.kommo.com/leads/detail/";

/** «Контроль якості даних» (ТЗ §7) — записи, що спотворюють інші метрики.
 *  Джерело істини — CRM; тут підсвічуються розбіжності/аномалії. Admin/тімлід. */
export function DataQualitySection() {
  const [data, setData] = useState<DataQualityCheck[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    fetchDataQuality().then((r) => setData(r.checks)).catch(() => setErr("Не вдалося завантажити."));
  }, []);

  return (
    <>
      <div className="page-header"><h1 className="page-title">🔍 Якість даних</h1></div>
      <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 16px", maxWidth: 760 }}>
        CRM — єдине істинне джерело; тут підсвічені записи, що можуть спотворювати цифри дашборду. Клік по картці — перелік прикладів (клік по угоді відкриває її в Kommo).
      </p>
      {err && <p className="loading-text" style={{ color: "#dc2626" }}>{err}</p>}
      {!data && !err && <p className="loading-text">Перевірка…</p>}
      {data && (
        <>
          <div className="kpi-grid">
            {data.map((c) => (
              <button key={c.key} className="kpi-card" onClick={() => setOpen(open === c.key ? null : c.key)}
                style={{ textAlign: "left", border: "none", cursor: "pointer", background: "var(--card-bg)", borderLeft: `4px solid ${c.count > 0 ? "#d97706" : "#16a34a"}` }}
                title="Натисніть для прикладів">
                <span className="kpi-label">{c.label}</span>
                <span className="kpi-value" style={{ color: c.count > 0 ? "#d97706" : "#16a34a" }}>{c.count > 0 ? c.count.toLocaleString("uk-UA") : "✓ 0"}</span>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{HINT[c.key]}</span>
              </button>
            ))}
          </div>

          {open && (() => {
            const c = data.find((x) => x.key === open)!;
            if (c.sample.length === 0) return <p className="loading-text" style={{ marginTop: 16 }}>Немає прикладів — усе чисто ✓</p>;
            return (
              <div className="chart-card" style={{ marginTop: 16 }}>
                <h2 className="chart-title">{c.label} — приклади ({c.sample.length}{c.count > c.sample.length ? ` з ${c.count}` : ""})</h2>
                <div style={{ overflowX: "auto" }}>
                  <table className="data-table compact" style={{ minWidth: 560 }}>
                    <thead><tr><th style={{ textAlign: "left" }}>Угода</th><th style={{ textAlign: "left" }}>Менеджер</th><th style={{ textAlign: "left" }}>Деталь</th><th></th></tr></thead>
                    <tbody>
                      {c.sample.map((s, i) => (
                        <tr key={i}>
                          <td style={{ textAlign: "left", maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.name ?? ""}>{s.name || "—"}</td>
                          <td style={{ textAlign: "left", color: "var(--text-muted)" }}>{s.manager || "—"}</td>
                          <td style={{ textAlign: "left", color: "var(--text-muted)" }}>{s.extra || "—"}</td>
                          <td><a href={`${KOMMO_BASE}${s.kommoId}`} target="_blank" rel="noreferrer" style={{ color: "#c5141c", fontSize: 12 }}>Kommo ↗</a></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })()}
        </>
      )}
    </>
  );
}

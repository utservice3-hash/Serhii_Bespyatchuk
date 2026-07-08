import { useEffect, useState } from "react";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, Legend, CartesianGrid, ResponsiveContainer,
} from "recharts";
import { fetchReports, deleteReport, postAiMessage, type ReportWidget } from "../../../api";
import { formatAmount } from "../format";

const COLORS = ["#c5141c", "#2f9e44", "#e8893a", "#1971c2", "#9c36b5", "#0c8599"];

type SeriesCfg = { key: string; label?: string };
type Cfg = {
  x?: string;
  series?: SeriesCfg[];
  columns?: { key: string; label?: string; format?: string }[];
  value?: string;
  label?: string;
  format?: "money" | "number";
};

function fmt(v: unknown, format?: string): string {
  if (v == null) return "—";
  if ((format === "money" || format === "number") && !isNaN(Number(v))) {
    return format === "money" ? formatAmount(Number(v)) : new Intl.NumberFormat("uk-UA").format(Number(v));
  }
  return String(v);
}

function WidgetView({ w, onDelete, canDelete }: { w: ReportWidget; onDelete: (id: number) => void; canDelete: boolean }) {
  const cfg = (w.config ?? {}) as Cfg;
  const rows = w.rows ?? [];

  let inner: React.ReactNode;
  if (w.error) {
    inner = <p style={{ color: "#c5141c", fontSize: 13 }}>Помилка запиту: {w.error}</p>;
  } else if (!rows.length) {
    inner = <p className="loading-text">Немає даних.</p>;
  } else if (w.chartType === "kpi") {
    const valKey = cfg.value ?? Object.keys(rows[0]).find((k) => !isNaN(Number(rows[0][k]))) ?? Object.keys(rows[0])[0];
    inner = (
      <div style={{ padding: "8px 0" }}>
        <div style={{ fontSize: 34, fontWeight: 800, color: "#c5141c" }}>{fmt(rows[0][valKey], cfg.format ?? "number")}</div>
        {cfg.label && <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{cfg.label}</div>}
      </div>
    );
  } else if (w.chartType === "bar" || w.chartType === "line") {
    const xKey = cfg.x ?? Object.keys(rows[0])[0];
    const series: SeriesCfg[] = cfg.series?.length
      ? cfg.series
      : Object.keys(rows[0]).filter((k) => k !== xKey).map((k): SeriesCfg => ({ key: k }));
    const data = rows.map((r) => {
      const o: Record<string, unknown> = { [xKey]: r[xKey] };
      for (const s of series) o[s.key] = Number(r[s.key]) || 0;
      return o;
    });
    inner = (
      <ResponsiveContainer width="100%" height={280}>
        {w.chartType === "bar" ? (
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey={xKey} tick={{ fontSize: 11 }} /><YAxis tick={{ fontSize: 11 }} />
            <Tooltip formatter={(v) => fmt(v, cfg.format)} />
            <Legend />
            {series.map((s, i) => <Bar key={s.key} dataKey={s.key} name={s.label ?? s.key} fill={COLORS[i % COLORS.length]} radius={[4, 4, 0, 0]} />)}
          </BarChart>
        ) : (
          <LineChart data={data} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey={xKey} tick={{ fontSize: 11 }} /><YAxis tick={{ fontSize: 11 }} />
            <Tooltip formatter={(v) => fmt(v, cfg.format)} />
            <Legend />
            {series.map((s, i) => <Line key={s.key} type="monotone" dataKey={s.key} name={s.label ?? s.key} stroke={COLORS[i % COLORS.length]} strokeWidth={2} dot={false} />)}
          </LineChart>
        )}
      </ResponsiveContainer>
    );
  } else {
    const cols = cfg.columns?.length ? cfg.columns : Object.keys(rows[0]).map((k) => ({ key: k, label: k, format: undefined }));
    inner = (
      <div style={{ overflowX: "auto" }}>
        <table className="data-table compact">
          <thead><tr>{cols.map((c) => <th key={c.key}>{c.label ?? c.key}</th>)}</tr></thead>
          <tbody>
            {rows.map((r, i) => <tr key={i}>{cols.map((c) => <td key={c.key}>{fmt(r[c.key], c.format)}</td>)}</tr>)}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="chart-card" style={{ gridColumn: w.chartType === "kpi" ? "span 1" : "span 2" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>{w.title}</h3>
        {canDelete && (
          <button onClick={() => onDelete(w.id)} title="Видалити віджет"
            style={{ border: "none", background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 15 }}>🗑</button>
        )}
      </div>
      {inner}
    </div>
  );
}

export function ReportsSection({ canDelete }: { canDelete: boolean }) {
  const [widgets, setWidgets] = useState<ReportWidget[]>([]);
  const [loading, setLoading] = useState(true);
  const [prompt, setPrompt] = useState("");
  const [building, setBuilding] = useState(false);
  const [sentNote, setSentNote] = useState<string | null>(null);

  const load = () => { fetchReports().then(setWidgets).finally(() => setLoading(false)); };
  useEffect(load, []);

  async function onDelete(id: number) {
    if (!confirm("Видалити цей віджет?")) return;
    await deleteReport(id);
    setWidgets((p) => p.filter((w) => w.id !== id));
  }

  async function build() {
    const p = prompt.trim();
    if (!p || building) return;
    setBuilding(true); setSentNote(null);
    try {
      await postAiMessage(`Додай у «Мої звіти» віджет: ${p}`);
      setPrompt("");
      setSentNote("✅ Запит надіслано АІ. Віджет зʼявиться за ~1 хв — сторінка оновиться сама.");
      // Віджет створюється асинхронно (АІ обробляє запит) — оновлюємо кілька разів.
      [15000, 35000, 60000].forEach((ms) => setTimeout(load, ms));
    } catch {
      setSentNote("⚠️ Не вдалося надіслати запит (потрібен доступ до АІ).");
    } finally { setBuilding(false); }
  }

  return (
    <>
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1 className="page-title">Мої звіти</h1>
        <button className="btn-secondary" onClick={load} style={{ padding: "6px 14px", borderRadius: 8, cursor: "pointer" }}>🔄 Оновити</button>
      </div>

      {canDelete && (
        <div className="chart-card" style={{ marginBottom: 16 }}>
          <h2 className="chart-title" style={{ marginBottom: 8 }}>🤖 Побудувати звіт</h2>
          <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 8px" }}>
            Опишіть, що показати — АІ побудує віджет (таблиця/графік/показник) із даних CRM і додасть сюди. Напр.: «графік отриманих коштів по командах за цей місяць» або «таблиця топ-10 постійних клієнтів за виручкою».
          </p>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) build(); }}
              placeholder="Опишіть звіт, який хочете побачити…"
              style={{ flex: 1, resize: "vertical", font: "inherit", padding: 10, borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)" }} />
            <button onClick={build} disabled={building || !prompt.trim()}
              style={{ padding: "10px 18px", borderRadius: 8, border: "none", background: "#c5141c", color: "#fff", fontWeight: 700, cursor: building || !prompt.trim() ? "default" : "pointer", opacity: building || !prompt.trim() ? 0.6 : 1, whiteSpace: "nowrap" }}>
              {building ? "Надсилаю…" : "🤖 Побудувати"}
            </button>
          </div>
          {sentNote && <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "8px 0 0" }}>{sentNote}</p>}
        </div>
      )}
      {loading ? (
        <p className="loading-text">Завантаження…</p>
      ) : widgets.length === 0 ? (
        <div className="chart-card">
          <p style={{ color: "var(--text-muted)", margin: 0 }}>
            Тут зʼявляться звіти, які ви попросите побудувати АІ в розділі «Робота з АІ».
            Напишіть, наприклад: «Побудуй графік отриманих коштів по командах за цей місяць і додай у Мої звіти».
          </p>
        </div>
      ) : (
        <div className="kpi-grid" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
          {widgets.map((w) => <WidgetView key={w.id} w={w} onDelete={onDelete} canDelete={canDelete} />)}
        </div>
      )}
    </>
  );
}

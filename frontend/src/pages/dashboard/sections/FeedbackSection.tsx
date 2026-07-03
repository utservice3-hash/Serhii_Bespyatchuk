import { useEffect, useState } from "react";
import {
  fetchFeedback,
  submitFeedback,
  updateFeedback,
  type FeedbackItem,
  type FeedbackStatus,
} from "../../../api";

const STATUS_META: Record<FeedbackStatus, { label: string; color: string; bg: string }> = {
  pending: { label: "На розгляді", color: "#b45309", bg: "rgba(245,158,11,0.15)" },
  approved: { label: "Схвалено", color: "#1d4ed8", bg: "rgba(37,99,235,0.15)" },
  rejected: { label: "Відхилено", color: "#b91c1c", bg: "rgba(220,38,38,0.15)" },
  resolved: { label: "Вирішено", color: "#15803d", bg: "rgba(22,163,74,0.15)" },
};

function StatusBadge({ status }: { status: FeedbackStatus }) {
  const m = STATUS_META[status];
  return (
    <span style={{ fontSize: 12, fontWeight: 700, color: m.color, background: m.bg, padding: "2px 10px", borderRadius: 999, whiteSpace: "nowrap" }}>
      {m.label}
    </span>
  );
}

export function FeedbackSection({ isAdmin }: { isAdmin: boolean }) {
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [section, setSection] = useState("");
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState<FeedbackStatus | "all">("all");

  const load = () => {
    setLoading(true);
    fetchFeedback().then(setItems).catch(() => setItems([])).finally(() => setLoading(false));
  };
  useEffect(load, []);

  async function send() {
    if (!message.trim()) return;
    setSaving(true);
    try {
      const created = await submitFeedback({ message: message.trim(), section: section.trim() || undefined });
      setItems((prev) => [created, ...prev]);
      setMessage("");
      setSection("");
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(id: number, status: FeedbackStatus) {
    const note = status === "rejected" ? window.prompt("Коментар (необовʼязково):") ?? undefined : undefined;
    const updated = await updateFeedback(id, { status, adminNote: note });
    setItems((prev) => prev.map((x) => (x.id === id ? updated : x)));
  }

  const shown = filter === "all" ? items : items.filter((x) => x.status === filter);
  const counts = items.reduce((a, x) => ((a[x.status] = (a[x.status] ?? 0) + 1), a), {} as Record<string, number>);

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Зворотний звʼязок</h1>
      </div>

      <div className="chart-card" style={{ marginBottom: 16 }}>
        <h2 className="chart-title">Повідомити про баг або запропонувати правку</h2>
        <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 0 }}>
          Опишіть, що не так або що варто змінити. Адміністратор схвалить чи відхилить, після чого правку буде виконано.
        </p>
        <input
          value={section}
          onChange={(e) => setSection(e.target.value)}
          placeholder="Розділ (напр. «Огляд», «Звіт») — необовʼязково"
          style={{ width: "100%", marginBottom: 8, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)" }}
        />
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Опишіть проблему або пропозицію…"
          rows={4}
          style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", resize: "vertical" }}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
          <button className="btn-primary" onClick={send} disabled={saving || !message.trim()}
            style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: saving || !message.trim() ? "#94a3b8" : "#c5141c", color: "#fff", fontWeight: 600, cursor: saving || !message.trim() ? "default" : "pointer" }}>
            {saving ? "Надсилання…" : "Надіслати"}
          </button>
        </div>
      </div>

      <div className="chart-card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <h2 className="chart-title" style={{ marginBottom: 0 }}>{isAdmin ? "Усі звернення" : "Мої звернення"}</h2>
          <select value={filter} onChange={(e) => setFilter(e.target.value as FeedbackStatus | "all")}>
            <option value="all">Усі ({items.length})</option>
            <option value="pending">На розгляді ({counts.pending ?? 0})</option>
            <option value="approved">Схвалено ({counts.approved ?? 0})</option>
            <option value="resolved">Вирішено ({counts.resolved ?? 0})</option>
            <option value="rejected">Відхилено ({counts.rejected ?? 0})</option>
          </select>
        </div>
        {loading ? (
          <p className="loading-text">Завантаження…</p>
        ) : shown.length === 0 ? (
          <p className="loading-text">Немає звернень.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12 }}>
            {shown.map((f) => (
              <div key={f.id} style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "12px 14px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <StatusBadge status={f.status} />
                    {f.section && <span style={{ fontSize: 12, color: "var(--text-muted)" }}>· {f.section}</span>}
                    {isAdmin && <span style={{ fontSize: 12, color: "var(--text-muted)" }}>· {f.authorName}</span>}
                  </div>
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{new Date(f.createdAt).toLocaleString("uk-UA")}</span>
                </div>
                <div style={{ fontSize: 14, whiteSpace: "pre-wrap" }}>{f.message}</div>
                {f.adminNote && (
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6, fontStyle: "italic" }}>Коментар адміна: {f.adminNote}</div>
                )}
                {isAdmin && (
                  <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                    {f.status === "pending" && (
                      <>
                        <button onClick={() => setStatus(f.id, "approved")} style={{ padding: "5px 12px", borderRadius: 6, border: "none", background: "#1d4ed8", color: "#fff", fontWeight: 600, cursor: "pointer" }}>✓ Схвалити</button>
                        <button onClick={() => setStatus(f.id, "rejected")} style={{ padding: "5px 12px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", cursor: "pointer" }}>✕ Відхилити</button>
                      </>
                    )}
                    {f.status === "approved" && (
                      <button onClick={() => setStatus(f.id, "resolved")} style={{ padding: "5px 12px", borderRadius: 6, border: "none", background: "#16a34a", color: "#fff", fontWeight: 600, cursor: "pointer" }}>✔ Позначити вирішеним</button>
                    )}
                    {(f.status === "rejected" || f.status === "resolved") && (
                      <button onClick={() => setStatus(f.id, "pending")} style={{ padding: "5px 12px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", cursor: "pointer" }}>↩ Повернути на розгляд</button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

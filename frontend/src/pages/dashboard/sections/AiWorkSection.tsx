import { useEffect, useRef, useState } from "react";
import { fetchAiMessages, postAiMessage, type AiMessage } from "../../../api";

export function AiWorkSection() {
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [denied, setDenied] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const load = () => {
    fetchAiMessages()
      .then((m) => { setMessages(m); setDenied(false); })
      .catch((e) => { if (e?.response?.status === 403) setDenied(true); })
      .finally(() => setLoading(false));
  };
  useEffect(load, []);
  // АІ відповідає асинхронно на бекенді — добираємо його репліки полінгом.
  useEffect(() => {
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  const lastId = messages.length ? messages[messages.length - 1].id : 0;
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [lastId]);

  // Останнє слово за користувачем і воно свіже → АІ, ймовірно, готує відповідь.
  const last = messages[messages.length - 1];
  const aiTyping = !!last && last.role === "user" &&
    Date.now() - new Date(last.createdAt).getTime() < 5 * 60 * 1000;

  async function send() {
    if (!body.trim()) return;
    setSending(true);
    try {
      const created = await postAiMessage(body.trim());
      setMessages((p) => [...p, created]);
      setBody("");
    } finally {
      setSending(false);
    }
  }

  if (denied) {
    return (
      <div className="page-header">
        <h1 className="page-title">Робота з АІ</h1>
        <p className="loading-text">Доступ лише для адміністратора та призначеного акаунта.</p>
      </div>
    );
  }

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Робота з АІ</h1>
      </div>
      <div className="chart-card" style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 200px)", minHeight: 420 }}>
        <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 0 }}>
          Чат з АІ-аналітиком дашборду: знає бізнес-логіку проєкту й уміє діставати статистику прямо з бази (продажі, менеджери, конверсії, дебіторка). Питайте — відповідь зʼявиться тут же.
        </p>
        <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10, padding: "8px 0" }}>
          {loading ? (
            <p className="loading-text">Завантаження…</p>
          ) : messages.length === 0 ? (
            <p className="loading-text">Повідомлень ще немає. Напишіть перше.</p>
          ) : (
            messages.map((m) => {
              const isAi = m.role === "assistant";
              return (
                <div key={m.id} style={{ alignSelf: isAi ? "flex-start" : "flex-end", maxWidth: "80%" }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "baseline", justifyContent: isAi ? "flex-start" : "flex-end", marginBottom: 2 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: isAi ? "#c5141c" : "var(--text)" }}>{isAi ? "🤖 АІ" : m.authorName}</span>
                    <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{new Date(m.createdAt).toLocaleString("uk-UA")}</span>
                  </div>
                  <div style={{ background: isAi ? "rgba(197,20,28,0.08)" : "var(--hover-bg, rgba(127,127,127,0.08))", borderRadius: 10, padding: "8px 12px", whiteSpace: "pre-wrap", fontSize: 14 }}>
                    {m.body}
                    {m.status && <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>Статус: {m.status}</div>}
                  </div>
                </div>
              );
            })
          )}
          {aiTyping && (
            <div style={{ alignSelf: "flex-start", fontSize: 12, color: "var(--text-muted)", padding: "4px 12px" }}>
              🤖 АІ думає…
            </div>
          )}
          <div ref={endRef} />
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 8, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send(); }}
            placeholder="Опишіть, що змінити чи покращити… (Ctrl+Enter — надіслати)"
            rows={2}
            style={{ flex: 1, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", resize: "vertical" }}
          />
          <button className="btn-primary" onClick={send} disabled={sending || !body.trim()}
            style={{ padding: "8px 18px", borderRadius: 8, border: "none", background: sending || !body.trim() ? "#94a3b8" : "#c5141c", color: "#fff", fontWeight: 600, cursor: sending || !body.trim() ? "default" : "pointer", alignSelf: "stretch" }}>
            {sending ? "…" : "Надіслати"}
          </button>
        </div>
      </div>
    </>
  );
}

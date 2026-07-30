import { useEffect, useRef, useState } from "react";
import { fetchAiMessages, postAiMessage, uploadFile, FILES_BASE, type AiMessage, type AiAttachment } from "../../../api";
import { usePolling } from "../../../hooks/usePolling";

type Pending = { name: string; preview: string; file: File };

export function AiWorkSection({ lastSection }: { lastSection?: string }) {
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [denied, setDenied] = useState(false);
  const [pending, setPending] = useState<Pending[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Track whether the user is scrolled to the bottom, so polling/new messages
  // only auto-scroll when they're already following the conversation (no jump
  // while they read older messages or type).
  const atBottomRef = useRef(true);

  const load = () => {
    fetchAiMessages()
      .then((m) => { setMessages(m); setDenied(false); })
      .catch((e) => { if (e?.response?.status === 403) setDenied(true); })
      .finally(() => setLoading(false));
  };
  useEffect(load, []);
  // АІ відповідає асинхронно на бекенді — добираємо його репліки полінгом (пауза на фоні + джитер).
  usePolling(load, 5000);

  const lastId = messages.length ? messages[messages.length - 1].id : 0;
  // Scroll only the message list (never the whole page) and only if the user is
  // at the bottom — this removes the abrupt window jump while typing/reading.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [lastId]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }

  const last = messages[messages.length - 1];
  const aiTyping = !!last && last.role === "user" &&
    Date.now() - new Date(last.createdAt).getTime() < 5 * 60 * 1000;

  function addFiles(files: FileList | File[]) {
    const imgs = Array.from(files).filter((f) => f.type.startsWith("image/"));
    setPending((p) => [
      ...p,
      ...imgs.map((file) => ({ name: file.name, preview: URL.createObjectURL(file), file })),
    ].slice(0, 8));
  }

  async function send() {
    if (!body.trim() && !pending.length) return;
    setSending(true);
    try {
      let attachments: AiAttachment[] | undefined;
      if (pending.length) {
        const uploaded = await Promise.all(pending.map((p) => uploadFile(p.file)));
        attachments = uploaded.map((u) => ({ url: u.url, name: u.name }));
      }
      atBottomRef.current = true;
      const created = await postAiMessage(body.trim(), attachments, lastSection);
      setMessages((p) => [...p, created]);
      setBody("");
      setPending([]);
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
          Чат з АІ-аналітиком: знає бізнес-логіку проєкту, дістає статистику з бази і на прохання будує графіки/таблиці в розділі «Мої звіти». Можна прикріпити скрін (📎 або Ctrl+V).
        </p>
        <div
          ref={scrollRef}
          onScroll={onScroll}
          style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10, padding: "8px 0" }}
        >
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
                    {m.attachments && m.attachments.length > 0 && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: m.body ? 8 : 0 }}>
                        {m.attachments.map((a, i) => (
                          <a key={i} href={`${FILES_BASE}${a.url}`} target="_blank" rel="noreferrer">
                            <img src={`${FILES_BASE}${a.url}`} alt={a.name}
                              style={{ maxWidth: 220, maxHeight: 220, borderRadius: 8, display: "block", border: "1px solid var(--border)" }} />
                          </a>
                        ))}
                      </div>
                    )}
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
        </div>

        {pending.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
            {pending.map((p, i) => (
              <div key={i} style={{ position: "relative" }}>
                <img src={p.preview} alt={p.name}
                  style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 8, border: "1px solid var(--border)" }} />
                <button
                  onClick={() => setPending((prev) => prev.filter((_, j) => j !== i))}
                  title="Прибрати"
                  style={{ position: "absolute", top: -6, right: -6, width: 18, height: 18, borderRadius: "50%", border: "none", background: "#c5141c", color: "#fff", fontSize: 11, lineHeight: "18px", cursor: "pointer", padding: 0 }}
                >×</button>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 8, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
          <input ref={fileRef} type="file" accept="image/*" multiple hidden
            onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }} />
          <button
            onClick={() => fileRef.current?.click()}
            title="Прикріпити зображення"
            style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", cursor: "pointer", alignSelf: "stretch", fontSize: 18 }}
          >📎</button>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send(); }}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files);
              if (files.length) { addFiles(files); e.preventDefault(); }
            }}
            placeholder="Питання чи прохання побудувати звіт… (Ctrl+Enter — надіслати, Ctrl+V — вставити скрін)"
            rows={2}
            style={{ flex: 1, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", resize: "vertical" }}
          />
          <button className="btn-primary" onClick={send} disabled={sending || (!body.trim() && !pending.length)}
            style={{ padding: "8px 18px", borderRadius: 8, border: "none", background: sending || (!body.trim() && !pending.length) ? "#94a3b8" : "#c5141c", color: "#fff", fontWeight: 600, cursor: sending || (!body.trim() && !pending.length) ? "default" : "pointer", alignSelf: "stretch" }}>
            {sending ? "…" : "Надіслати"}
          </button>
        </div>
      </div>
    </>
  );
}

import { useEffect, useState } from "react";
import { fetchClientContacts, fetchContactFileBlobUrl, contactChannelLabel, type ClientContact } from "../../../api";

/**
 * 📎 ПЕРЕГЛЯД СКРИНУ КОНТАКТУ — НА МІСЦІ, А НЕ В НОВІЙ ВКЛАДЦІ (задача 4310, п.1.3).
 *
 * 🔴 ЧОМУ НЕ `window.open`. Доти кнопка робила `await fetch…` і лише ПОТІМ
 * `window.open(blob)`. Після очікування браузер уже не вважає це кліком людини і
 * блокує вікно як спливне — у Юлі й Дмитрука «не клікалось» саме так, хоча сервер
 * віддавав файл із 200 (заміряно 24.09.2026). Відмову блокувальника неможливо
 * відрізнити від роботи: не відбувається нічого. Той самий клас задачник уже лікував
 * (`TaskFilesViewer`, #400o), і тут той самий спосіб.
 *
 * 🔒 Байти йдуть з ЗАГОЛОВКОМ авторизації (`api.get` → blob), тож `<img src="/api/…">`
 * не годиться: токен у заголовку, не в URL. Звідси blob-URL і `revokeObjectURL`.
 *
 * ⬇️ «Завантажити» — звичайне посилання з `download` на вже отриманий blob: клік по
 * ньому синхронний, блокувальник його не чіпає.
 *
 * ⚠️ ВІДМОВА НАЗИВАЄ СЕБЕ: текст сервера (403 «Forbidden», 404 «Файл відсутній на
 * диску») показується як є. Порожнє вікно читалось би як «скрину немає».
 */
export function ClientContactFileViewer({ clientKey, clientName, initialId, contacts, onClose }: {
  clientKey: string;
  clientName?: string | null;
  /** Який скрин відкрити першим; без нього — найсвіжіший. */
  initialId?: number | null;
  /** Уже завантажені контакти (картка їх має) — щоб не тягнути вдруге. */
  contacts?: ClientContact[];
  onClose: () => void;
}) {
  const [list, setList] = useState<ClientContact[] | null>(contacts ? contacts.filter((c) => c.hasFile) : null);
  const [pick, setPick] = useState<number | null>(initialId ?? contacts?.find((c) => c.hasFile)?.id ?? null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (contacts) return;
    let alive = true;
    fetchClientContacts(clientKey)
      .then((cs) => {
        if (!alive) return;
        const files = cs.filter((c) => c.hasFile);
        setList(files);
        setPick((p) => p ?? files[0]?.id ?? null);
      })
      .catch((e) => { if (alive) setErr(errText(e, "контакти не завантажились")); });
    return () => { alive = false; };
  }, [clientKey, contacts]);

  /* Сторож `alive` — той самий, що в `TaskFilesViewer`: інакше повільний попередній
     файл затирає вже показаний наступний, а його blob не відкликається ніколи. */
  useEffect(() => {
    if (pick == null) { setBlobUrl(null); return; }
    let alive = true;
    let u: string | null = null;
    setBlobUrl(null);
    setErr(null);
    fetchContactFileBlobUrl(pick)
      .then((url) => { u = url; if (alive) setBlobUrl(url); else URL.revokeObjectURL(url); })
      .catch((e) => { if (alive) setErr(errText(e, "скрин не відкрився")); });
    return () => { alive = false; if (u) URL.revokeObjectURL(u); };
  }, [pick]);

  const cur = list?.find((c) => c.id === pick) ?? null;
  const isImage = blobUrl != null;

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2700, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--card-bg)", color: "var(--text)",
        borderRadius: "var(--r-lg)", padding: "var(--sp-5)", width: "92vw", maxWidth: 920, maxHeight: "90vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 12 }}>
          <h2 className="chart-title" style={{ marginBottom: 0 }}>📎 Скрини · {clientName || clientKey}</h2>
          <button onClick={onClose} style={{ border: "1px solid var(--border)", background: "var(--card-bg)",
            color: "var(--text)", borderRadius: "var(--r-md)", padding: "4px 12px", cursor: "pointer" }}>✕</button>
        </div>
        {list && list.length > 1 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
            {list.map((c) => (
              <button key={c.id} onClick={() => setPick(c.id)}
                style={{ fontSize: 12, padding: "3px 10px", borderRadius: 999, cursor: "pointer",
                  border: "1px solid var(--border)", background: c.id === pick ? "var(--text)" : "var(--card-bg)",
                  color: c.id === pick ? "var(--card-bg)" : "var(--text)" }}>
                {c.createdAt.slice(0, 10).split("-").reverse().join(".")} · {contactChannelLabel(c.channel)}
              </button>
            ))}
          </div>
        )}
        {err && <div style={{ color: "#b91c1c", fontSize: 13, marginBottom: 8 }}>🔴 {err}</div>}
        {list && list.length === 0 && !err && (
          <div style={{ color: "var(--text-muted)", fontSize: 13 }}>У контактах цього клієнта скринів немає.</div>
        )}
        {cur && (
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>
            {cur.author && <>{cur.author} · </>}{cur.fileName ?? "скрин"}
            {cur.note && <div style={{ color: "var(--text)", marginTop: 4, whiteSpace: "pre-wrap" }}>{cur.note}</div>}
          </div>
        )}
        {pick != null && !blobUrl && !err && <div style={{ color: "var(--text-muted)", fontSize: 13 }}>завантаження скрину…</div>}
        {isImage && (
          <>
            <img src={blobUrl!} alt={cur?.fileName ?? "скрин"} style={{ maxWidth: "100%", borderRadius: 8, display: "block" }} />
            <a href={blobUrl!} download={cur?.fileName ?? "скрин"}
              style={{ display: "inline-block", marginTop: 10, fontSize: 13, fontWeight: 600 }}>⬇️ Завантажити</a>
          </>
        )}
      </div>
    </div>
  );
}

function errText(e: unknown, fallback: string): string {
  const r = (e as { response?: { status?: number; data?: unknown } })?.response;
  const d = r?.data as { error?: string } | undefined;
  if (d && typeof d.error === "string") return d.error;
  // blob-відповідь на помилку приходить Blob-ом, а не JSON — тоді кажемо хоча б статус.
  if (r?.status) return `${fallback} (код ${r.status})`;
  return fallback;
}

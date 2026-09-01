import { useEffect, useState } from "react";
import { fetchUnmergePreview, revokeMerge, type UnmergePreviewData } from "../../../api";

/**
 * 🔓 ДІАЛОГ РОЗʼЄДНАННЯ — наслідки ПОКАЗУЮТЬСЯ ДО ДІЇ.
 *
 * Симетрично до `MergeDialog`, який показує сторони перед обʼєднанням. Розʼєднання
 * пише в бойові дані, і єдина річ, яку воно втрачає назавжди — ліміт канонічного
 * клієнта до злиття, — мусить бути названа ДО натискання, а не після.
 *
 * 🔴 ЖОДНОГО ЧИСЛА ЦЕЙ ФАЙЛ НЕ РАХУЄ. Усе — з `buildUnmergePreview` у ядрі, яке
 * стережуть `#265`-`#268`. Порахувати суму «тут-таки з рядків екрана» означало б
 * завести другу копію правила, і вона розійшлася б із тим, що станеться насправді.
 */
export function UnmergeDialog(
  { canonical, canonicalName, onClose, onDone }:
  { canonical: string; canonicalName: string; onClose: () => void; onDone: () => void },
) {
  const [data, setData] = useState<UnmergePreviewData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchUnmergePreview(canonical)
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setErr(e?.response?.data?.error ?? "Не вдалося зібрати превʼю"); });
    return () => { alive = false; };
  }, [canonical]);

  const money = (n: number) => new Intl.NumberFormat("uk-UA").format(Math.round(n)) + " ₴";

  const run = async () => {
    if (!data) return;
    setBusy(true);
    try {
      // Псевдоніми знімаються по одному — той самий `revoke`, що й на «Клієнтах».
      for (const s of data.splitsInto.slice(1)) await revokeMerge(s.clientKey);
      onDone();
      onClose();
    } catch (e) {
      setErr((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "Не вдалося розʼєднати");
    } finally { setBusy(false); }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", display: "grid",
                  placeItems: "center", zIndex: 50 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}
           style={{ background: "var(--card-bg)", color: "var(--text)", border: "1px solid var(--border)",
                    borderRadius: 12, padding: 20, width: "min(680px, 92vw)", maxHeight: "86vh",
                    overflowY: "auto", font: "inherit", fontSize: "var(--fs-13)" }}>
        <h3 style={{ margin: "0 0 12px" }}>Розʼєднати «{canonicalName}»</h3>

        {err && <p style={{ color: "var(--danger)" }}>🔴 {err}</p>}
        {!data && !err && <p>Збираю наслідки…</p>}

        {data && (
          <>
            <p style={{ margin: "0 0 8px" }}>
              Група розпадеться на <b>{data.parties}</b> юрособи — {money(data.amount)}, {data.invoices} рах.
            </p>
            <ul style={{ margin: "0 0 14px", paddingLeft: 18 }}>
              {data.splitsInto.map((s, i) => (
                <li key={s.clientKey}>
                  {s.name} — {money(s.amount)}, {s.invoices} рах.
                  {i === 0 && <span style={{ opacity: .7 }}> (канонічний)</span>}
                </li>
              ))}
            </ul>

            {/* 🔴 Головне попередження. Сервер гарантує, що воно НІКОЛИ не порожнє. */}
            <p style={{ margin: "0 0 12px", padding: "8px 10px", borderRadius: 8,
                        border: "1px solid var(--border)", background: "var(--bg)" }}>
              ⚠️ <b>Ліміт «{canonicalName}»:</b> {data.canonicalLimit.warning}
            </p>

            {data.aliasLimitsRestored.length > 0 && (
              <p style={{ margin: "0 0 12px" }}>
                🟢 Знову почнуть діяти власні ліміти: {data.aliasLimitsRestored
                  .map((a) => `${a.clientKey} — ${a.days == null ? "сума" : `${a.days} дн.`}`).join(" · ")}
              </p>
            )}

            {data.ownerlessNotes.length > 0 && (
              <div style={{ margin: "0 0 12px" }}>
                <b>Домовленості, поставлені вже на обʼєднану групу</b> — вони лишаться на
                «{canonicalName}», бо стосуються групи, а не окремої юрособи:
                <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                  {data.ownerlessNotes.map((n, i) => (
                    <li key={i}>{n.text}{n.dueDate ? ` — до ${n.dueDate}` : ""} <span style={{ opacity: .7 }}>({n.createdAt})</span></li>
                  ))}
                </ul>
              </div>
            )}

            <p style={{ margin: "0 0 16px", opacity: .8 }}>
              Знову стануть видимими домовленості юросіб: <b>{data.notesBecomingVisible}</b>.
              Дебіторка перебудується синком — до {data.rebuildMinutes} хв, не миттєво.
            </p>

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={onClose} disabled={busy} style={{ font: "inherit", padding: "6px 14px" }}>
                Скасувати
              </button>
              <button onClick={run} disabled={busy} style={{ font: "inherit", padding: "6px 14px", fontWeight: 600 }}>
                {busy ? "Розʼєдную…" : "Розʼєднати"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

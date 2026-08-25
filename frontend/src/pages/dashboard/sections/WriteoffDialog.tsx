import { useState } from "react";
import { writeOffReceivable, revokeReceivableWriteoff } from "../../../api";
import { formatAmount } from "../format";
import { writeoffProblem, writtenOffLabel } from "../receivablesView";

/**
 * 🗑 СПИСАННЯ БЕЗНАДІЙНОГО БОРГУ — рівень рахунка або клієнта цілком.
 *
 * Рішення власника 25.08.2026: списання ЗМЕНШУЄ суму на плитці. Це не «сховати
 * з очей» — це визнання, що грошей не буде.
 *
 * 🔴 ТРИ ВИМОГИ ВЛАСНИКА, І ЖОДНА З НИХ НЕ КОСМЕТИЧНА:
 *   ВИДИМЕ    — поруч із сумою «списано: N на X ₴». Плитка, що просіла мовчки,
 *               читається як поломка (урок «Прострочено (понад ліміт)»).
 *   ІЗ ПРИЧИНОЮ — примітку вимагає `CHECK` у БД, а не лише ця форма. Роут можна
 *               обійти скриптом, `CHECK` — ні.
 *   ОБОРОТНЕ  — скасування ТИМ САМИМ інтерфейсом. Незворотна кнопка на грошах —
 *               пастка, навіть коли працює правильно (правило власника 06.08.2026).
 *
 * ⚠️ Права тут НЕ перевіряються: кнопки, яка це відкриває, у решти ролей просто
 * НЕМАЄ — `canWriteOff` рахує сервер тим самим виразом, що гейтить роут. Фронт
 * своєї думки про доступ не має і мати не повинен.
 */
export function WriteoffDialog({ clientKey, clientName, invoiceNo, amount, alreadyWritten, onDone, onClose }: {
  clientKey: string;
  clientName: string;
  /** `null` — списуємо клієнта ЦІЛКОМ (усі його рахунки на момент дії). */
  invoiceNo: string | null;
  amount: number;
  /** Скільки вже списано в цій області. `n = 0` — скасовувати нічого. */
  alreadyWritten: { n: number; amount: number };
  onDone: () => void;
  onClose: () => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const problem = writeoffProblem(note);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setErr(null);
    try { await fn(); onDone(); }
    catch (e) {
      const r = e as { response?: { data?: { error?: string } } };
      setErr(r?.response?.data?.error ?? "Не вдалось зберегти");
      setBusy(false);
    }
  };

  // Той самий механізм, що в `LimitEditor`: на вузькому екрані таблиця
  // скролиться горизонтально і різала б поповер разом із кнопками.
  const narrow = typeof window !== "undefined" && window.innerWidth < 900;
  const box: React.CSSProperties = narrow
    ? { position: "fixed", zIndex: 60, left: "50%", top: "50%", transform: "translate(-50%, -50%)",
        width: "min(360px, calc(100vw - 32px))", maxHeight: "calc(100vh - 32px)", overflowY: "auto",
        padding: 14, background: "var(--card-bg)", border: "1px solid var(--border)",
        borderRadius: 12, boxShadow: "0 18px 50px rgba(0,0,0,0.45)", textAlign: "left" }
    : { position: "absolute", zIndex: 30, marginTop: 4, right: 0, width: 320, padding: 12,
        background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 10,
        boxShadow: "0 8px 24px rgba(0,0,0,0.18)", textAlign: "left" };

  const btn = (bg: string): React.CSSProperties => ({
    font: "inherit", fontSize: "var(--fs-13)", fontWeight: 600, padding: "6px 10px", borderRadius: 8,
    border: "1px solid var(--border)", background: bg, color: "var(--text)",
    cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1,
  });

  const scope = invoiceNo ? `рахунок № ${invoiceNo}` : "УСІ рахунки клієнта";

  return (
    <>
      {narrow && (
        <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 59, background: "rgba(0,0,0,0.45)" }} />
      )}
      <div style={box}>
        <div style={{ fontSize: "var(--fs-13)", fontWeight: 700, marginBottom: 2 }}>Списати безнадійний борг</div>
        <div style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)", marginBottom: 8, lineHeight: 1.4 }}>
          {clientName}: <b>{scope}</b> на <b>{formatAmount(amount)}</b>
          {/* 🔴 НАСЛІДОК НАЗВАНО ДО ДІЇ, а не після. Списання зменшує суму на
              плитці — людина мусить знати це ДО кліку, а не побачити просілу
              цифру завтра. */}
          <div style={{ marginTop: 3 }}>
            Сума зменшиться на плитці й у рядку. Поруч зʼявиться підпис «списано»,
            {invoiceNo ? " а рахунок лишиться видимим у розкритті." : " а рахунки лишаться видимими у розкритті."}
          </div>
          {/* Списання клієнта розгортається в перелік ЙОГО рахунків у момент дії:
              завтрашній новий рахунок списаним НЕ буде. Це треба сказати вголос —
              інакше людина вважатиме, що клієнт списаний «назавжди». */}
          {!invoiceNo && (
            <div style={{ marginTop: 3 }}>
              Списуються рахунки, що є <b>зараз</b>. Новий рахунок цього клієнта
              списаним не стане — його доведеться списати окремо.
            </div>
          )}
          {alreadyWritten.n > 0 && (
            <div style={{ marginTop: 4, color: "var(--warn)" }}>Уже {writtenOffLabel(alreadyWritten.n, alreadyWritten.amount)}</div>
          )}
        </div>

        <textarea value={note} onChange={(e) => setNote(e.target.value.slice(0, 300))}
          placeholder="Чому цей борг безнадійний?"
          style={{ font: "inherit", fontSize: "var(--fs-sm)", padding: "6px 8px", borderRadius: 8, width: "100%",
                   minHeight: 52, resize: "vertical", border: "1px solid var(--border)",
                   background: "var(--input-bg)", color: "var(--text)", marginBottom: 4 }} />
        <div style={{ fontSize: "var(--fs-xs)", color: problem ? "var(--warn)" : "var(--text-muted)",
                      marginBottom: 8, lineHeight: 1.4 }}>
          {problem ?? `${note.trim().length}/300`}
        </div>

        {err && <div style={{ fontSize: "var(--fs-xs)", color: "var(--danger)", marginBottom: 6 }}>{err}</div>}

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button disabled={busy || problem != null} style={btn("var(--accent-soft)")}
            onClick={() => run(async () => {
              await writeOffReceivable({ clientKey, invoiceNo, note: note.trim() });
            })}>Списати</button>

          {/* 🔴 СКАСУВАННЯ — ТИМ САМИМ ІНТЕРФЕЙСОМ, і причина теж обовʼязкова:
              журнал мусить пояснювати обидві дії, інакше «списали й повернули»
              через місяць читається як збій. Кнопки немає, коли скасовувати
              нічого — інакше вона пропонувала б відкотити те, чого не було. */}
          {alreadyWritten.n > 0 && (
            <button disabled={busy || problem != null} style={btn("transparent")}
              title="Повернути списане в суму боргу"
              onClick={() => run(async () => {
                await revokeReceivableWriteoff({ clientKey, invoiceNo, note: note.trim() });
              })}>Скасувати списання</button>
          )}
        </div>

        <button disabled={busy} style={{ ...btn("transparent"), border: "none", display: "block",
                                         color: "var(--text-muted)", marginTop: 4 }}
          onClick={onClose}>Закрити</button>
      </div>
    </>
  );
}

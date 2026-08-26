import { useEffect, useState } from "react";
import { requestCreditLimit, createLimitTask, fetchManagerOptions, type LimitRequestDraft } from "../../../api";

/**
 * 🧾 ЗАПИТ НА ПЕРЕГЛЯД ЛІМІТУ — ФОРМА, А НЕ МОВЧАЗНА ДІЯ.
 *
 * 🔴 РІШЕННЯ ВЛАСНИКА 26.08.2026, І ВОНО СКАСУВАЛО ПОПЕРЕДНЄ. Було: кнопку
 * бачать усі, виконавець — операційний директор. Стало, дослівно:
 *   «задачі не операційний отримує, а тім-лід в межах своєї команди»
 *   «дедлайн обирає тім-лід коли ставить задачу»
 *
 * Тому кнопка НЕ створює задачу сама. Вона питає сервер заготовку — клієнта,
 * борг, стан ліміту, готовий заголовок — і показує форму, де виконавця й
 * дедлайн обирає той, хто ставить. Проставити їх за нього означало б завести
 * дефолт, якому через тиждень почнуть вірити.
 *
 * 🔴 ДРУГОЇ ЗАДАЧІ НЕ БУДЕ, І ТРИМАЄ ЦЕ БД. Частковий унікальний індекс
 * `idx_tasks_credit_limit_open` не дає існувати другому ВІДКРИТОМУ запиту на
 * того самого клієнта. Якщо запит уже є, сервер віддає ЙОГО — і ми показуємо
 * саме його, а не бадьоре «готово». Мовчазний успіх тут був би тією самою
 * «операцією, що звітує про роботу, якої не зробила», що й «успіх за 0 мс».
 */
export function LimitRequestDialog({ clientKey, onClose }: { clientKey: string; onClose: () => void }) {
  const [draft, setDraft] = useState<LimitRequestDraft | null>(null);
  const [existing, setExisting] = useState<{ id: number; title: string } | null>(null);
  const [managers, setManagers] = useState<{ id: number; name: string }[]>([]);
  const [assigneeId, setAssigneeId] = useState<string>("");
  const [deadline, setDeadline] = useState<string>("");
  const [priority, setPriority] = useState<"low" | "medium" | "high">("medium");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let alive = true;
    requestCreditLimit(clientKey)
      .then((r) => { if (!alive) return; setDraft(r.draft); setExisting(r.existing); })
      .catch((e) => {
        const x = e as { response?: { data?: { error?: string } } };
        if (alive) setErr(x?.response?.data?.error ?? "Не вдалось отримати дані");
      });
    fetchManagerOptions().then((m) => { if (alive) setManagers(m.map((x) => ({ id: x.id, name: x.name }))); }).catch(() => {});
    return () => { alive = false; };
  }, [clientKey]);

  const box: React.CSSProperties = {
    position: "fixed", zIndex: 60, left: "50%", top: "50%", transform: "translate(-50%, -50%)",
    width: "min(420px, calc(100vw - 32px))", maxHeight: "calc(100vh - 32px)", overflowY: "auto",
    padding: 16, background: "var(--card-bg)", border: "1px solid var(--border)",
    borderRadius: 12, boxShadow: "0 18px 50px rgba(0,0,0,0.45)", textAlign: "left",
  };
  const field: React.CSSProperties = {
    font: "inherit", fontSize: "var(--fs-13)", padding: "5px 8px", borderRadius: 8, width: "100%",
    border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--text)", marginBottom: 8,
  };
  const btn = (bg: string): React.CSSProperties => ({
    font: "inherit", fontSize: "var(--fs-13)", fontWeight: 600, padding: "6px 10px", borderRadius: 8,
    border: "1px solid var(--border)", background: bg, color: "var(--text)",
    cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1,
  });

  const submit = async () => {
    if (!draft) return;
    setBusy(true); setErr(null);
    try {
      await createLimitTask({
        clientKey: draft.clientKey,
        assigneeId: Number(assigneeId),
        deadline: deadline || null,
        priority,
      });
      setDone(true);
    } catch (e) {
      const x = e as { response?: { data?: { error?: string } } };
      setErr(x?.response?.data?.error ?? "Не вдалось створити задачу");
      setBusy(false);
    }
  };

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 59, background: "rgba(0,0,0,0.45)" }} />
      <div style={box} role="dialog" aria-label="Запит на перегляд ліміту">
        <div style={{ fontSize: "var(--fs-13)", fontWeight: 700, marginBottom: 8 }}>Запит на перегляд ліміту</div>

        {err && <div style={{ fontSize: "var(--fs-xs)", color: "var(--danger)", marginBottom: 8 }}>{err}</div>}

        {/* 🔴 НАЯВНИЙ ЗАПИТ ПОКАЗУЄМО, А НЕ РОБИМО ДРУГИЙ. Людина натиснула
            вдруге — вона мусить побачити, що вже поставила, а не «готово». */}
        {existing && (
          <div style={{ fontSize: "var(--fs-sm)", lineHeight: 1.5 }}>
            <div style={{ color: "var(--warn)", fontWeight: 600, marginBottom: 4 }}>
              Запит на цього клієнта вже відкритий
            </div>
            <div style={{ color: "var(--text-muted)" }}>{existing.title}</div>
            <div style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)", marginTop: 4 }}>
              Задача №{existing.id} — знайдіть її в Задачнику. Друга задача про той самий ліміт не створюється.
            </div>
            <button style={{ ...btn("transparent"), marginTop: 10 }} onClick={onClose}>Зрозуміло</button>
          </div>
        )}

        {done && (
          <div style={{ fontSize: "var(--fs-sm)", lineHeight: 1.5 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Задачу створено</div>
            <div style={{ color: "var(--text-muted)" }}>{draft?.title}</div>
            <button style={{ ...btn("transparent"), marginTop: 10 }} onClick={onClose}>Закрити</button>
          </div>
        )}

        {draft && !existing && !done && (
          <>
            {/* Предмет задачі видно ДО створення: клієнт, борг, стан ліміту. */}
            {/* 🔴 ЗАГОЛОВОК ПЕРЕНОСИТЬСЯ, А НЕ ОБРІЗАЄТЬСЯ. Він містить назву клієнта
                й суму боргу — саме те, заради чого його й будували; обрізаний на
                «…ліміт» він перестає бути предметом задачі. Спіймано скріншотом,
                не гейтом: довжина залежить від назви клієнта. */}
            <div style={{ fontSize: "var(--fs-sm)", fontWeight: 600, marginBottom: 2,
                          whiteSpace: "normal", overflowWrap: "anywhere", lineHeight: 1.35 }}>{draft.title}</div>
            <div style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)", marginBottom: 10, whiteSpace: "pre-line" }}>
              {draft.description}
            </div>

            <label style={{ display: "block", fontSize: "var(--fs-xs)", color: "var(--text-muted)", marginBottom: 3 }}>
              Виконавець
            </label>
            <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} style={field}>
              <option value="">— оберіть —</option>
              {managers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>

            <label style={{ display: "block", fontSize: "var(--fs-xs)", color: "var(--text-muted)", marginBottom: 3 }}>
              Дедлайн
            </label>
            <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} style={field} />

            <label style={{ display: "block", fontSize: "var(--fs-xs)", color: "var(--text-muted)", marginBottom: 3 }}>
              Пріоритет
            </label>
            <select value={priority} onChange={(e) => setPriority(e.target.value as "low" | "medium" | "high")} style={field}>
              <option value="low">низький</option>
              <option value="medium">середній</option>
              <option value="high">високий</option>
            </select>

            <div style={{ display: "flex", gap: 6 }}>
              {/* Без виконавця задача нікому не належить — кнопка неактивна,
                  а не «створить і хай хтось знайде». */}
              <button disabled={busy || !assigneeId} style={btn("var(--accent-soft)")} onClick={submit}>Створити задачу</button>
              <button disabled={busy} style={btn("transparent")} onClick={onClose}>Скасувати</button>
            </div>
          </>
        )}

        {!draft && !existing && !err && (
          <div className="loading-text" style={{ fontSize: "var(--fs-sm)" }}>Завантаження…</div>
        )}
      </div>
    </>
  );
}

import { useState, useEffect } from "react";
import { setReceivableOwner, clearReceivableOwner, type ManagerOption, type ReceivableClient } from "../../../api";
import { NOTE_MAX, noteIsValid, ownerState } from "../receivablesView";

/**
 * ✏️ ЗМІНА ВІДПОВІДАЛЬНОГО ЗА БОРГ КЛІЄНТА.
 *
 * 🔴 ТРИ ДІЇ, А НЕ ДВІ — і на екрані теж, не лише в БД:
 *   «Призначити»         → PUT з менеджером    → override
 *   «Свідомо нікого»     → PUT з managerId=null → override на NULL
 *   «Зняти призначення»  → DELETE               → авто-правило вмикається назад
 * Друга і третя дають ОДНАКОВЕ «нікого» на екрані, але різні відповіді на
 * питання «чому»: свідоме рішення проти «ще не дивились». Звести їх = стерти
 * рішення людини. Тримає `#162`.
 *
 * 🔴 ПІСЛЯ ДІЇ — ПЕРЕЧИТУЄМО, а не малюємо оптимістично. Сервер після обох
 * записів робить `recomputeOwners`, тож правильний відповідальний (і його
 * `ownerSource`) відомий ЛИШЕ з наступної відповіді. Намалюємо своє — екран
 * розійдеться з БД до перезавантаження, і це найтихіший спосіб збрехати.
 * Тримає `#166`.
 */
export function OwnerEditor({ client, managers, onDone, onClose }: {
  client: ReceivableClient & { managerName: string };
  managers: ManagerOption[];
  onDone: () => void;
  onClose: () => void;
}) {
  // ⌨️ ESC ЗАКРИВАЄ. Не було — і модалку можна було покинути, лише знайшовши
  // «Скасувати». Знайдено власним гейтом `#193`: він тиснув Escape, діалог
  // лишався, його підкладка накривала таблицю — і наступний клік по клієнту
  // «не проходив». Тобто відсутність Esc виглядала як зламане розкриття.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const state = ownerState(client);
  const [managerId, setManagerId] = useState<number | "">("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setErr(null);
    try { await fn(); onDone(); }
    catch (e: unknown) {
      const r = (e as { response?: { data?: { error?: string } } }).response;
      // Показуємо ТЕКСТ СЕРВЕРА як є: він пояснює причину краще за наш переказ.
      setErr(r?.data?.error ?? "Не вдалось зберегти");
      setBusy(false);
    }
  };

  const noteOk = noteIsValid(note);

  // 🔴 НА ВУЗЬКОМУ ЕКРАНІ — ФІКСОВАНА КАРТКА, НЕ ПОПОВЕР.
  //
  // Таблиця боржників скролиться горизонтально (`overflow-x: auto`), а поповер
  // лежить ВСЕРЕДИНІ неї. На 430px його правий край обрізався контейнером —
  // кнопки «Призначити» й «Скасувати» ставали недосяжні, тобто контрол просто
  // не працював. Знайдено скріншотом живого прода: жоден гейт цього не бачить,
  // бо в DOM кнопки є, і клік по них із коду проходить.
  //
  // Механізм узятий ТОЙ САМИЙ, що вже доведено в `MergeDialog` (фіксована картка
  // поверх усього) — а не «схожий»: два різні способи вилізти зі скрол-контейнера
  // розійшлися б у поведінці рівно тоді, коли на це ніхто не дивиться.
  const narrow = typeof window !== "undefined" && window.innerWidth < 900;
  const box: React.CSSProperties = narrow
    ? {
        position: "fixed", zIndex: 60, left: "50%", top: "50%",
        transform: "translate(-50%, -50%)", width: "min(340px, calc(100vw - 32px))",
        maxHeight: "calc(100vh - 32px)", overflowY: "auto", padding: 14,
        background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 12,
        boxShadow: "0 18px 50px rgba(0,0,0,0.45)", textAlign: "left",
      }
    : {
        position: "absolute", zIndex: 30, marginTop: 4, width: 320, padding: 12,
        background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 10,
        boxShadow: "0 8px 24px rgba(0,0,0,0.18)", textAlign: "left",
      };
  const btn = (bg: string): React.CSSProperties => ({
    font: "inherit", fontSize: 12.5, fontWeight: 600, padding: "6px 10px", borderRadius: 8,
    border: "1px solid var(--border)", background: bg, color: "var(--text)",
    cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1,
  });

  return (
    <>
      {narrow && (
        <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 59,
          background: "rgba(0,0,0,0.45)" }} />
      )}
    <div style={box}>
      <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 2 }}>Відповідальний за борг</div>
      {/* 🔴 Відкритий стан ПРОДОВЖУЄ підпис закритого, а не стирає його: людина
          мусить бачити, ЧОМУ зараз саме так, перш ніж це міняти. */}
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8 }}>
        Зараз: <b style={{ color: "var(--text)" }}>{client.managerName}</b>
        {state === "auto" && " · визначено правилом"}
        {state === "manual" && " · призначено вручну"}
        {state === "manual-none" && " · свідомо нікого"}
        {client.majorityName && client.ownerSource === "none" && (
          <span style={{ display: "block" }}>мажоритар не в активних: {client.majorityName}</span>
        )}
      </div>

      <select value={managerId} onChange={(e) => setManagerId(e.target.value ? Number(e.target.value) : "")}
        disabled={busy}
        style={{ font: "inherit", fontSize: 12.5, padding: "5px 8px", borderRadius: 8, width: "100%", marginBottom: 8 }}>
        <option value="">— оберіть менеджера —</option>
        {managers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select>

      {/* 🔴 ПРИМІТКА ОБОВʼЯЗКОВА, і це `CHECK` у БД. Кнопки неактивні, поки її
          немає, — щоб людина побачила зрозумілу вимогу, а не помилку з мережі. */}
      <textarea value={note} maxLength={NOTE_MAX} disabled={busy}
        onChange={(e) => setNote(e.target.value)}
        // 🔴 Плейсхолдер КОРОТКИЙ, а пояснення — під полем. Довгий текст у
        // textarea на 54px обрізався на півслові («…не відрізнити від помил»),
        // тобто вимога звучала як недороблений інтерфейс. Спіймало око, не тест.
        placeholder="Чому саме так?"
        style={{ font: "inherit", fontSize: 12, padding: "6px 8px", borderRadius: 8, width: "100%",
                 minHeight: 46, resize: "vertical", border: "1px solid var(--border)",
                 background: "var(--card-bg)", color: "var(--text)", marginBottom: 4 }} />
      <div style={{ fontSize: 10.5, color: noteOk ? "var(--text-muted)" : "var(--warn)", marginBottom: 8, lineHeight: 1.4 }}>
        {noteOk
          ? `${note.trim().length}/${NOTE_MAX}`
          : "Обовʼязково: через місяць призначення без причини не відрізнити від помилки"}
      </div>

      {err && <div style={{ fontSize: 11.5, color: "#dc2626", marginBottom: 8 }}>🔴 {err}</div>}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        <button disabled={busy || !noteOk || managerId === ""} style={btn("var(--card-bg)")}
          title={!noteOk ? "Спершу примітка" : "Призначити обраного менеджера"}
          onClick={() => run(() => setReceivableOwner({ clientKey: client.clientKey, managerId: Number(managerId), note }))}>
          Призначити
        </button>
        <button disabled={busy || !noteOk} style={btn("var(--card-bg)")}
          title="Свідоме «нікого»: авто-правило вимикається, і це видно в підписі"
          onClick={() => run(() => setReceivableOwner({ clientKey: client.clientKey, managerId: null, note }))}>
          Свідомо нікого
        </button>
        {/* Показуємо лише там, де є що знімати: пропонувати зняти те, чого немає,
            означало б вигадати людині дію без наслідку. */}
        {state !== "auto" && (
          <button disabled={busy} style={btn("var(--card-bg)")}
            title="Прибрати ручне призначення — авто-правило вмикається назад"
            onClick={() => run(() => clearReceivableOwner(client.clientKey))}>
            Зняти призначення
          </button>
        )}
        <button disabled={busy} style={{ ...btn("transparent"), border: "none", color: "var(--text-muted)" }}
          onClick={onClose}>Скасувати</button>
      </div>
    </div>
    </>
  );
}

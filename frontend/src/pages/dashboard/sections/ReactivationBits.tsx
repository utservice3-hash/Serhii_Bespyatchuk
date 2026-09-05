import { useState, type ReactNode } from "react";

/**
 * ДІАЛОГИ РЕАКТИВАЦІЇ — спільні для екрана клієнтів.
 *
 * 🔴 ВИНЕСЕНО 05.09.2026 БЕЗ ЖОДНОЇ ЗМІНИ ПОВЕДІНКИ. Вкладки «Реактивація» і «План
 * місяця» злились в один список, тож діалоги мусять жити поза секцією, яка зникає.
 * Перенесено дослівно; окремий коміт від зміни поведінки — DoD п.6, інакше через
 * півроку переїзд файла читатиметься як зміна логіки.
 */
const S = {
  card: { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: "12px 14px" } as const,
  btn: (primary?: boolean) => ({ fontSize: 12, fontWeight: primary ? 700 : 500, padding: "6px 12px",
        borderRadius: 8, cursor: "pointer", border: primary ? "none" : "1px solid #d1d5db",
        background: primary ? "#111827" : "#fff", color: primary ? "#fff" : "#374151" } as const),
  input: { fontSize: 12, padding: "6px 9px", border: "1px solid #d1d5db", borderRadius: 8, width: "100%",
           boxSizing: "border-box" } as const,
};

export function Modal({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.45)", display: "flex",
                  alignItems: "center", justifyContent: "center", zIndex: 60 }}>
      <div style={{ ...S.card, width: 460, maxWidth: "92vw", boxShadow: "0 18px 48px rgba(0,0,0,.22)" }}>
        <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 10 }}>{title}</div>
        {children}
      </div>
    </div>
  );
}

export function CreateTaskDialog({ client, busy, onCancel, onSubmit }: {
  client: { clientKey: string; name: string }; busy: boolean;
  onCancel: () => void; onSubmit: (deadline: string, comment: string) => void;
}) {
  const inWeek = (() => { const d = new Date(); d.setDate(d.getDate() + 7); return d.toISOString().slice(0, 10); })();
  const [deadline, setDeadline] = useState(inWeek);
  const [comment, setComment] = useState("");
  return (
    <Modal title={`＋ Задача реактивації · ${client.name}`}>
      <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 10, lineHeight: 1.5 }}>
        Одна задача = один клієнт. Виконавець — основний менеджер цього клієнта.
        Закрити її буде можна лише з причиною.
      </div>
      <div style={{ fontSize: 10, letterSpacing: .4, textTransform: "uppercase", color: "#6b7280", marginBottom: 4 }}>Строк</div>
      <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} style={S.input} />
      <div style={{ fontSize: 10, letterSpacing: .4, textTransform: "uppercase", color: "#6b7280", margin: "10px 0 4px" }}>Що зробити (не обовʼязково)</div>
      <input value={comment} onChange={(e) => setComment(e.target.value)}
        placeholder="подзвонити, запропонувати серпневі тарифи" style={S.input} />
      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <button style={S.btn(true)} disabled={busy} onClick={() => onSubmit(deadline, comment)}>Створити</button>
        <button style={S.btn()} disabled={busy} onClick={onCancel}>Скасувати</button>
      </div>
    </Modal>
  );
}

export function CloseTaskDialog({ task, reasons, busy, onCancel, onSubmit }: {
  task: { taskId: number; name: string }; reasons: { key: string; label: string }[];
  busy: boolean; onCancel: () => void; onSubmit: (reason: string, note: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  // 🔴 «Інше» без пояснення — це та сама відсутність причини під іншою назвою.
  const needNote = reason === "other";
  const ready = reason !== "" && (!needNote || note.trim() !== "");
  return (
    <Modal title={`Закрити задачу · ${task.name}`}>
      <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 10, lineHeight: 1.5 }}>
        Причина обовʼязкова. Це єдине джерело даних про те, ЧОМУ клієнт не повернувся —
        без неї через півроку список покаже тих самих людей, і ніхто не згадає, чим скінчилась розмова.
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {reasons.map((r) => (
          <button key={r.key} onClick={() => setReason(r.key)}
            style={{ ...S.btn(reason === r.key), fontSize: 12 }}>{r.label}</button>
        ))}
      </div>
      <input value={note} onChange={(e) => setNote(e.target.value)}
        placeholder={needNote ? "Поясніть — для «Інше» обовʼязково" : "Деталі (не обовʼязково)"}
        style={{ ...S.input, marginTop: 10, borderColor: needNote && !note.trim() ? "#fca5a5" : "#d1d5db" }} />
      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <button style={S.btn(true)} disabled={busy || !ready} onClick={() => onSubmit(reason, note.trim())}>Закрити задачу</button>
        <button style={S.btn()} disabled={busy} onClick={onCancel}>Скасувати</button>
      </div>
    </Modal>
  );
}

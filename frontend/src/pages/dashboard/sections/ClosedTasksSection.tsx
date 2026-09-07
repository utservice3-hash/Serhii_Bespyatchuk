import { useEffect, useState } from "react";
import { fetchReactivationClosed, type ClosedTasksResp, type ClosedTaskRow } from "../../../api";

/**
 * 📋 РЕЄСТР ЗАКРИТИХ ЗАДАЧ РЕАКТИВАЦІЇ — «куди поділось те, що я закрив».
 *
 * 📐 Привід заміряний 07.09.2026 і він же задає форму екрана: закритих задач 205, а
 * закритих ЛЮДИНОЮ — жодної (194 — мітка нашого перенесення від 05.09, 11 пачок
 * закриті взагалі без причини). Тому клас стоїть у КОЖНОМУ рядку й окремою трійкою
 * зверху: інакше екран відрапортував би 205 опрацьованих клієнтів там, де роботи не було.
 */
const CLASS_STYLE: Record<ClosedTaskRow["closeClass"], { bg: string; fg: string }> = {
  human: { bg: "#dcfce7", fg: "#166534" },
  auto: { bg: "#e0e7ff", fg: "#3730a3" },
  legacy: { bg: "#f1f5f9", fg: "#334155" },
  none: { bg: "#f3f4f6", fg: "#4b5563" },
  unknown: { bg: "#fef3c7", fg: "#92400e" },
};

const Tile = ({ lab, val, sub }: { lab: string; val: string; sub: string }) => (
  <div className="orph-tile">
    <div className="orph-tile-lab">{lab}</div>
    <div className="orph-tile-val">{val}</div>
    <div className="orph-tile-sub">{sub}</div>
  </div>
);

export default function ClosedTasksSection() {
  const [data, setData] = useState<ClosedTasksResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [only, setOnly] = useState<ClosedTaskRow["closeClass"] | "all">("all");

  useEffect(() => {
    fetchReactivationClosed().then(setData)
      .catch(() => setErr("Не вдалося завантажити реєстр закритих"));
  }, []);

  if (err) return <div className="chart-card" style={{ padding: 20, color: "var(--danger)" }}>{err}</div>;
  if (!data) return <div className="loading-text" style={{ padding: 20 }}>Завантаження…</div>;

  /* 🔴 Порожньо називає СВОЮ причину: у тімліда це може означати «моя команда нічого
     не закривала», а не «закритих немає взагалі». Один текст на обидва випадки
     читався б як «фічі немає». */
  if (data.total === 0)
    return (
      <div className="chart-card" style={{ padding: 24, color: "var(--text-muted)" }}>
        {data.scope === "team"
          ? "Ваша команда ще не закрила жодної задачі реактивації. По компанії тут може бути не порожньо."
          : "Закритих задач реактивації немає."}
      </div>
    );

  const rows = only === "all" ? data.rows : data.rows.filter((r) => r.closeClass === only);
  const n = (k: ClosedTaskRow["closeClass"]) => data.byClass[k] ?? 0;

  return (
    <div>
      <div className="orph-tiles">
        <Tile lab="Закрито менеджером" val={String(n("human"))} sub="обрано причину зі списку" />
        <Tile lab="Опрацьовано до реєстру" val={String(n("legacy"))}
              sub="робота людей, перенесена 05.09 — автора не збережено" />
        <Tile lab="Закрито автоматично" val={String(n("auto"))} sub="клієнт повернувся, закрив крон" />
      </div>

      <div style={{ display: "flex", gap: 6, margin: "10px 0", flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>показати:</span>
        {([["all", "усі"], ["human", "менеджером"], ["legacy", "до реєстру"],
           ["auto", "автоматично"], ["none", "без причини"],
           ["unknown", "поза довідником"]] as const).map(([k, lab]) => (
          <button key={k} onClick={() => setOnly(k)}
            style={{ fontSize: 12, padding: "4px 10px", borderRadius: 999, cursor: "pointer",
                     border: `1px solid ${only === k ? "#1d4ed8" : "var(--border)"}`,
                     background: only === k ? "#eff6ff" : "transparent",
                     color: only === k ? "#1d4ed8" : "var(--text)" }}>
            {lab}{k !== "all" && ` · ${n(k as ClosedTaskRow["closeClass"])}`}
          </button>
        ))}
        <span style={{ fontSize: 12, color: "var(--text-muted)", marginLeft: "auto" }}>
          показано {rows.length} із {data.total}
          {data.scope === "team" && " · лише ваша команда"}
        </span>
      </div>

      <div className="chart-card" style={{ padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--text-muted)", fontSize: 12 }}>
              <th style={{ padding: "8px 10px" }}>Клієнт</th>
              <th style={{ padding: "8px 10px" }}>Причина</th>
              <th style={{ padding: "8px 10px" }}>Хто закрив</th>
              <th style={{ padding: "8px 10px" }}>Коли</th>
              <th style={{ padding: "8px 10px" }}>Виконавець</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const st = CLASS_STYLE[r.closeClass];
              return (
                <tr key={r.taskId} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={{ padding: "8px 10px" }}>
                    {r.clientName ?? r.title}
                    {r.taskType === "reactivation" && (
                      <span style={{ fontSize: 11, color: "var(--text-muted)" }}> · пачка</span>
                    )}
                  </td>
                  <td style={{ padding: "8px 10px" }}>
                    <span style={{ display: "inline-block", padding: "1px 8px", borderRadius: 999,
                                   fontSize: 11, fontWeight: 700, background: st.bg, color: st.fg }}>
                      {r.closeClassLabel}
                    </span>
                    {/* Сирий текст показуємо лише для людських причин: службова мітка
                        нічого людині не каже, а її підпис уже стоїть чипом. */}
                    {r.closeClass === "human" && r.closeReason && (
                      <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>{r.closeReason}</div>
                    )}
                  </td>
                  <td style={{ padding: "8px 10px", color: r.closedBy ? undefined : "var(--text-muted)" }}>
                    {/* 🔴 Не підставляємо виконавця замість автора: до 07.09.2026 автора
                        не записували ніде, і «хто закрив» на старих рядках відповіді не
                        має. Підстановка виглядала б як відповідь. */}
                    {r.closedBy ?? (r.closeClass === "auto" ? "система" : "автора не записано")}
                  </td>
                  <td style={{ padding: "8px 10px", whiteSpace: "nowrap" }}>{r.closedAt ?? "—"}</td>
                  <td style={{ padding: "8px 10px" }}>
                    {r.assignee ?? "—"}
                    {r.teamName && <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{r.teamName}</div>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

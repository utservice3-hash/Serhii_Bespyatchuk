import type { Task } from "../../../api";

/**
 * ⏱ РЯДКИ ЗАДАЧІ ТІМЛІДУ «ПРОПУСТИЛИ РИТМ, РОБОТИ НЕМАЄ» (задача 11229, рішення Романа 27.11.2026).
 *
 * Задача одна на менеджера, клієнти — рядки-діти (`rhythm_client`). Числа в рядку — знімок ранкового проходу
 * (`jobs/rhythmTaskSweep.ts`), оновлюється щодня, поки рядок відкритий. Рядок закривається сам, щойно з клієнтом
 * попрацювали; тімлід може закрити його й галочкою. Правило й тексти причин — на сервері, тут лише показ.
 */
interface Facts { usualDays?: number | null; orderDays?: number | null; overDays?: number | null; lastTalk?: string | null }
const dm = (ymd: string): string => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}`;
/** Причина автозакриття без службового початку — у рядку досить суті. */
const shortReason = (r: string): string => r.replace(/^Закрито автоматично:\s*/, "").replace(/\.$/, "");

export function RhythmPackRows({ pack, kids, onToggle }: {
  pack: Task; kids: Task[]; onToggle: (kid: Task, next: "done" | "not_started") => void;
}) {
  if (kids.length === 0) return null;
  const doneN = kids.filter((k) => k.status === "done").length;
  const via = (pack.metricsJson as unknown as { via?: string } | null)?.via;
  const sorted = [...kids].sort((a, b) => Number(a.status === "done") - Number(b.status === "done") || a.title.localeCompare(b.title, "uk"));
  return (
    <div data-rhythm-pack style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }}>
      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
        Клієнти менеджера, які замовляють довше, ніж зазвичай, і з якими не працюють. Рядок закриється сам, щойно з клієнтом
        попрацюють: розмова від 10 секунд, коментар, контакт, зміна етапу, рахунок, оплата чи нова угода.
        {via === "head" && " У менеджера немає тімліда, тому задача стоїть керівнику відділу продажу."}
      </div>
      {sorted.map((k) => {
        const kd = k.status === "done";
        const f = (k.metricsJson ?? {}) as unknown as Facts;
        return (
          <label key={k.id} data-rhythm-row style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13, cursor: "pointer" }}>
            <input type="checkbox" checked={kd} style={{ marginTop: 3 }} onChange={() => onToggle(k, kd ? "not_started" : "done")} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontWeight: 600, textDecoration: kd ? "line-through" : "none", opacity: kd ? 0.55 : 1 }}>{k.title}</span>
              <span style={{ display: "block", fontSize: 12, color: "var(--text-muted)", opacity: kd ? 0.7 : 1 }}>
                {f.usualDays != null ? `зазвичай раз на ${f.usualDays} дн.` : "звичайний інтервал невідомий"}
                {" · "}
                {f.orderDays != null ? `без замовлення ${f.orderDays} дн.` : "замовлень не було"}
                {f.overDays != null && ` (на ${f.overDays} довше)`}
                {" · "}
                {f.lastTalk ? `остання розмова ${dm(f.lastTalk)}` : "розмов від 10 секунд не було"}
              </span>
              {kd && (
                <span style={{ display: "block", fontSize: 12, color: "#15803d" }}>
                  {k.closeReason ? shortReason(k.closeReason) : "закрито вручну"}
                </span>
              )}
            </span>
          </label>
        );
      })}
      <span style={{ fontSize: 11, color: doneN === kids.length ? "#16a34a" : "var(--text-muted)", fontWeight: 600 }}>
        Опрацьовано {doneN}/{kids.length}
      </span>
    </div>
  );
}

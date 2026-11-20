import { useEffect, useState } from "react";
import { fetchKvpReport, fetchKvpPlan, saveKvpPlan, type KvpReport, type KvpPlans } from "../../../api";
import { useToast } from "../../../components/Toasts";
import { commitOptimistic, failureReason } from "../../../actionFeedback";
import { DatePicker } from "../../../components/DatePicker";
import { KvpPlanTable } from "./KvpReportSection";

const curMonth = () => { const d = new Date(); return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, "0")}`; };

/**
 * 🎯 «ПЛАНИ КВП» у розділі «Плани» (правки зустрічі 17.11.2026: «В планах можливість повну виставляти — повна таблиця
 * зі звіту КВП»). Це та сама таблиця, що до 17.11 жила згорнутою внизу Звіту КВП: той самий компонент, той самий
 * ендпоінт `/kvp-plan`, та сама таблиця `kvp_plans`. Звіт КВП тепер план лише ПОКАЗУЄ (блок «Показники місяця»).
 *
 * Межа доступу не змінилась: і читання, і запис гейтить сервер по екрану «Звіт КВП» (`roleHasTab(..., "kvp")`),
 * тому вкладку видно лише тим, у кого цей екран є; решта отримала б 403.
 */
export function KvpPlansTab() {
  const toast = useToast();
  const [month, setMonth] = useState<string>(curMonth);
  const [rep, setRep] = useState<KvpReport | null>(null);
  const [plans, setPlans] = useState<KvpPlans>({});
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true; setRep(null); setErr(null);
    fetchKvpReport({ preset: "month", date: month + "-01" })
      .then((r) => { if (alive) setRep(r); })
      .catch(() => { if (alive) setErr("Не вдалося завантажити факт місяця для таблиці планів."); });
    fetchKvpPlan(month).then((p) => { if (alive) setPlans(p); }).catch(() => { if (alive) setPlans({}); });
    return () => { alive = false; };
  }, [month]);

  const onSave = (k: string, val: number | null) => {
    // ↩ При помилці клітинка повертається до збереженого, а не бреше (30.09.2026, `#1102`).
    const before = plans;
    void commitOptimistic({
      apply: () => setPlans((p) => { const n = { ...p }; if (val == null) delete n[k]; else n[k] = val; return n; }),
      save: () => saveKvpPlan(month, { [k]: val }),
      revert: () => setPlans(before),
      onError: (e) => toast(`План не збережено — ${failureReason(e, "помилка сервера")}. Повернуто попереднє значення.`, { error: true }),
    });
  };

  return (
    <div className="chart-card" style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        <h2 className="chart-title" style={{ margin: 0 }}>🎯 Плани КВП
          <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 400 }}> · ✎ — ціль місяця; Звіт КВП показує її в «Показниках місяця»</span></h2>
        <DatePicker mode="month" value={month} onChange={(x) => x && setMonth(x.slice(0, 7))} minWidth={140} />
      </div>
      {err && <p className="loading-text" style={{ color: "#dc2626" }}>{err}</p>}
      {!rep && !err && <p className="loading-text">Завантаження…</p>}
      {rep && <KvpPlanTable rep={rep} plans={plans} onSave={onSave} />}
    </div>
  );
}

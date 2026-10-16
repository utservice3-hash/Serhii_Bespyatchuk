import { useEffect, useState } from "react";
import { fetchCarrierReport, type CarrierReportResp } from "../../api";

/**
 * 📊 Звіт «Дзвінки на мобільні» — ОДИН запит на екран «Звіт»: з нього і нижній блок, і мітка «чекають рішення» в рядку
 * менеджера (задача 5968). Два окремі запити могли б прийти в різні миті й показати різне число про ту саму людину.
 */
export interface CarrierReportState { rep: CarrierReportResp | null; hidden: boolean; err: string | null }

export function useCarrierReport(from: string, to: string, teamId?: number, managerId?: number): CarrierReportState {
  const [st, setSt] = useState<CarrierReportState>({ rep: null, hidden: false, err: null });
  useEffect(() => {
    let alive = true;
    setSt({ rep: null, hidden: false, err: null });
    fetchCarrierReport({ from, to, managerId, teamId })
      .then((x) => { if (alive) setSt({ rep: x, hidden: false, err: null }); })
      .catch((e) => {
        if (!alive) return;
        // Ролі без вкладки «Перевізники» — 403: блок і мітку ховаємо, а не показуємо помилку.
        if ((e as { response?: { status?: number } }).response?.status === 403) setSt({ rep: null, hidden: true, err: null });
        else setSt({ rep: null, hidden: false, err: e instanceof Error ? e.message : "Не вдалося завантажити" });
      });
    return () => { alive = false; };
  }, [from, to, teamId, managerId]);
  return st;
}

/** Мітка в рядку менеджера: скільки його угод чекають рішення зараз і скільки з них прострочено. */
export function awaitingByManager(rep: CarrierReportResp | null): Map<number, { awaitingNow: number; overdueNow: number }> {
  const m = new Map<number, { awaitingNow: number; overdueNow: number }>();
  for (const x of rep?.managers ?? []) if (x.managerId != null && x.awaitingNow > 0) m.set(x.managerId, { awaitingNow: x.awaitingNow, overdueNow: x.overdueNow });
  return m;
}

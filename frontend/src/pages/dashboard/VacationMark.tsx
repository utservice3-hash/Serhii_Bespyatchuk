import { useEffect, useState } from "react";
import { fetchOnVacation } from "../../api";

/**
 * 🏖 «У ВІДПУСТЦІ ДО ДД.ММ» БІЛЯ МЕНЕДЖЕРА (задача 5149, п.1 регламенту «Менеджер у відпустці»).
 *
 * ОДНЕ джерело для всіх екранів — `GET /duty/on-vacation` (погоджені відпустки з «Календаря команди» на сьогодні).
 * Свій значок на окремому екрані не пишемо: розійдеться з календарем (тримає #1806).
 * Запит один на вкладку і живе 10 хв — екранів зі значком кілька, а відповідь у них однакова.
 */

const TTL_MS = 10 * 60 * 1000;
let cache: { at: number; p: Promise<Map<number, string>> } | null = null;

function load(): Promise<Map<number, string>> {
  if (!cache || Date.now() - cache.at > TTL_MS) {
    const p = fetchOnVacation()
      .then((items) => new Map(items.filter((x) => x.managerId != null).map((x) => [x.managerId as number, x.until])))
      .catch(() => { cache = null; return new Map<number, string>(); }); // немає даних — значка немає, екран живий
    cache = { at: Date.now(), p };
  }
  return cache.p;
}

/** managerId → останній день відпустки (YYYY-MM-DD). */
export function useOnVacation(): Map<number, string> {
  const [m, setM] = useState<Map<number, string>>(new Map());
  useEffect(() => { let alive = true; void load().then((x) => { if (alive) setM(x); }); return () => { alive = false; }; }, []);
  return m;
}

export function VacationMark({ managerId }: { managerId: number | null | undefined }) {
  const m = useOnVacation();
  const until = managerId != null ? m.get(managerId) : undefined;
  if (!until) return null;
  const dm = `${until.slice(8, 10)}.${until.slice(5, 7)}`;
  return (
    <span title={`У відпустці до ${dm} включно (Календар команди)`}
      style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 600, padding: "1px 6px", borderRadius: "var(--r-pill, 20px)",
        background: "var(--info-bg)", color: "var(--info)", whiteSpace: "nowrap" }}>
      🏖 до {dm}
    </span>
  );
}

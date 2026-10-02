import { useState } from "react";
import { AdsSection } from "./AdsSection";
import { PeriodNav } from "../PeriodNav";
import { monthStart, periodOf, todayKyiv, type PeriodState } from "../periodRules";

/**
 * 📣 «РЕКЛАМА» — ОКРЕМИЙ РОЗДІЛ МЕНЮ (ТЗ «Статистики» 28.09.2026, блок 4, п.6; задача 4606).
 *
 * Доти вона жила вкладкою серед графіків Статистик, хоча зроблена в іншій логіці (календар день × кампанія,
 * а не часовий ряд показника). ТЗ: «це ок, але вона має жити окремо». Перенесено ДОСЛІВНО — той самий
 * навігатор періоду, що на Звіті, власний стан періоду, той самий `AdsSection`; змінилось лише місце.
 *
 * 📅 ПЕРІОД — ВЛАСНИЙ, а не спільний `dateRange` (урок 09.09.2026): спільний приїжджав зі Звіту/Огляду й
 * переживав перезавантаження, і екран відкривався з 14.07–14.07. Дефолт «Місяць»: у режимі «День» смуга днів
 * мала б одну кнопку — тобто відкривалась би тим порожнім екраном, від якого лікувались.
 */
export default function AdsPage({ role }: { role?: string }) {
  const today = todayKyiv();
  const [nav, setNav] = useState<PeriodState>({
    mode: "month", anchor: today, focusDay: today, rangeFrom: monthStart(today), rangeTo: today,
  });
  const adsPeriod = periodOf(nav);
  return (
    <div>
      <h1 className="page-title">📣 Реклама</h1>
      <PeriodNav state={nav} onPatch={(patch) => setNav((s) => ({ ...s, ...patch }))} today={today} />
      {/* Право змінювати план мусить збігатися з межами роуту PUT /settings/ad-plan
          (deny: kvp, financier, hr, team_lead, manager). */}
      <AdsSection from={adsPeriod.from} to={adsPeriod.to}
        canEditPlan={["admin", "ceo", "opdir"].includes(role ?? "")} />
    </div>
  );
}

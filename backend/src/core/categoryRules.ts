/**
 * ⓘ ПРАВИЛА КАТЕГОРІЙ КЛІЄНТА — ТЕКСТОМ, ЗІБРАНИМ ІЗ ЯДРА (ТЗ Юлі 22.09.2026, блок 2, п.2.4;
 * задача 4311: «підказка з правилом при наведенні на категорію; надіслати Юлі поточні
 * правила текстом на затвердження»).
 *
 * 🔴 ЧОМУ ТЕКСТ БУДУЄ СЕРВЕР, А НЕ ФРОНТ. Підпис, у якому поріг написаний руками, — друга
 * редакція правила: змінять поріг у `reactivationRules.ts`, а підказка й далі казатиме
 * старе число (саме так уже раз розійшлись «60/180» на екрані реактивації). Тут кожне
 * число підставляється з констант ядра, і фронт показує готовий рядок, нічого не знаючи
 * про пороги.
 *
 * Модуль чистий: жодного пулу, тож гейт перевіряє його без бази.
 */
import {
  QUALIFY_MIN_PAYMENTS, SEGMENT_MIN_PAYMENTS, VIP_MAX_GAP_DAYS,
  REGULAR_MAX_GAP_DAYS, SEGMENT_SLEEPING_DAYS, LOST_DAYS, LONG_LAPSED_DAYS,
  type ClientSegment,
} from "./reactivationRules.js";

export interface CategoryRuleNumbers {
  qualifyMinPayments: number;
  segmentMinPayments: number;
  vipMaxGapDays: number;
  regularMaxGapDays: number;
  sleepingDays: Record<ClientSegment, number>;
  lostDays: number;
  longLapsedDays: number;
}

/** Числа правил — рівно ті константи, що рахують категорію. */
export function ruleNumbers(): CategoryRuleNumbers {
  return {
    qualifyMinPayments: QUALIFY_MIN_PAYMENTS,
    segmentMinPayments: SEGMENT_MIN_PAYMENTS,
    vipMaxGapDays: VIP_MAX_GAP_DAYS,
    regularMaxGapDays: REGULAR_MAX_GAP_DAYS,
    sleepingDays: { ...SEGMENT_SLEEPING_DAYS },
    lostDays: LOST_DAYS,
    longLapsedDays: LONG_LAPSED_DAYS,
  };
}

const SEGMENT_LABEL: Record<ClientSegment, string> = {
  vip: "⚡ ВІП", regular: "🔁 Регулярний", episodic: "🌙 Епізодичний", unknown: "— без історії",
};

/** Частота сегмента одним реченням — з тих самих меж, що `segmentOf`. */
function frequency(n: CategoryRuleNumbers, s: ClientSegment): string {
  if (s === "vip") return `між оплатами до ${n.vipMaxGapDays} днів (медіана)`;
  if (s === "regular") return `між оплатами ${n.vipMaxGapDays + 1}–${n.regularMaxGapDays} днів (медіана)`;
  if (s === "episodic") return `між оплатами понад ${n.regularMaxGapDays} днів (медіана)`;
  return `менше ${n.segmentMinPayments} оплат — частоту рахувати нема з чого`;
}

/** Підказка на бейджі сегмента: частота + коли стає сплячим і втраченим. */
export function segmentTip(n: CategoryRuleNumbers, s: ClientSegment): string {
  return `${SEGMENT_LABEL[s]}: ${frequency(n, s)}. `
    + `Сплячий після ${n.sleepingDays[s]} днів без оплати, втрачений після ${n.lostDays}.`;
}

/** Підказки на чипах стану. */
export function stateTips(n: CategoryRuleNumbers): { sleeping: string; lost: string } {
  const sl = n.sleepingDays;
  return {
    sleeping: `💤 Сплячий: немає оплати ${sl.vip} днів у ВІП, ${sl.regular} у регулярного, `
      + `${sl.episodic} в епізодичного й без історії.`,
    lost: `❌ Втрачений: немає оплати ${n.lostDays} днів, для всіх сегментів. `
      + `Понад ${n.longLapsedDays} днів — «давно втрачений».`,
  };
}

/** Постійний клієнт — дзеркало `qualifiesAsRepeat`. */
export function qualifyText(n: CategoryRuleNumbers): string {
  return `Постійний: ${n.qualifyMinPayments}+ успішні угоди за всю історію — одне правило для безналу й готівки; `
    + `КВП може позначити постійним вручну з приміткою. Хто не проходить — «разовий».`;
}

/** Уся довідка «ⓘ Як рахуються категорії» — ті самі речення, що підуть Юлі на затвердження. */
export function rulesText(n: CategoryRuleNumbers): string[] {
  const st = stateTips(n);
  return [
    qualifyText(n),
    `Сегмент (потрібно ${n.segmentMinPayments}+ оплат): ${(["vip", "regular", "episodic"] as ClientSegment[])
      .map((s) => `${SEGMENT_LABEL[s]} — ${frequency(n, s)}`).join("; ")}; ${SEGMENT_LABEL.unknown} — ${frequency(n, "unknown")}.`,
    st.sleeping,
    st.lost,
  ];
}

/** Те, що їде у відповідь `/client-plans` і `/client-card` одним полем. */
export function categoryRulesPayload() {
  const n = ruleNumbers();
  return {
    numbers: n,
    segmentTips: {
      vip: segmentTip(n, "vip"), regular: segmentTip(n, "regular"),
      episodic: segmentTip(n, "episodic"), unknown: segmentTip(n, "unknown"),
    } as Record<ClientSegment, string>,
    stateTips: stateTips(n),
    text: rulesText(n),
  };
}
export type CategoryRulesPayload = ReturnType<typeof categoryRulesPayload>;

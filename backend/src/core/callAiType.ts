import type { ConversationType } from "./callAiProviders.js";

/**
 * 🗂 «У ЗВІТ ЧИ У ВИКЛЮЧЕНІ» (ТЗ «звіт тімліда» 30.09.2026, п.2). Модель лише називає тип розмови й упевненість;
 * куди розмова йде — вирішує це правило, одне на екран і на звіт:
 *   • ручна позначка тімліда чи адміна («Це вантаж» / «Це не вантаж») важить більше за модель — остання в журналі;
 *   • ще не розібрано (типу немає) — у звіті: невідоме не ховаємо;
 *   • `cargo_request` — у звіті;
 *   • будь-який інший тип з упевненістю < 0.85 — теж у звіті, з позначкою «Перевірити тип»: краще зайвий рядок у
 *     звіті, ніж схований клієнт;
 *   • решта — у «Виключених», з типом і причиною.
 * 05.10.2026 (рішення власника після перегляду «Виключених»):
 *   • `lead_lost` (запит став неактуальним) — у звіті, окремою колонкою «Втрачені ліди»: для тімліда це головний сигнал;
 *   • «інше» чи «без розмови», де менеджер домовився ПЕРЕДЗВОНИТИ, — у звіті як запит (`source: "rule"`). Перевізника,
 *     продавця, пошук роботи й помилку номером правило не чіпає: обіцянку їм теж дають, але клієнтами вони не стають.
 */
/** Типи, які правило «є домовленість передзвонити → запит» переводить у звіт. */
export const CALLBACK_RESCUES: ReadonlySet<string> = new Set(["other", "no_dialog"]);
export const TYPE_CONFIDENCE_MIN = 0.85;

export interface TypeOverride { isCargo: boolean; byName: string | null; at: string }

export interface TypeVerdict {
  inReport: boolean;
  /** Модель не впевнена — людині варто глянути. На ручно позначених не ставиться. */
  typeCheck: boolean;
  /** Звідки рішення: ручна позначка, модель чи «ще не розібрано». */
  source: "manual" | "model" | "rule" | "none";
}

export function typeVerdict(type: ConversationType | null | undefined, confidence: number | null | undefined,
  override: TypeOverride | null, callbackPromised = false): TypeVerdict {
  if (override) return { inReport: override.isCargo, typeCheck: false, source: "manual" };
  if (!type) return { inReport: true, typeCheck: false, source: "none" };
  // `call_later` (09.10.2026) — клієнт просив передзвонити: це клієнт, і передзвін рахується як обіцянка — у звіті.
  if (type === "cargo_request" || type === "lead_lost" || type === "call_later") return { inReport: true, typeCheck: false, source: "model" };
  if (callbackPromised && CALLBACK_RESCUES.has(type)) return { inReport: true, typeCheck: false, source: "rule" };
  const sure = typeof confidence === "number" && confidence >= TYPE_CONFIDENCE_MIN;
  return sure ? { inReport: false, typeCheck: false, source: "model" } : { inReport: true, typeCheck: true, source: "model" };
}

/** Хто може змінити тип: адмін — будь-яку розмову, тімлід — розмову своєї команди (скоуп перевіряє роут). */
export const TYPE_EDIT_ROLES: ReadonlySet<string> = new Set(["admin", "team_lead"]);
export const canEditType = (roleKey: string | null | undefined): boolean => roleKey != null && TYPE_EDIT_ROLES.has(roleKey);

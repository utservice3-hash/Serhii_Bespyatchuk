/**
 * 🔗 ПРИМІТКА KOMMO `lead_auto_created` → ПАРА «БАТЬКІВСЬКА УГОДА → ДОЧІРНЯ». Чиста, без імпортів:
 * гейт `#1094` проганяє її без `config`.
 *
 * Коли угоду створює автоматика CRM (кваліфікація лідгена → угода менеджеру), Kommo пише примітку в
 * ОБИДВІ угоди: у батьківську `params.lead_type = "child"`, `params.lead_id = <дочірня>`; у дочірню —
 * `"parent"`, `lead_id = <батьківська>`. Обидві дають ОДНУ й ту саму пару — тож їх можна приймати
 * будь-яку, а дедуп робить первинний ключ таблиці. Заміряно 30.09.2026 на угоді Сердюка 62338837 →
 * 62668945 (угода менеджера, 15 000 ₴, якої дашборд не бачив через порожній client_key).
 *
 * Невідомий тип, чужий `note_type`, неціле чи непозитивне id — `null`: краще не звʼязати, ніж звʼязати
 * не те (гроші тоді підуть не тому лідгену).
 */
export interface LeadChildLink { parentId: number; childId: number; createdAt: number }

export function parseLeadChildLink(n: {
  note_type?: unknown; entity_id?: unknown; created_at?: unknown;
  params?: { lead_type?: unknown; type?: unknown; lead_id?: unknown } | null;
}): LeadChildLink | null {
  if (n.note_type !== "lead_auto_created" || !n.params) return null;
  const self = Number(n.entity_id), other = Number(n.params.lead_id), at = Number(n.created_at);
  const ok = (x: number) => Number.isSafeInteger(x) && x > 0;
  if (!ok(self) || !ok(other) || self === other || !Number.isFinite(at)) return null;
  const kind = n.params.lead_type ?? n.params.type;
  if (kind === "child") return { parentId: self, childId: other, createdAt: at };
  if (kind === "parent") return { parentId: other, childId: self, createdAt: at };
  return null;
}

/**
 * 🗓 «ДОМОВЛЕНІСТЬ» ПО КЛІЄНТУ ДЕБІТОРКИ — ЧИ ЗАПИС ЩЕ ПРО ПОТОЧНИЙ БОРГ (06.10.2026).
 *
 * Привід: запис «Домовленість» (дата + коментар) жив на КЛІЄНТІ, і коли зʼявлялась нова угода, екран
 * далі показував стару дату з попередньої угоди (Бінарт: угода 62741529, у CRM оплата 06.10, на
 * екрані 31.08). Заміряно 06.10: 7 із 52 записів старші за найновішу угоду свого клієнта.
 *
 * ПРАВИЛО (одне на екран і на джобу задач):
 *   • запис привʼязаний до угоди (`deal_id`, з 06.10.2026) → актуальний, поки ця угода серед
 *     неоплачених рахунків клієнта;
 *   • старий запис без угоди → актуальний, лише якщо записаний НЕ раніше за створення найновішої
 *     неоплаченої угоди клієнта;
 *   • неоплачених угод не видно (рахунки з 1С без посилання) → запис актуальний, як і раніше.
 * Неактуальний запис НЕ видаляється: екран показує його сірим «з попередньої угоди», а дату бере з CRM.
 */

export function agreementActual(p: {
  noteDealId: number | null | undefined;
  noteUpdatedAt: string | null | undefined;
  openDealIds: readonly number[];
  newestDealAt: string | null | undefined;
}): boolean {
  if (p.noteDealId != null) return p.openDealIds.includes(p.noteDealId);
  if (!p.newestDealAt || !p.noteUpdatedAt) return true;
  return Date.parse(p.noteUpdatedAt) >= Date.parse(p.newestDealAt);
}

/**
 * До якої угоди привʼязати новий запис, якщо людина не обрала: та, що має НАЙРАНІШУ дату оплати
 * в CRM (найближчий борг); без дат — найновіша; угод немає — `null` (запис лишається клієнтським).
 */
export function defaultAgreementDeal(
  deals: readonly { dealId: number; crmDue: string | null; createdAt: string | null }[],
): number | null {
  if (deals.length === 0) return null;
  const withDue = deals.filter((d) => d.crmDue).sort((a, b) => (a.crmDue! < b.crmDue! ? -1 : a.crmDue! > b.crmDue! ? 1 : 0));
  if (withDue.length) return withDue[0].dealId;
  return [...deals].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))[0].dealId;
}

/**
 * Те саме правило в SQL — для джоби задач «отримати оплату» по клієнтському запису.
 * `n` — алиас `receivable_notes`. Угоди клієнта — з `service_url` його рахунків (той самий спосіб,
 * що в `receivablesFacts`). Задача по неактуальній (старій) даті більше не ставиться.
 */
export function agreementActualSql(n = "n"): string {
  return `(
    WITH open_deals AS (
      SELECT d.kommo_id, d.created_at_kommo
        FROM receivable_invoices ri
        JOIN deals d ON d.kommo_id = NULLIF(regexp_replace(COALESCE(ri.service_url, ''), '^.*/', ''), '')::bigint
       WHERE ri.client_key = ${n}.client_key
    )
    SELECT CASE
      WHEN ${n}.deal_id IS NOT NULL THEN EXISTS (SELECT 1 FROM open_deals o WHERE o.kommo_id = ${n}.deal_id)
      ELSE ${n}.updated_at >= COALESCE((SELECT max(o.created_at_kommo) FROM open_deals o), '-infinity'::timestamptz)
    END)`;
}

/**
 * 🚚 Угоди, що ЗАРАЗ стоять на етапі (для «Перевізників за розмовою»: після фільтра CRM). Статус — ПРЯМО з
 * Kommo, а не з `deals`: синк угод ходить раз на 30 хв, і з нашої таблиці «фільтр уже пропустив» видно
 * із запізненням до пів години. Один-два запити раз на 5 хв через спільний тротл і запобіжник (`client.ts`).
 * Більше `maxPages` сторінок — ПОМИЛКА, а не обрізаний список (той самий урок, що `fetchLeadsByIds`).
 * Окремий модуль без конфігу: розбір сторінок перевіряє гейт `#950b` без бази й без Kommo.
 */
export function stageLeadsPath(pipelineId: number, statusId: number, page: number): string {
  return `/api/v4/leads?limit=250&page=${page}`
    + `&filter[statuses][0][pipeline_id]=${pipelineId}&filter[statuses][0][status_id]=${statusId}`;
}

export async function pageStageLeads<L>(get: <T>(path: string) => Promise<T>, pipelineId: number, statusId: number,
  maxPages = 4): Promise<L[]> {
  const out: L[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await get<{ _embedded?: { leads?: L[] } }>(stageLeadsPath(pipelineId, statusId, page));
    const leads = data._embedded?.leads ?? [];
    out.push(...leads);
    if (leads.length < 250) return out;
  }
  throw new Error(`на етапі ${statusId} понад ${maxPages * 250} угод — обрізаний список гірший за помилку`);
}

/**
 * Джерело угод для реєстру мінусових угод — заміна `server/kommoClient.ts` пакета (рішення 20.10: «якщо в дашборді вже є
 * інтеграція з Kommo — візьміть її»). Ті самі три запити й той самий мапінг (`shared/kommoMapping.ts`: leadToCrmDeal,
 * stageName), але через НАШ `kommoGet` (передається параметром): спільний тротл і запобіжник від серії 403. Свій клієнт пакета обходив би їх —
 * а блокування Kommo за частоту в нас уже траплялось.
 *
 * Лише читання. Токен — наш `KOMMO_API_TOKEN` з `config`, окремий `KOMMO_TOKEN` пакета не потрібен.
 */
import type { CrmDeal } from "./shared/minusRegistry.js";
import { leadToCrmDeal, stageName, type KommoContact, type KommoLead, type KommoPipeline } from "./shared/kommoMapping.js";

/** Джерело угод для реєстру. null — угоди в CRM немає. Помилка зв'язку — KommoError. */
export interface DealSource { fetchDeal(dealId: string): Promise<CrmDeal | null> }

/** Помилка Kommo з HTTP-статусом для відповіді реєстру (502/503/504) — тексти ті самі, що в пакеті; токен у них не потрапляє. */
export class KommoError extends Error {
  constructor(message: string, readonly status: 502 | 503 | 504) { super(message); }
}

/** Наш `kommoRequest` кидає `Error("Kommo API error <код>: …")` або «circuit open» — переводимо в мову пакета. */
export function toKommoError(e: unknown): KommoError | null {
  const m = e instanceof Error ? e.message : String(e);
  if (/Kommo API error 404\b/.test(m)) return null;                       // угоди немає — як 404 → null у пакеті
  if (/circuit open/i.test(m) || /Kommo API error 429\b/.test(m)) return new KommoError("Kommo перевантажена — спробуйте за хвилину.", 503);
  if (/Kommo API error (401|403)\b/.test(m)) return new KommoError("Немає доступу до Kommo — перевірте токен інтеграції на сервері.", 502);
  if (/Kommo API error \d+/.test(m)) return new KommoError("Kommo відповіла помилкою.", 502);
  return new KommoError("Kommo не відповідає — спробуйте за хвилину.", 504);
}

type Get = <T>(path: string) => Promise<T>;

/**
 * `get` — у проді наш `kommoGet` (передають роут і джоба), у гейтах — фейкова Kommo. Параметром, а не імпортом: клієнт Kommo
 * тягне конфіг із обовʼязковою БД, і без цього модуль не можна було б перевірити без бази.
 */
export function kommoDealSource(get: Get, pipelinesTtlMs = 10 * 60_000): DealSource {
  /** GET: 404 → null, порожня відповідь (204 → `{}` у нашому клієнті) → null, решта помилок → KommoError. */
  const read = async <T>(path: string): Promise<T | null> => {
    try {
      const j = await get<T>(path);
      return j && typeof j === "object" && Object.keys(j as object).length === 0 ? null : j;
    } catch (e) {
      const k = toKommoError(e);
      if (k) throw k;
      return null;
    }
  };

  let pipes: { at: number; list: KommoPipeline[] } | null = null;
  async function getPipelines(): Promise<KommoPipeline[]> {
    if (pipes && Date.now() - pipes.at < pipelinesTtlMs) return pipes.list;
    const j = await read<{ _embedded?: { pipelines?: KommoPipeline[] } }>("/api/v4/leads/pipelines");
    pipes = { at: Date.now(), list: j?._embedded?.pipelines ?? [] };
    return pipes.list;
  }
  async function getContacts(ids: number[]): Promise<KommoContact[]> {
    if (!ids.length) return [];
    const q = ids.slice(0, 50).map((i) => `filter[id][]=${i}`).join("&");
    const j = await read<{ _embedded?: { contacts?: KommoContact[] } }>(`/api/v4/contacts?${q}&limit=50`);
    return j?._embedded?.contacts ?? [];
  }

  return {
    async fetchDeal(dealId: string): Promise<CrmDeal | null> {
      if (!/^\d{1,12}$/.test(dealId)) return null;
      const lead = await read<KommoLead>(`/api/v4/leads/${encodeURIComponent(dealId)}?with=contacts`);
      if (!lead || !lead.id) return null;
      const ids = (lead._embedded?.contacts || []).map((c) => c.id);
      const [contacts, pipelines] = await Promise.all([getContacts(ids), getPipelines()]);
      return leadToCrmDeal(lead, contacts, stageName(pipelines, lead));
    },
  };
}

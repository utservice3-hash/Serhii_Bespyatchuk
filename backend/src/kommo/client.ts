import { config } from "../config.js";

interface KommoListResponse<T> {
  _embedded?: Record<string, T[]>;
  _page?: number;
  _links?: { next?: { href: string } };
}

const MAX_RETRIES = 5;

async function kommoRequest<T>(path: string, attempt = 0): Promise<T> {
  const res = await fetch(`${config.kommo.baseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${config.kommo.token}`,
      "Content-Type": "application/json",
    },
  });
  if (res.status === 204) {
    return {} as T;
  }
  if (res.status === 429 && attempt < MAX_RETRIES) {
    const delayMs = 1000 * 2 ** attempt;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return kommoRequest<T>(path, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(`Kommo API error ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

export interface KommoDeal {
  id: number;
  name: string;
  price: number;
  pipeline_id: number;
  status_id: number;
  responsible_user_id: number;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

/**
 * Fetches leads updated since `updatedAfter` (unix seconds). Pass undefined
 * only for a deliberate full historical import — on a large, long-lived
 * account this can mean tens of thousands of leads across many pages.
 */
async function fetchLeadsPage(page: number, limit: number, filter: string): Promise<KommoDeal[]> {
  const data = await kommoRequest<KommoListResponse<KommoDeal>>(
    `/api/v4/leads?page=${page}&limit=${limit}${filter}`
  );
  return data._embedded?.leads ?? [];
}

const PAGE_FETCH_CONCURRENCY = 3;

export async function fetchAllDeals(updatedAfter?: number): Promise<KommoDeal[]> {
  const deals: KommoDeal[] = [];
  const limit = 250;
  const filter = updatedAfter
    ? `&${encodeURIComponent("filter[updated_at][from]")}=${updatedAfter}`
    : "";

  let page = 1;
  let exhausted = false;
  while (!exhausted) {
    const pageNumbers = Array.from({ length: PAGE_FETCH_CONCURRENCY }, (_, i) => page + i);
    const batches = await Promise.all(
      pageNumbers.map((p) => fetchLeadsPage(p, limit, filter))
    );
    for (const batch of batches) {
      deals.push(...batch);
      if (batch.length < limit) {
        exhausted = true;
      }
    }
    page += PAGE_FETCH_CONCURRENCY;
  }

  return deals;
}

export interface KommoUser {
  id: number;
  name: string;
  is_active: boolean;
}

export async function fetchUsers(): Promise<KommoUser[]> {
  const data = await kommoRequest<KommoListResponse<KommoUser>>(
    "/api/v4/users?limit=250&with=group"
  );
  const users = data._embedded?.users ?? [];
  return users.filter((user) => user.is_active);
}

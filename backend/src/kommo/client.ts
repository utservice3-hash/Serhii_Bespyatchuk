import { config } from "../config.js";

interface KommoListResponse<T> {
  _embedded?: Record<string, T[]>;
  _page?: number;
  _links?: { next?: { href: string } };
}

async function kommoRequest<T>(path: string): Promise<T> {
  const res = await fetch(`${config.kommo.baseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${config.kommo.token}`,
      "Content-Type": "application/json",
    },
  });
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

export async function fetchAllDeals(): Promise<KommoDeal[]> {
  const deals: KommoDeal[] = [];
  let page = 1;
  const limit = 250;

  while (true) {
    const data = await kommoRequest<KommoListResponse<KommoDeal>>(
      `/api/v4/leads?page=${page}&limit=${limit}`
    );
    const batch = data._embedded?.leads ?? [];
    deals.push(...batch);
    if (batch.length < limit) break;
    page += 1;
  }

  return deals;
}

export interface KommoUser {
  id: number;
  name: string;
}

export async function fetchUsers(): Promise<KommoUser[]> {
  const data = await kommoRequest<KommoListResponse<KommoUser>>("/api/v4/users");
  return data._embedded?.users ?? [];
}

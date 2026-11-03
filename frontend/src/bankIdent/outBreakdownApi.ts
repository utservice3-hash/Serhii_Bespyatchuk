/**
 * 💳 «Виписка» — розшифровка вихідних ФОП і картки (задача Тетяни 03.11.2026): клієнт `/api/bank-ident/out/*`.
 * Бачити — право `view_bank_out_breakdown` (фінанси й тімліди), писати — `edit_bank_out_breakdown`; межу тримає сервер.
 */
import { api } from "../api";

export const OUT_VIEW_PERM = "view_bank_out_breakdown";
export type OutStatus = "wait" | "ok" | "mismatch" | "unidentified" | "own";
export type OutFilter = "all" | "ok" | "wait" | "unidentified" | "corrected";

/** Вид рядка: угода (8–9 цифр) · операційний запит (до 7) · категорія текстом. `ref` — №/назва, `note` — примітка з дужок. */
export type OutKind = "deal" | "op" | "text";
export interface OutLineRaw { kind: OutKind; ref: string; amount: number; note?: string }
export interface OutLineView extends OutLineRaw { name: string | null; manager: string | null; known: boolean }
export interface OutState {
  txId: number; own: boolean; status: OutStatus; amount: number;
  lines: OutLineView[]; sum: number; text: string;
  corrected: boolean; by: string | null; at: string | null; reason: string | null;
}
export interface OutEvent {
  id: number; at: string; by: string | null; act: "set" | "change" | "unidentify";
  statusBefore: string | null; linesBefore: OutLineRaw[] | null;
  statusAfter: string; linesAfter: OutLineRaw[]; reason: string | null;
}

const q = (company: string | null) => (company ? `?company=${encodeURIComponent(company)}` : "");

export const outApi = {
  state: async (ids: number[]) =>
    (await api.post<{ states: Record<number, OutState>; canEdit: boolean }>("/bank-ident/out/state", { ids })).data,
  counts: async (company: string | null) =>
    (await api.get<{ counts: Record<OutFilter, number>; from: string }>(`/bank-ident/out/counts${q(company)}`)).data,
  list: async (status: Exclude<OutFilter, "all">, company: string | null) =>
    (await api.get<{ rows: unknown[]; total: number; states: Record<number, OutState>; canEdit: boolean }>(
      `/bank-ident/out/list?status=${status}${company ? `&company=${encodeURIComponent(company)}` : ""}`)).data,
  save: async (txId: number, text: string, reason?: string) =>
    (await api.post<{ state: OutState }>(`/bank-ident/out/${txId}`, { text, reason })).data.state,
  unidentify: async (txId: number, reason: string) =>
    (await api.post<{ state: OutState }>(`/bank-ident/out/${txId}/unidentify`, { reason })).data.state,
  history: async (txId: number) => (await api.get<{ events: OutEvent[] }>(`/bank-ident/out/${txId}/history`)).data.events,
};

export const outErr = (e: unknown) => (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "Не вдалося — спробуйте ще раз.";

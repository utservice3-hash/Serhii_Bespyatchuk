/**
 * 💰 «Зарплата» — клієнт API (`/api/payroll/*`, контракт пакета `api/openapi.yaml`) і центру сповіщень (`/api/notifications`).
 * Форми відповідей — як їх віддає `backend/src/payroll/service.ts` (суми рахує рушій пакета на сервері; фронт лише показує).
 * Типи свідомо широкі (`Obj`): екрани читають поля, які показують, а не дзеркалять увесь рушій.
 */
import { api } from "../api";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Obj = Record<string, any>;

const g = async <T = any>(url: string, params?: Obj): Promise<T> => (await api.get<T>(url, { params })).data;
const p = async <T = any>(url: string, body?: unknown): Promise<T> => (await api.post<T>(url, body ?? {})).data;
const blob = async (url: string, params?: Obj): Promise<Blob> => (await api.get<Blob>(url, { params, responseType: "blob" })).data;

/** Текст помилки сервера для людини (PayrollError → `{ error, field }`). */
export function errText(e: unknown): string {
  const r = (e as { response?: { data?: unknown; status?: number } })?.response;
  const d = r?.data as Obj | undefined;
  if (d && typeof d === "object" && (d.error || d.message)) return String(d.error ?? d.message);
  if (r?.status === 403) return "Немає права на цю дію.";
  return (e as Error)?.message || "Не вдалося — спробуйте ще раз.";
}
export const errField = (e: unknown): string | null => ((e as { response?: { data?: Obj } })?.response?.data?.field as string) ?? null;

export const payrollApi = {
  // ---------- кабінет «Моя зарплата» (лише свої — id із сесії) ----------
  me: () => g("/payroll/me"),
  myDeals: (month?: string) => g<Obj[]>("/payroll/me/deals", month ? { month } : undefined),
  myGoal: (q: Obj = {}) => g("/payroll/me/goal", q),
  agree: (month: string) => p(`/payroll/me/records/${month}/agree`),
  dispute: (month: string, text: string) => p(`/payroll/me/records/${month}/dispute`, { text }),
  /** lines: [{ cardId, amount }] або [{ newCard: { number, holder }, amount }]; cash — готівкою. */
  submitForm: (month: string, body: { cash: number; lines: Obj[] }) => p(`/payroll/me/records/${month}/payout-form`, body),
  requestAdvance: (body: { cash?: number; lines?: Obj[] }) => p("/payroll/me/advances", body),
  cancelAdvance: (id: number) => p(`/payroll/me/advances/${id}/cancel`),
  myCards: () => g<Obj[]>("/payroll/me/cards"),
  addCard: (number: string, holder: string) => p("/payroll/me/cards", { number, holder }),
  archiveCard: async (id: number) => { await api.delete(`/payroll/me/cards/${id}`); },
  chooseProfi: () => p("/payroll/me/level", { level: "profi" }),
  /** files: data URL-и скріншотів (обхідний лист, менеджер → тім-ліду). */
  sendShots: (files: string[], note?: string) => p("/payroll/me/clearance/shots", { files, note }),

  // ---------- перевірка, нарахування, відомість ----------
  accruals: (month: string) => g<Obj[]>(`/payroll/months/${month}/accruals`),
  queue: (month: string) => g(`/payroll/months/${month}/queue`),
  record: (month: string, userId: string | number) => g(`/payroll/records/${month}/${userId}`),
  /** overrides: { margin|pct|rate|bonus: number|null }; notes: { поле: внутрішній коментар }; reply — відповідь на незгоду. */
  verify: async (month: string, userId: string | number, body: { overrides?: Obj; notes?: Obj; reply?: string }) =>
    (await api.patch(`/payroll/records/${month}/${userId}`, body)).data,
  addExtra: (month: string, userId: string | number, body: { kind: string; amount: number; note: string }) => p(`/payroll/records/${month}/${userId}/extras`, body),
  deleteExtra: async (month: string, userId: string | number, id: number) => { await api.delete(`/payroll/records/${month}/${userId}/extras/${id}`); },
  /** Рішення ОД по незгоді: «keep» — лишити перевірене, «auto» — повернути орієнтовні суми з кабінету. */
  resolve: (month: string, userId: string | number, body: { decision: "keep" | "auto"; reply?: string }) =>
    p(`/payroll/records/${month}/${userId}/resolve`, body),
  statement: (month?: string) => g<Obj[]>("/payroll/statement", month ? { month } : undefined),
  statementXlsx: (month: string, columns: string[]) => blob("/payroll/statement/export", { month, columns: columns.join(",") }),
  markPaid: (month: string, userIds: Array<string | number>) => p("/payroll/statement/mark-paid", { month, userIds }),

  // ---------- аванси ----------
  advances: (month?: string) => g("/payroll/advances", month ? { month } : undefined),
  payAdvance: (id: number) => p(`/payroll/advances/${id}/pay`),
  rejectAdvance: (id: number, reason: string) => p(`/payroll/advances/${id}/reject`, { reason }),
  advancesXlsx: (month: string) => blob("/payroll/advances/export", { month }),

  // ---------- обхідний лист ----------
  createLeave: (userId: string | number, body: { date: string; type: string; reason?: string }) => p(`/payroll/employees/${userId}/leave`, body),
  clearances: () => g<Obj[]>("/payroll/clearances"),
  clearance: (userId: string | number) => g(`/payroll/clearances/${userId}`),
  draftClearance: async (userId: string | number, key: string, data: unknown) => (await api.put(`/payroll/clearances/${userId}/items/${key}/draft`, { data })).data,
  signClearance: (userId: string | number, key: string, data: unknown) => p(`/payroll/clearances/${userId}/items/${key}/sign`, { data }),
  /** Друк (HTML з кнопкою «Друк»): відкриваємо з токеном через blob, бо новій вкладці заголовок Authorization не передати. */
  clearancePrint: async (userId: string | number) => (await api.get<string>(`/payroll/clearances/${userId}/pdf`, { responseType: "text" })).data,

  // ---------- прогноз, аналітика, архів ----------
  forecast: (month?: string) => g("/payroll/forecast", month ? { month } : undefined),
  analytics: (month?: string, plan = true) => g("/payroll/analytics", { ...(month ? { month } : {}), plan: String(plan) }),
  archive: (userId?: string | number) => g("/payroll/archive", userId ? { userId } : undefined),
  importArchive: (fileDataUrl: string) => p("/payroll/archive/import", { file: fileDataUrl }),

  // ---------- налаштування, люди ----------
  settings: (month?: string) => g("/payroll/settings", month ? { month } : undefined),
  saveSettings: (body: { validFrom: string; reason: string; settings: Obj }) => p("/payroll/settings", body),
  employees: () => g("/payroll/employees"),
  addEmployee: (body: Obj) => p("/payroll/employees", body),
  updateEmployee: async (userId: string | number, body: Obj) => (await api.patch(`/payroll/employees/${userId}`, body)).data,
  saveDepartment: (body: Obj) => p("/payroll/departments", body),
  saveTeam: (body: Obj) => p("/payroll/teams", body),
  history: (userId?: string | number) => g<Obj[]>("/payroll/history", userId ? { userId } : undefined),
  offerTasks: () => g<Obj[]>("/payroll/offer-tasks"),
  offerTaskDone: (id: number) => p(`/payroll/offer-tasks/${id}/done`),
};

// ---------- 🔔 центр сповіщень (спільний для дашборда) ----------
export interface NotificationT {
  id: number; type: string; module: string; title: string; text: string; createdAt: string;
  act: boolean; cta: string | null; doneAt: string | null; readAt: string | null; waitingDays: number; link: Obj | null;
}
export const notificationsApi = {
  list: (filter: "all" | "act" | "unread" = "all", before?: number) => g<NotificationT[]>("/notifications", { filter, ...(before ? { before } : {}) }),
  badge: () => g<{ unread: number; needAction: number }>("/notifications/badge"),
  read: (ids: number[] | "all") => p("/notifications/read", ids === "all" ? { all: true } : { ids }),
  rules: () => g<Obj[]>("/notifications/rules"),
  setRule: async (type: string, body: { channels?: string[]; enabled?: boolean }) => (await api.put(`/notifications/rules/${type}`, body)).data,
};

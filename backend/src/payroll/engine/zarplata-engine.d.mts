/* Декларації для бекенда (TypeScript). Сам рушій — zarplata-engine.mjs з пакета Сергія 03.11.2026, байт у байт; типи полів — JSDoc у ньому. */
/* eslint-disable @typescript-eslint/no-explicit-any */
export type Level = 'start' | 'profi';
export type PayrollState = Record<string, any>;
export type Payroll = Record<string, any> & {
  settings: any; now: string; today: string; liveMonth: string; closedMonth: string | null; employees: any[];
  calc(e: any, mk: string): any; settlement(e: any, mk: string): any; advanceLimit(e: any, mk: string): any;
};
export const DEFAULT_SETTINGS: any;
export const EXTRA_KINDS: Record<string, [string, number]>;
export const LEAVE_TYPES: Record<string, [string, string]>;
export const CLEARANCE_ITEMS: ReadonlyArray<{ k: string; role: string; t: string; d?: string; checks?: string[]; final?: boolean }>;
export const CLEARANCE_ROLES: Record<string, string>;
export const RECORD_FLOW: Record<string, Record<string, string>>;
export function nextStatus(status: string, action: string): string | null;
export function sum(a: any[]): number;
export function ceilE(x: number): number;
export function nextMonth(mk: string): string;
export function prevMonth(mk: string): string;
export function lastDay(mk: string): number;
export function addDays(iso: string, n: number): string;
export function luhn(s: string): boolean;
export function createPayroll(state: PayrollState): Payroll;

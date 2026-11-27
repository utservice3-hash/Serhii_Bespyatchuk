/**
 * ⏱ ЗАДАЧА ТІМЛІДУ: ПОСТІЙНИЙ ПРОПУСТИВ СВІЙ РИТМ, А РОБОТИ З НИМ НЕМАЄ (задача 11229; зустріч по дашборду 25.11.2026,
 * рішення Романа 27.11.2026: поріг 3 КАЛЕНДАРНІ дні; клієнтів, що вже у вкладці «Реактивація», не брати).
 *
 * Правило — над ТИМИ САМИМИ рядками, що показує екран «З ким говорити» (`/client-plans`): «пропустив ритм» і «на скільки
 * днів» рахує `clientLeadRules.rhythmOf` (воно ж робить клієнта жовтим), «роботи немає» — `clientLeadRules.workVerdict`
 * (те, що екран підписує «Немає роботи»). Другої копії цих правил тут немає: модуль лише читає готові поля рядка.
 *
 * Чистий модуль (без бази): хто підпадає, кому йде задача і що зробити із задачами, які вже стоять. Запис —
 * `jobs/rhythmTaskSweep.ts`.
 *
 * 🔴 ОДИН РЯДОК НА ОДИН ПРОПУСК РИТМУ. Клієнт потрапляє в задачу один раз за пропуск (ключ — клієнт, менеджер і дата
 * останнього замовлення). Закрив рядок тімлід чи він закрився сам — удруге той самий пропуск не ставимо: інакше закрита
 * задача щоранку поверталась би. Клієнт замовив і знову пропустив ритм — це новий пропуск і новий рядок.
 */
import type { Rhythm } from "./clientLeadRules.js";

/** Скільки календарних днів понад звичайний інтервал клієнта чекаємо роботи (рішення Романа 27.11.2026). */
export const RHYTHM_TASK_DAYS = 3;
/** Задача тімліду (одна на менеджера) і рядок-клієнт у ній. Окремі типи: правила реактивації їх не читають. */
export const RHYTHM_PACK_TYPE = "rhythm_pack";
export const RHYTHM_CLIENT_TYPE = "rhythm_client";

/** Рядок екрана «З ким говорити» — лише поля, які читає правило. Форма та сама, що віддає `/client-plans`. */
export interface RhythmRow {
  clientKey: string; clientName: string;
  managerId: number; managerName: string;
  teamId: number | null; teamName: string;
  /** Прострочена дебіторка: з боржником працює дебіторка, не ця задача. */
  debtHold: boolean;
  /** Вкладка рядка; `react` — клієнт уже у «Реактивації» зі своїм циклом. */
  tabGroup: "regular" | "yellow" | "react";
  lead: {
    lastOrder: string | null; orderDays: number | null;
    rhythm: Rhythm;
    works: { yes: boolean; by: string | null; at: string | null };
    /** Остання розмова від 10 с (київська дата) — для показу в рядку задачі. */
    talk10: string | null;
    /** Діюча позначка «Проблемний». */
    problem: unknown;
  };
}

/** Чому клієнт НЕ підпадає. Порядок перевірок — порядок цього переліку. */
export const RHYTHM_SKIPS = ["rhythm", "days", "work", "problem", "debt", "react"] as const;
export type RhythmSkip = (typeof RHYTHM_SKIPS)[number];

/** Чи підпадає клієнт під задачу сьогодні; якщо ні — перша причина. */
export function rhythmVerdict(r: RhythmRow): { due: true } | { due: false; why: RhythmSkip } {
  if (!r.lead.rhythm.over || r.lead.rhythm.overDays == null) return { due: false, why: "rhythm" };
  if (r.lead.rhythm.overDays < RHYTHM_TASK_DAYS) return { due: false, why: "days" };
  if (r.lead.works.yes) return { due: false, why: "work" };
  if (r.lead.problem != null) return { due: false, why: "problem" };
  if (r.debtHold) return { due: false, why: "debt" };
  if (r.tabGroup === "react") return { due: false, why: "react" };
  return { due: true };
}

/** Один пропуск ритму: клієнт + менеджер + дата останнього замовлення. */
export const episodeKey = (clientKey: string, managerId: number, lastOrder: string | null): string =>
  `${clientKey}|${String(managerId)}|${lastOrder ?? ""}`;

/** Факти рядка на день прогону — те, що видно в задачі. Оновлюються щоранку, поки рядок відкритий. */
export interface RhythmFacts {
  managerId: number; lastOrder: string | null;
  usualDays: number | null; orderDays: number | null; overDays: number | null;
  lastTalk: string | null;
}
export const factsOf = (r: RhythmRow): RhythmFacts => ({
  managerId: r.managerId, lastOrder: r.lead.lastOrder,
  usualDays: r.lead.rhythm.usualDays, orderDays: r.lead.orderDays, overDays: r.lead.rhythm.overDays,
  lastTalk: r.lead.talk10,
});

const dm = (ymd: string): string => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}`;
const WORK_LABEL: Record<string, string> = {
  talk: "розмова", stage: "зміна етапу", comment: "коментар", contact: "контакт", payment: "оплата",
  order: "замовлення", deal: "нова угода", season: "не в сезоні",
};

export const CLOSE_GONE = "Закрито автоматично: клієнта більше немає у списку постійних цього менеджера.";
export const CLOSE_WITH_PACK = "Закрито разом із задачею.";
export const CLOSE_PACK = "Закрито автоматично: усі клієнти в задачі опрацьовані.";

/** Чому відкритий рядок закривається сам. Одна причина — одне речення; збірного «не підпадає» немає. */
export function closeReasonFor(r: RhythmRow, rowLastOrder: string | null): string | null {
  const v = rhythmVerdict(r);
  if (v.due) return null;
  if (r.lead.lastOrder != null && r.lead.lastOrder !== rowLastOrder && (rowLastOrder == null || r.lead.lastOrder > rowLastOrder)) {
    return `Закрито автоматично: клієнт замовив ${dm(r.lead.lastOrder)}.`;
  }
  switch (v.why) {
    case "rhythm": case "days": return "Закрито автоматично: ритм більше не пропущено.";
    case "work": return `Закрито автоматично: з клієнтом попрацювали (${WORK_LABEL[r.lead.works.by ?? ""] ?? "робота"}${r.lead.works.at ? ` ${dm(r.lead.works.at)}` : ""}).`;
    case "problem": return "Закрито автоматично: клієнта позначено проблемним.";
    case "debt": return "Закрито автоматично: у клієнта прострочена дебіторка.";
    case "react": return "Закрито автоматично: клієнт перейшов у «Реактивацію».";
  }
}

/** Кому ставити: тімлід команди менеджера; немає тімліда (чи менеджер сам тімлід) — керівник відділу продажу. */
export interface RhythmTargets {
  /** Команда → акаунт тімліда. */
  leadByTeam: ReadonlyMap<number, number>;
  /** Менеджер → його власний акаунт (щоб не поставити задачу людині про неї саму). */
  userByManager: ReadonlyMap<number, number>;
  /** Акаунт керівника відділу продажу (роль КВП). */
  headUserId: number | null;
}
export function targetFor(managerId: number, teamId: number | null, t: RhythmTargets): { userId: number; via: RhythmVia } | null {
  const own = t.userByManager.get(managerId) ?? null;
  const lead = teamId != null ? t.leadByTeam.get(teamId) ?? null : null;
  if (lead != null && lead !== own) return { userId: lead, via: "lead" };
  if (t.headUserId != null && t.headUserId !== own) return { userId: t.headUserId, via: "head" };
  return null;
}

const plural = (n: number, one: string, few: string, many: string): string => {
  const a = n % 10, b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
};
export const packTitle = (managerName: string, rows: number): string =>
  `⏱ Пропустили ритм, роботи немає ${String(RHYTHM_TASK_DAYS)} ${plural(RHYTHM_TASK_DAYS, "день", "дні", "днів")} (${String(rows)}) — ${managerName}`;
/** Рядок-клієнт, що вже є в базі (будь-якого стану) — разом зі станом своєї задачі. */
export interface ExistingRow {
  id: number; packId: number; packOpen: boolean; open: boolean;
  clientKey: string; managerId: number; lastOrder: string | null;
}
/** Відкрита задача менеджера. */
/** `via` — кому стоїть: тімліду команди чи керівнику відділу продажу (у менеджера немає тімліда). Екран це підписує. */
export type RhythmVia = "lead" | "head";
export interface OpenPack { id: number; managerId: number; assigneeUserId: number | null; title: string; via: RhythmVia | null }

export interface NewRow { clientKey: string; title: string; facts: RhythmFacts }
export interface RhythmPlan {
  /** Нова задача тімліду з першими рядками. */
  create: { managerId: number; managerName: string; userId: number; via: RhythmVia; department: string; rows: NewRow[] }[];
  /** Новий клієнт — рядком у відкриту задачу менеджера. */
  add: { packId: number; rows: NewRow[] }[];
  /** Відкритий рядок, що далі підпадає, — оновити числа. */
  refresh: { id: number; facts: RhythmFacts }[];
  closeRows: { id: number; reason: string }[];
  closePacks: { id: number; reason: string }[];
  /** Заголовок із числом рядків і виконавець відкритої задачі — привести до сьогоднішнього. */
  update: { packId: number; title: string; userId: number | null; via: RhythmVia | null; managerName: string }[];
  stats: {
    onScreen: number; due: number; skipped: Record<RhythmSkip, number>;
    /** Підпадають, але цей пропуск уже ставили (рядок є чи був). */
    covered: number;
    /** Підпадають, але ставити нікому: немає ні тімліда, ні керівника відділу продажу. */
    noTarget: number;
  };
}

/**
 * Що зробити сьогодні. `rows` — увесь список екрана (усі менеджери); `existing` — усі рядки-клієнти, що вже ставились;
 * `packs` — відкриті задачі.
 */
export function planRhythmTasks(a: {
  rows: readonly RhythmRow[]; existing: readonly ExistingRow[]; packs: readonly OpenPack[]; targets: RhythmTargets;
}): RhythmPlan {
  const plan: RhythmPlan = { create: [], add: [], refresh: [], closeRows: [], closePacks: [], update: [],
    stats: { onScreen: a.rows.length, due: 0, skipped: { rhythm: 0, days: 0, work: 0, problem: 0, debt: 0, react: 0 }, covered: 0, noTarget: 0 } };
  const rowOf = new Map(a.rows.map((r) => [`${r.clientKey}|${String(r.managerId)}`, r]));
  const covered = new Set(a.existing.map((e) => episodeKey(e.clientKey, e.managerId, e.lastOrder)));
  const packByManager = new Map(a.packs.map((p) => [p.managerId, p]));
  /** Скільки рядків у задачі всього і скільки з них лишиться відкритими після цього прогону. */
  const total = new Map<number, number>(), openLeft = new Map<number, number>();
  const bump = (m: Map<number, number>, k: number, d = 1) => m.set(k, (m.get(k) ?? 0) + d);

  // ① Рядки, що вже стоять: закрити, де причина зникла, решті оновити числа.
  for (const e of a.existing) {
    bump(total, e.packId);
    if (!e.open) continue;
    if (!e.packOpen) { plan.closeRows.push({ id: e.id, reason: CLOSE_WITH_PACK }); continue; }
    const r = rowOf.get(`${e.clientKey}|${String(e.managerId)}`);
    const reason = r ? closeReasonFor(r, e.lastOrder) : CLOSE_GONE;
    if (reason) { plan.closeRows.push({ id: e.id, reason }); continue; }
    plan.refresh.push({ id: e.id, facts: factsOf(r!) });
    bump(openLeft, e.packId);
  }

  // ② Хто підпадає сьогодні й кого ще не ставили.
  const fresh = new Map<number, RhythmRow[]>();
  for (const r of a.rows) {
    const v = rhythmVerdict(r);
    if (!v.due) { plan.stats.skipped[v.why]++; continue; }
    plan.stats.due++;
    if (covered.has(episodeKey(r.clientKey, r.managerId, r.lead.lastOrder))) { plan.stats.covered++; continue; }
    fresh.set(r.managerId, [...(fresh.get(r.managerId) ?? []), r]);
  }
  const newRow = (r: RhythmRow): NewRow => ({ clientKey: r.clientKey, title: r.clientName || r.clientKey, facts: factsOf(r) });
  for (const [managerId, list] of fresh) {
    const first = list[0];
    const target = targetFor(managerId, first.teamId, a.targets);
    const pack = packByManager.get(managerId);
    if (pack) {
      plan.add.push({ packId: pack.id, rows: list.map(newRow) });
      bump(total, pack.id, list.length); bump(openLeft, pack.id, list.length);
      continue;
    }
    if (!target) { plan.stats.noTarget += list.length; continue; }
    plan.create.push({ managerId, managerName: first.managerName, userId: target.userId, via: target.via,
      department: first.teamName, rows: list.map(newRow) });
  }

  // ③ Відкриті задачі: без відкритих рядків — закрити; решті — число рядків у заголовку й сьогоднішній виконавець.
  for (const p of a.packs) {
    if ((openLeft.get(p.id) ?? 0) === 0) { plan.closePacks.push({ id: p.id, reason: CLOSE_PACK }); continue; }
    const anyRow = a.rows.find((r) => r.managerId === p.managerId);
    const target = anyRow ? targetFor(p.managerId, anyRow.teamId, a.targets) : null;
    const managerName = anyRow?.managerName ?? p.title.split(" — ").slice(1).join(" — ");
    const title = packTitle(managerName, total.get(p.id) ?? 0);
    // Менеджера немає на екрані чи ставити нікому — виконавця не чіпаємо: задача лишається в того, хто її має.
    const userId = target?.userId ?? p.assigneeUserId;
    const via = target?.via ?? p.via;
    if (title !== p.title || userId !== p.assigneeUserId || via !== p.via) plan.update.push({ packId: p.id, title, userId, via, managerName });
  }
  return plan;
}

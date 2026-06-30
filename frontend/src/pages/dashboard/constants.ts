// Static label/colour maps and ordered lists shared across dashboard sections.
import type { TaskPriority, TaskStatus } from "../../api";

export const STATUS_LABELS: Record<TaskStatus, string> = {
  todo_list: "To do list",
  to_realize: "Взяти до реалізації",
  planned: "Заплановано",
  not_started: "Не почато",
  deferred: "Відкладений запит",
  in_progress: "В процесі",
  ball_on_executor: "М'яч на стороні виконавця",
  ready_for_approval: "Готово на затвердження",
  done: "Готово",
};

export const STATUS_GROUPS: { label: string; statuses: TaskStatus[] }[] = [
  { label: "To-do", statuses: ["todo_list", "to_realize", "planned", "not_started"] },
  { label: "In progress", statuses: ["deferred", "in_progress", "ball_on_executor"] },
  { label: "Complete", statuses: ["ready_for_approval", "done"] },
];

export const STATUS_DOT_COLORS: Record<TaskStatus, string> = {
  todo_list: "#94a3b8",
  to_realize: "#f59e0b",
  planned: "#f59e0b",
  not_started: "#94a3b8",
  deferred: "#f59e0b",
  in_progress: "#eab308",
  ball_on_executor: "#60a5fa",
  ready_for_approval: "#a78bfa",
  done: "#34d399",
};

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: "Низький",
  medium: "Середній",
  high: "Високий",
};

export const STAGE_LABELS: Record<string, string> = {
  lead_taken: "Ліди в роботі",
  quote_requested: "Запит КП",
  approved: "Погоджено",
  invoiced: "Рахунок виставлено",
  paid: "Оплачено",
};

export const STAGE_COLORS: Record<string, string> = {
  lead_taken: "#94a3b8",
  quote_requested: "#60a5fa",
  approved: "#34d399",
  invoiced: "#fbbf24",
  paid: "#c5141c",
};

export const STAGE_ORDER = Object.keys(STAGE_LABELS);

export const STAT_CHARTS = [
  { key: "stages", title: "Динаміка по етапах" },
  { key: "revenue", title: "Динаміка виручки (оплачено)" },
  { key: "count", title: "Динаміка кількості оплат" },
  { key: "avgcheck", title: "Динаміка середнього чека" },
];

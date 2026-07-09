// Shape of the "new task / KPI plan" modal form, shared between the Dashboard
// container (which owns the state) and the Tasks section (which edits it).
import type { TaskPriority } from "../../api";

export type TaskForm = {
  title: string;
  deadline: string;
  assigneeId: number | "";
  assigneeId2: number | ""; // друга людина (задача одразу на двох менеджерів)
  priority: TaskPriority;
  department: string;
  comments: string;
  // KPI plan fields
  taskType: "simple" | "weekly_kpi" | "monthly_kpi" | "reactivation";
  planScope: "range" | "day"; // weekly plan: a period or a single day
  weekStart: string;
  rangeFrom: string; // weekly plan: custom range start (from calendar)
  rangeTo: string;   // weekly plan: custom range end
  weekdays: boolean[]; // Mon..Sun
  adsCount: string;
  leadgenCount: string;
  dispatchCount: string; // к-сть авто (поставити)
  avgCheck: string;
  conversion: string;
  paymentAmount: string; // сума, яку менеджер має принести за період
};

export const emptyTaskForm: TaskForm = {
  title: "",
  deadline: "",
  assigneeId: "",
  assigneeId2: "",
  priority: "medium",
  department: "",
  comments: "",
  taskType: "simple",
  planScope: "range",
  weekStart: "",
  rangeFrom: "",
  rangeTo: "",
  weekdays: [true, true, true, true, true, false, false], // Mon..Sun
  adsCount: "",
  leadgenCount: "",
  dispatchCount: "",
  avgCheck: "",
  conversion: "",
  paymentAmount: "",
};

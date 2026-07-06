// Shape of the "new task / KPI plan" modal form, shared between the Dashboard
// container (which owns the state) and the Tasks section (which edits it).
import type { TaskPriority } from "../../api";

export type TaskForm = {
  title: string;
  deadline: string;
  assigneeId: number | "";
  priority: TaskPriority;
  department: string;
  comments: string;
  // KPI plan fields
  taskType: "simple" | "weekly_kpi" | "monthly_kpi" | "reactivation";
  weekStart: string;
  rangeFrom: string; // weekly plan: custom range start (from calendar)
  rangeTo: string;   // weekly plan: custom range end
  weekdays: boolean[]; // Mon..Sun
  adsCount: string;
  leadgenCount: string;
  dispatchCount: string; // к-сть авто (поставити)
  avgCheck: string;
  conversion: string;
};

export const emptyTaskForm: TaskForm = {
  title: "",
  deadline: "",
  assigneeId: "",
  priority: "medium",
  department: "",
  comments: "",
  taskType: "simple",
  weekStart: "",
  rangeFrom: "",
  rangeTo: "",
  weekdays: [true, true, true, true, true, false, false], // Mon..Sun
  adsCount: "",
  leadgenCount: "",
  dispatchCount: "",
  avgCheck: "",
  conversion: "",
};

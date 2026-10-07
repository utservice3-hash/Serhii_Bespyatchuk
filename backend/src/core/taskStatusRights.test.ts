import { test } from "node:test";
import assert from "node:assert/strict";
import { canSeeTask, type TaskViewer } from "./taskVisibility.js";
import {
  statusRights, canChangeReviewer, effectiveReviewer, REVIEWED_TASK_TYPES,
  type StatusRightsRow,
} from "./taskStatusRights.js";

/**
 * Глядачі. Юлія — НЕ адмін навмисно: у проді вона КВП з `admin_scope` і пройшла б
 * як адмін, тобто гейт не перевірив би саме «Приймає». Тут вона звичайний акаунт,
 * який ні автор, ні виконавець, ні тімлід.
 */
const ADMIN: TaskViewer = { role: "admin", userId: 1, managerId: null, teamId: null, adminScope: true };
const LEAD: TaskViewer = { role: "team_lead", userId: 3, managerId: 30, teamId: 7, adminScope: false };
const EXEC: TaskViewer = { role: "manager", userId: 4, managerId: 40, teamId: 7, adminScope: false };
const OUTSIDER: TaskViewer = { role: "manager", userId: 5, managerId: 50, teamId: 9, adminScope: false };
const REVIEWER: TaskViewer = { role: "manager", userId: 6, managerId: -1, teamId: null, adminScope: false };
const AUTHOR: TaskViewer = { role: "manager", userId: 7, managerId: 70, teamId: 9, adminScope: false };
const VIEWERS = [ADMIN, LEAD, EXEC, OUTSIDER, REVIEWER, AUTHOR];

const row = (o: Partial<StatusRightsRow>): StatusRightsRow => ({
  assigneeId: null, assigneeUserId: null, createdBy: null, assigneeTeamId: null,
  reviewerId: null, taskType: "simple", ...o,
});

/** Автор, виконавець і «Приймає» — троє різних людей. Випадок «автор = виконавець» — окремо нижче. */
const REVIEWED = row({ assigneeId: 40, assigneeTeamId: 7, createdBy: AUTHOR.userId, reviewerId: REVIEWER.userId });

/**
 * #1080 — «ГОТОВО» СТАВИТЬ КОЖЕН, ХТО РУХАЄ СТАТУС (рішення Романа 07.10.2026:
 * «будь хто може ставити готово»). Таблиця прав по ОБИДВА боки межі.
 *
 * | хто | рухає | закриває |
 * | адмін, «Приймає», автор, виконавець, тімлід його команди | ✅ | ✅ |
 * | стороння людина | ❌ | ❌ |
 *
 * 🧨 Червоніє, якщо повернути заборону «закриває лише той, хто приймає» (виконавець
 * чи тімлід отримають `—` у колонці «закриває») або пустити сторонню людину.
 */
test("#1080 ГОТОВО СТАВИТЬ КОЖЕН, ХТО РУХАЄ СТАТУС: виконавець і тімлід теж; «Приймає» — учасник; стороння людина — нічого", () => {
  const got = Object.fromEntries(VIEWERS.map((v) => {
    const r = statusRights(v, REVIEWED);
    return [`${v.role}#${v.userId}`, `${r.canChange ? "рухає" : "—"}/${r.canDone ? "закриває" : "—"}/${r.actor ?? "—"}`];
  }));
  assert.deepEqual(got, {
    "admin#1": "рухає/закриває/admin",
    "team_lead#3": "рухає/закриває/team_lead",
    "manager#4": "рухає/закриває/executor",
    "manager#5": "—/—/—",
    "manager#6": "рухає/закриває/reviewer",
    "manager#7": "рухає/закриває/author",
  });

  // 🪞 Замовчування: «Приймає» не призначено — приймає АВТОР, і він закриває.
  const byDefault = row({ assigneeId: 40, assigneeTeamId: 7, createdBy: AUTHOR.userId });
  assert.equal(effectiveReviewer(byDefault), AUTHOR.userId);
  assert.equal(statusRights(AUTHOR, byDefault).canDone, true, "🔴 без призначеного «Приймає» автор не може закрити");
  assert.equal(statusRights(EXEC, byDefault).canDone, true, "🔴 виконавець не може поставити «Готово» — заборона повернулась");
  assert.equal(statusRights(REVIEWER, byDefault).canChange, false,
    "🔴 людина, яку НЕ призначено приймати, отримала права на статус");

  // Одна людина — автор, виконавець і «Приймає» одночасно: закриває (вимога ТЗ).
  const allInOne = row({ assigneeId: 40, assigneeTeamId: 7, createdBy: EXEC.userId });
  assert.equal(statusRights(EXEC, allInOne).canDone, true, "🔴 автор-виконавець не може закрити власну задачу");
  // Автор = виконавець, а приймає ІНША людина: закривають обидва.
  const authorExec = { ...allInOne, reviewerId: REVIEWER.userId };
  assert.deepEqual([statusRights(EXEC, authorExec).canDone, statusRights(EXEC, authorExec).actor], [true, "executor"]);
  assert.equal(statusRights(REVIEWER, authorExec).canDone, true);
  // 🪞 Стороння людина — нічого, навіть на задачі без «Приймає».
  assert.deepEqual([statusRights(OUTSIDER, byDefault).canChange, statusRights(OUTSIDER, byDefault).canDone], [false, false],
    "🔴 стороння людина отримала права на статус");
});

/**
 * #1080b — «ПРИЙМАЄ» ЛИШЕ У ЗВИЧАЙНИХ ЗАДАЧ (рішення Романа 30.09.2026).
 *
 * Поза ними «Приймає» не учасник: інакше людина, призначена приймати, отримала б
 * права на клієнта реактивації чи KPI-день. Виконавець там закриває, як і було.
 * 🧨 Червоніє, якщо прибрати перевірку `REVIEWED_TASK_TYPES` у `statusActor`.
 */
test("#1080b «ПРИЙМАЄ» ЛИШЕ У ЗВИЧАЙНИХ ЗАДАЧ: поза ними він не учасник, виконавець закриває як і було", () => {
  assert.deepEqual([...REVIEWED_TASK_TYPES], ["simple"], "склад типів під правилом змінився — це рішення власника, не правка");
  for (const taskType of ["reactivation_client", "reactivation", "daily_kpi", "kpi_period", "credit_limit_request"]) {
    const t = row({ ...REVIEWED, taskType });
    assert.equal(statusRights(EXEC, t).canDone, true, `🔴 виконавець не може закрити ${taskType} — правило розповзлось`);
    // Поза звичайними «Приймає» не діє: інакше видача обіцяла б права, яких PATCH не дає.
    assert.equal(statusRights(REVIEWER, t).canChange, false, `🔴 «Приймає» діє на ${taskType}`);
  }
  // 🪞 Дзеркало: та сама задача звичайного типу — «Приймає» учасник.
  assert.equal(statusRights(REVIEWER, REVIEWED).canChange, true, "🔴 «Приймає» не учасник навіть у звичайній задачі");
});

/**
 * #1080c — СИСТЕМНА ЗАДАЧА БЕЗ АВТОРА ЗАКРИВАЄТЬСЯ ВИКОНАВЦЕМ.
 *
 * Пропущені дзвінки, чергування, дедлайни дебіторки, звірка, нагадування 1×1 —
 * `task_type='simple'` і `created_by = NULL`. Приймати їх нікому; без винятку
 * закривав би лише адмін.
 * 🧨 Червоніє, якщо прибрати `effectiveReviewer(t) === null` з правила.
 */
test("#1080c СИСТЕМНА ЗАДАЧА БЕЗ АВТОРА: виконавець закриває, як і до правила", () => {
  const system = row({ assigneeId: 40, assigneeTeamId: 7, createdBy: null });
  assert.equal(statusRights(EXEC, system).canDone, true, "🔴 менеджер не може закрити системну задачу (пропущений дзвінок тощо)");
  // І стороння людина на системній задачі — нічого.
  assert.equal(statusRights(OUTSIDER, system).canChange, false);
});

/**
 * #1080d — ХТО РУХАЄ СТАТУС, ТОЙ БАЧИТЬ ЗАДАЧУ; ХТО ЗАКРИВАЄ, ТОЙ РУХАЄ.
 *
 * Та сама інваріанта, що `#400` (`canTouch ⊆ canSee`), для нового права. Без неї
 * «Приймає» мав би право закрити задачу, якої немає в його списку.
 * 🧨 Червоніє, якщо прибрати `iReview` з `canSeeTask`.
 */
test("#1080d ПРАВА НА СТАТУС ⊆ ВИДИМІСТЬ, і закрити ⊆ рухати — по всіх ролях і видах задач", () => {
  const TASKS: StatusRightsRow[] = [
    REVIEWED,
    row({ assigneeId: 40, assigneeTeamId: 7, createdBy: AUTHOR.userId }),
    row({ assigneeId: 50, assigneeTeamId: 9, createdBy: ADMIN.userId, reviewerId: REVIEWER.userId }),
    // Особиста задача автора з призначеним «Приймає» — відкривається рівно йому.
    row({ createdBy: AUTHOR.userId, reviewerId: REVIEWER.userId }),
    row({ assigneeUserId: EXEC.userId, createdBy: ADMIN.userId }),
    row({ assigneeId: 40, assigneeTeamId: 7, createdBy: null }),
  ];
  const broken: string[] = [];
  let reviewerCases = 0;
  for (const v of VIEWERS) {
    for (const [i, t] of TASKS.entries()) {
      const r = statusRights(v, t);
      if (r.canChange && !canSeeTask(v, t)) broken.push(`${v.role}#${v.userId} рухає, але не бачить задачу ${i}`);
      if (r.canDone && !r.canChange) broken.push(`${v.role}#${v.userId} закриває, але не рухає задачу ${i}`);
      if (r.actor === "reviewer" && v === REVIEWER) reviewerCases++;
    }
  }
  assert.deepEqual(broken, [], "🔴\n  " + broken.join("\n  "));
  // Доказ, що перевірці БУЛО що знаходити: «Приймає»-не-учасник справді має права.
  assert.ok(reviewerCases >= 3, `«Приймає» отримав права лише в ${reviewerCases} задачах — гейт нічого не стереже`);
  assert.equal(canSeeTask(REVIEWER, TASKS[3]), true, "🔴 «Приймає» не бачить особистої задачі, яку його призначили приймати");
  assert.equal(canSeeTask(OUTSIDER, TASKS[3]), false, "🔴 особиста задача з «Приймає» протекла сторонньому");
});

/**
 * #1080e — «ПРИЙМАЄ» МІНЯЮТЬ АВТОР, САМ «ПРИЙМАЄ» І АДМІН — НЕ ВИКОНАВЕЦЬ.
 *
 * Інакше виконавець призначив би приймати себе і закрив би задачу сам — правило
 * `#1080` стало б декоративним.
 * 🧨 Червоніє, якщо в `canChangeReviewer` пустити виконавця (або повернути `true`).
 */
test("#1080e ПЕРЕПРИЗНАЧИТИ «ПРИЙМАЄ» МОЖУТЬ АВТОР, «ПРИЙМАЄ» І АДМІН — виконавець і тімлід ні", () => {
  const got = Object.fromEntries(VIEWERS.map((v) => [`${v.role}#${v.userId}`, canChangeReviewer(v, REVIEWED)]));
  assert.deepEqual(got, {
    "admin#1": true, "team_lead#3": false, "manager#4": false,
    "manager#5": false, "manager#6": true, "manager#7": true,
  });
  // 🪞 Автор, який сам виконує задачу, приймання не переписує (спіймано HTTP-прогоном
  // 30.09.2026: автор-виконавець переписав «Приймає» з Юлії на себе й закрив задачу).
  const authorExec = row({ assigneeId: 40, assigneeTeamId: 7, createdBy: EXEC.userId, reviewerId: REVIEWER.userId });
  assert.equal(canChangeReviewer(EXEC, authorExec), false, "🔴 АВТОР-ВИКОНАВЕЦЬ ПЕРЕПИСАВ «ПРИЙМАЄ» НА СЕБЕ");
  assert.equal(canChangeReviewer(REVIEWER, authorExec), true, "«Приймає» не може передати приймання");
  // Одна людина в трьох ролях (приймає за замовчуванням сама) — може передати іншому.
  assert.equal(canChangeReviewer(EXEC, { ...authorExec, reviewerId: null }), true);
});

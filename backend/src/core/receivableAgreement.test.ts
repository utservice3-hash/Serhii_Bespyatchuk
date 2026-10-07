import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { agreementActual, defaultAgreementDeal } from "./receivableAgreement.js";

/**
 * 🗓 «ДОМОВЛЕНІСТЬ» ДЕБІТОРКИ З УРАХУВАННЯМ УГОДИ (06.10.2026). Привід — Бінарт: запис 31.08 жив на клієнті,
 * а нова угода 62741529 з оплатою 06.10 у CRM на екрані показувала 31.08.
 */
const srcOf = (rel: string) => fileURLToPath(new URL(rel, import.meta.url).href.replace("/dist/", "/src/"));
const FE_SPEC = (p: string) => srcOf(`../../../frontend/src/${p}`);
const SRC = (p: string) => readFileSync(srcOf(`../${p}`), "utf8");

test("#1390 АКТУАЛЬНІСТЬ ЗАПИСУ: привʼязаний — поки угода неоплачена; старий — лише якщо не раніше за найновішу угоду", () => {
  const open = [101, 102];
  assert.equal(agreementActual({ noteDealId: 102, noteUpdatedAt: "2026-08-31T13:00:00Z", openDealIds: open, newestDealAt: "2026-10-05T09:00:00Z" }), true,
    "🔴 запис, привʼязаний до неоплаченої угоди, вважається старим");
  assert.equal(agreementActual({ noteDealId: 99, noteUpdatedAt: "2026-10-06T09:00:00Z", openDealIds: open, newestDealAt: "2026-10-05T09:00:00Z" }), false,
    "🔴 запис оплаченої (зниклої) угоди лишився актуальним");
  assert.equal(agreementActual({ noteDealId: null, noteUpdatedAt: "2026-08-31T13:04:00Z", openDealIds: open, newestDealAt: "2026-10-05T09:00:00Z" }), false,
    "🔴 Бінарт: запис 31.08 при угоді від 05.10 досі актуальний");
  assert.equal(agreementActual({ noteDealId: null, noteUpdatedAt: "2026-10-05T09:00:00Z", openDealIds: open, newestDealAt: "2026-10-05T09:00:00Z" }), true,
    "🔴 межа: запис у мить створення угоди — уже про неї");
  assert.equal(agreementActual({ noteDealId: null, noteUpdatedAt: "2026-08-31T13:04:00Z", openDealIds: [], newestDealAt: null }), true,
    "🔴 без угод (рахунки 1С) старий запис раптом став неактуальним");
});

test("#1390b УГОДА ЗА ЗАМОВЧУВАННЯМ: найраніша дата оплати в CRM; без дат — найновіша; угод немає — null", () => {
  assert.equal(defaultAgreementDeal([
    { dealId: 1, crmDue: "2026-10-20", createdAt: "2026-10-01T00:00:00Z" },
    { dealId: 2, crmDue: "2026-10-06", createdAt: "2026-09-01T00:00:00Z" },
    { dealId: 3, crmDue: null, createdAt: "2026-10-05T00:00:00Z" },
  ]), 2, "🔴 обрано не угоду з найближчою датою оплати");
  assert.equal(defaultAgreementDeal([
    { dealId: 1, crmDue: null, createdAt: "2026-09-01T00:00:00Z" },
    { dealId: 3, crmDue: null, createdAt: "2026-10-05T00:00:00Z" },
  ]), 3, "🔴 без дат обрано не найновішу угоду");
  assert.equal(defaultAgreementDeal([]), null);
});

test("#1391 КОЛОНКА «ДОМОВЛЕНІСТЬ»: запис з попередньої угоди → дата з CRM + сірий старий запис; «ще не записано» — лише коли дата минула або її немає", async () => {
  const V = (await import(FE_SPEC("pages/dashboard/receivablesView.ts"))) as {
    agreementView: (p: { dueDate: string | null; note: string; comment: string | null; noteUpdatedAt: string | null;
      noteActual: boolean | undefined; crmDue: string | null | undefined; now: Date }) =>
      { dateText: string; source: string; text: string; prevDeal: { text: string; dateText: string } | null; placeholder: boolean };
  };
  const now = new Date("2026-10-06T09:00:00Z");
  // Бінарт: запис 31.08 (порожній коментар) з попередньої угоди, у CRM — 06.10.
  const b = V.agreementView({ dueDate: "2026-08-31", note: "", comment: "", noteUpdatedAt: "2026-08-31T13:04:00Z", noteActual: false, crmDue: "2026-10-06", now });
  assert.equal(b.source, "crm", "🔴 для запису з попередньої угоди дата не з CRM");
  assert.match(b.dateText, /06\.10/, "🔴 показано не дату з CRM");
  assert.ok(b.prevDeal && /31\.08/.test(b.prevDeal.dateText), "🔴 старий запис зник замість сірого «з попередньої угоди, 31.08»");
  assert.equal(b.placeholder, false, "🔴 «ще не записано» при майбутній даті з CRM");
  // Актуальний запис — як і раніше: його дата й текст.
  const a = V.agreementView({ dueDate: "2026-10-10", note: "оплатять у пʼятницю", comment: "оплатять у пʼятницю", noteUpdatedAt: "2026-10-06T08:00:00Z", noteActual: true, crmDue: "2026-10-06", now });
  assert.equal(a.source, "dashboard"); assert.match(a.dateText, /10\.10/); assert.equal(a.prevDeal, null); assert.equal(a.text, "оплатять у пʼятницю");
  // Межа «минула»: дата вчора → «ще не записано»; сьогодні → ні.
  assert.equal(V.agreementView({ dueDate: null, note: "", comment: null, noteUpdatedAt: null, noteActual: true, crmDue: "2026-10-05", now }).placeholder, true,
    "🔴 минула дата не дає «ще не записано»");
  assert.equal(V.agreementView({ dueDate: null, note: "", comment: null, noteUpdatedAt: null, noteActual: true, crmDue: "2026-10-06", now }).placeholder, false,
    "🔴 сьогоднішня дата вже вважається минулою");
  // Ні дати, ні тексту ніде → «ще не записано».
  const none = V.agreementView({ dueDate: null, note: "", comment: null, noteUpdatedAt: null, noteActual: true, crmDue: null, now });
  assert.equal(none.source, "none"); assert.equal(none.placeholder, true);
});

test("#1393 ЗБЕРЕЖЕННЯ Й ЗАДАЧІ: запис привʼязується до угоди клієнта; задача «отримати оплату» — лише за актуальним записом", () => {
  const dash = SRC("routes/dashboard.ts");
  const at = dash.indexOf('dashboardRouter.put("/receivables/note"');
  const body = dash.slice(at, dash.indexOf("\n});", at));
  assert.match(body, /if \(!clientDeals\.some\(\(d\) => d\.dealId === dealId\)\)/, "🔴 роут приймає угоду, якої немає серед неоплачених рахунків клієнта");
  assert.match(body, /dealId = defaultAgreementDeal\(clientDeals\)/, "🔴 без вибору запис не привʼязується до угоди");
  assert.match(body, /INSERT INTO receivable_notes \(client_key, comment, due_date, updated_by, updated_at, deal_id\)/, "🔴 угода запису не зберігається");
  assert.match(body, /OR receivable_notes\.deal_id IS DISTINCT FROM EXCLUDED\.deal_id/, "🔴 зміна угоди не скидає анти-дубль задачі");
  assert.match(body, /: mergeNoteComment\(null, incoming, clear\)/, "🔴 нова угода підтягує коментар попередньої");
  const job = SRC("jobs/receivableDeadlineTasks.ts");
  assert.match(job, /AND \$\{agreementActualSql\("n"\)\}/, "🔴 задача «отримати оплату» ставиться й за датою з попередньої угоди");
});

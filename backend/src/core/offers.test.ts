import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, readFileSync as rf } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { writeZip, extractMarkers, fillDocx, autoFieldOf, OfferTemplateError } from "./offerTemplate.js";
import { parseDocx } from "./officeParse.js";

/**
 * 📄 ОФЕР ІЗ ШАБЛОНУ (18.09.2026, етап 3) — гейти `#576`–`#579`.
 * Номери з запасом над `#575` — борг 17: перед мержем перемірити перетин.
 */

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
/** Мінімальний .docx. Мітка «{{ПІБ}}» розірвана на три шматки — рівно так, як її зберігає Word після правки. */
function docx(body: string): Buffer {
  return writeZip([
    ["[Content_Types].xml", Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')],
    ["word/document.xml", Buffer.from(`<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`)],
  ]);
}
const P = (...runs: string[]) => `<w:p><w:pPr/>${runs.map((t) => `<w:r><w:rPr><w:b/></w:rPr><w:t>${t}</w:t></w:r>`).join("")}</w:p>`;
const TEMPLATE = docx(
  P("ОФЕР для ", "{{", "ПІБ", "}}", ", посада {{Посада}}.") +
  P("Команда: {{ Команда }}; тімлід {{Тімлід}}; ставка {{Ставка}} грн; дата {{Дата}}.") +
  P("Без міток — цей абзац не змінюється."));
const textOf = (buf: Buffer) => parseDocx(buf).blocks.map((b) => ("runs" in b ? b.runs.map((r) => r.text).join("") : "")).join("\n");

/**
 * #576 — ПІДСТАНОВКА: мітки знаходяться й міняються навіть розірвані Word-ом; `&`/`<` у значенні
 * екрануються (файл лишається читабельним); у результаті не лишається жодного `{{`.
 * 🧨 Червоніє, якщо шукати мітки в окремих `<w:t>` (розірвана не знайдеться) або не екранувати значення.
 */
test("#576 ШАБЛОН: мітки знаходяться й міняються навіть розірвані Word-ом; значення екрануються", () => {
  assert.deepEqual(extractMarkers(TEMPLATE), ["ПІБ", "Посада", "Команда", "Тімлід", "Ставка", "Дата"], "🔴 розірвану мітку не знайдено");
  const out = fillDocx(TEMPLATE, { "ПІБ": "Коваленко & <Олена>", Посада: "менеджер", команда: "РПК · Дмитрук", Тімлід: "Дмитрук", Ставка: "20 000", Дата: "18.09.2026" });
  const text = textOf(out);
  assert.match(text, /ОФЕР для Коваленко & <Олена>, посада менеджер\./, "🔴 розірвана мітка не замінилась або значення зіпсовано");
  assert.match(text, /Команда: РПК · Дмитрук; тімлід Дмитрук; ставка 20 000 грн; дата 18\.09\.2026\./);
  assert.ok(!text.includes("{{") && !text.includes("}}"), "🔴 у готовому офері лишилась мітка");
  assert.match(text, /Без міток — цей абзац не змінюється\./);
  assert.equal(autoFieldOf(" піб "), "ПІБ");
  assert.equal(autoFieldOf("Ставка"), null, "дзеркало: ставку дашборд не вигадує — її дописують");
  assert.throws(() => extractMarkers(Buffer.from("не zip")), OfferTemplateError);
});

/**
 * #577 — ПОРОЖНЄ ПОЛЕ — ОФЕРУ НЕМАЄ: хоч одна мітка без значення — помилка з назвою поля, файл не
 * формується. 🧨 Червоніє, якщо підставити порожнє мовчки або лишити «{{Ставка}}» у тексті.
 */
test("#577 ПОРОЖНЄ ПОЛЕ: офер не формується, у помилці — назва поля", () => {
  try {
    fillDocx(TEMPLATE, { ПІБ: "Коваленко Олена", Посада: "менеджер", Команда: "РПК", Тімлід: "Дмитрук", Дата: "18.09.2026", Ставка: "   " });
    assert.fail("🔴 офер сформовано з порожньою ставкою");
  } catch (e) {
    assert.ok(e instanceof OfferTemplateError && e.status === 400, "🔴 не та помилка");
    assert.deepEqual((e as OfferTemplateError).fields, ["Ставка"], "🔴 у помилці не названо поле");
  }
});

/** Схема з нуля, тімлід команди 1, кандидат у «кандидат + команда» (з акаунтом), тимчасова тека для файлів. */
async function scratch(t: { skip: (m: string) => void }) {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const s = provisionScratch();
  if ("unavailable" in s) { t.skip(skipReason(s)); return null; }
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: s.url });
  await c.connect();
  await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
  await c.query("INSERT INTO teams(id,name) VALUES (1,'РПК · Дмитрук') ON CONFLICT DO NOTHING");
  const hr = (await c.query(`INSERT INTO users (email, password_hash, role, role_override, full_name) VALUES ('ivan@uts.ua','x','manager','hr','Іван Романов') RETURNING id`)).rows[0].id as number;
  await c.query(`INSERT INTO users (email, password_hash, role, team_id, full_name) VALUES ('lead@uts.ua','x','team_lead',1,'Дмитрук Олег')`);
  const db = c as unknown as import("./hiring.js").Db;
  const h = await import("./hiring.js");
  const vac = await h.createVacancy(db, null, { title: "Менеджер з продажу", position: "менеджер з продажу" });
  const id = await h.createCandidate(db, null, { fullName: "Коваленко Олена", phone: "0970000401", vacancyId: vac });
  for (const to of ["planned", "done"]) await h.changeStatus(db, null, id, { to, comment: "так" }, "edit", null);
  await h.changeStatus(db, null, id, { to: "lead", comment: "до тімліда", teamId: 1 }, "edit", null);
  await h.changeStatus(db, null, id, { to: "candidate", comment: "беремо" }, "lead", 1);
  const dir = mkdtempSync(path.join(tmpdir(), "uts-offer-"));
  const store = async (display: string, buf: Buffer) => {
    const storedName = `${createHash("sha1").update(buf).update(display).update(String(Math.random())).digest("hex")}.docx`;
    writeFileSync(path.join(dir, storedName), buf);
    return { storedName, sha256: createHash("sha256").update(buf).digest("hex") };
  };
  const load = async (n: string) => rf(path.join(dir, n));
  return { c, db, hr, id, store, load, done: async () => { await c.end(); s.dispose(); } };
}

/**
 * #578 — ОФЕР У «ДОКУМЕНТАХ»: документ розділу «Офери», адресат — акаунт кандидата, поля з картки;
 * повторне формування — ВЕРСІЯ 2 того самого документа з іншою sha256; кандидат без акаунта чи не в
 * потрібному статусі — 409; шаблон без міток — 400.
 * 🧨 Червоніє, якщо створювати другий документ, перезаписати файл без версії чи надіслати «нікому».
 */
test("#578 ЖИВИЙ SQL: офер — документ «Офери» на кандидата; повторно — нова версія, не новий документ", async (t) => {
  const s = await scratch(t); if (!s) return;
  const of = await import("./offers.js");
  try {
    await assert.rejects(of.createTemplate(s.db, s.hr, "Порожній", docx(P("без міток")), s.store), (e: unknown) => (e as { status?: number }).status === 400, "🔴 шаблон без міток прийнято");
    const { id: tpl } = await of.createTemplate(s.db, s.hr, "Офер РПК", TEMPLATE, s.store);
    const form = await of.offerForm(s.db, s.id, tpl);
    assert.deepEqual(form.fields.filter((f) => f.value).map((f) => [f.marker, f.value]).slice(0, 4),
      [["ПІБ", "Коваленко Олена"], ["Посада", "менеджер з продажу"], ["Команда", "РПК · Дмитрук"], ["Тімлід", "Дмитрук Олег"]], "🔴 поля з картки не підтягнулись");
    await assert.rejects(of.generateOffer(s.db, s.hr, s.id, tpl, {}, s.store, s.load), (e: unknown) => (e as { status?: number; extra?: { fields?: string[] } }).extra?.fields?.[0] === "Ставка", "🔴 офер без ставки сформовано");
    const r1 = await of.generateOffer(s.db, s.hr, s.id, tpl, { Ставка: "20 000" }, s.store, s.load);
    const doc = (await s.c.query(`SELECT f.section, f.addressee_user_id, f.version, f.sha256, c.user_id FROM doc_files f, hiring_candidates c WHERE f.id = $1 AND c.id = $2`, [r1.docId, s.id])).rows[0];
    assert.deepEqual([doc.section, doc.addressee_user_id, doc.version], ["offer", doc.user_id, 1], "🔴 офер не в «Оферах» або не на кандидата");
    assert.match(textOf(await s.load((await s.c.query(`SELECT stored_name FROM doc_files WHERE id = $1`, [r1.docId])).rows[0].stored_name)), /ставка 20 000 грн/);
    const r2 = await of.generateOffer(s.db, s.hr, s.id, tpl, { Ставка: "22 000" }, s.store, s.load);
    assert.deepEqual([r2.docId, r2.version], [r1.docId, 2], "🔴 повторне формування створило інший документ");
    const v = (await s.c.query(`SELECT version, sha256 FROM doc_file_versions WHERE file_id = $1 ORDER BY version`, [r1.docId])).rows;
    assert.equal(v.length, 2); assert.notEqual(v[0].sha256, v[1].sha256, "🔴 нова версія з тим самим вмістом");
    assert.equal((await s.c.query(`SELECT count(*)::int n FROM doc_files WHERE section = 'offer'`)).rows[0].n, 1);
    await s.c.query(`UPDATE hiring_candidates SET status = 'refused' WHERE id = $1`, [s.id]);
    await assert.rejects(of.generateOffer(s.db, s.hr, s.id, tpl, { Ставка: "1" }, s.store, s.load), (e: unknown) => (e as { status?: number }).status === 409, "🔴 офер відмовленому кандидату");
  } finally { await s.done(); }
});

/**
 * #579 — СТАН ОФЕРУ — З ДОКУМЕНТА Й ПІДПИСУ, а не окремий прапорець: немає → надіслано → підписано;
 * нова версія після підпису → «застарів» (потрібен новий підпис). У картці кандидата немає власної
 * колонки стану. 🧨 Червоніє, якщо тримати стан окремо або рахувати підпис старої версії.
 */
test("#579 ЖИВИЙ SQL: стан оферу — з документа й підпису; нова версія гасить старий підпис", async (t) => {
  const s = await scratch(t); if (!s) return;
  const of = await import("./offers.js");
  try {
    const cols = (await s.c.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'hiring_candidates' AND column_name LIKE 'offer%'`)).rows.map((r) => r.column_name);
    assert.deepEqual(cols, ["offer_doc_id"], "🔴 у картці кандидата зʼявився окремий стан оферу");
    assert.equal((await of.offerState(s.db, s.id)).state, "none");
    const { id: tpl } = await of.createTemplate(s.db, s.hr, "Офер РПК", TEMPLATE, s.store);
    const r1 = await of.generateOffer(s.db, s.hr, s.id, tpl, { Ставка: "20 000" }, s.store, s.load);
    assert.equal((await of.offerState(s.db, s.id)).state, "pending");
    const user = (await s.c.query(`SELECT user_id FROM hiring_candidates WHERE id = $1`, [s.id])).rows[0].user_id;
    const sign = async () => s.c.query(`INSERT INTO doc_signatures (file_id, version, sha256, signed_by, method, approved_at)
      SELECT id, version, sha256, $2, 'telegram_code', now() FROM doc_files WHERE id = $1`, [r1.docId, user]);
    await sign();
    assert.equal((await of.offerState(s.db, s.id)).state, "signed", "🔴 підписаний офер не «підписано»");
    await of.generateOffer(s.db, s.hr, s.id, tpl, { Ставка: "22 000" }, s.store, s.load);
    assert.equal((await of.offerState(s.db, s.id)).state, "outdated", "🔴 підпис старої версії зарахувано новій");
    await sign();
    assert.equal((await of.offerState(s.db, s.id)).state, "signed");
    assert.deepEqual(await of.offerStates(s.db), { [s.id]: "signed" });
    assert.ok((await s.c.query(`SELECT 1 FROM hiring_events WHERE candidate_id = $1 AND kind = 'offer'`, [s.id])).rowCount, "🔴 офер не записано в історію кандидата");
  } finally { await s.done(); }
});

/**
 * #586 — «ЗВЕДЕННЯ» РАХУЄ ОФЕРИ з того самого стану, що картка: надіслано 1 → підписано 1 після підпису.
 * 🧨 Червоніє, якщо лічити офери окремим прапорцем або не за когортою періоду.
 */
test("#586 ЖИВИЙ SQL: зведення — офери когорти «надіслано / підписано» з документа й підпису", async (t) => {
  const s = await scratch(t); if (!s) return;
  const of = await import("./offers.js");
  const { hiringSummary } = await import("./hiringFunnel.js");
  try {
    const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
    const sum = () => hiringSummary(s.db as never, { from: today, to: today });
    assert.deepEqual((await sum()).offers, { sent: 0, signed: 0, pending: 0, outdated: 0 });
    const { id: tpl } = await of.createTemplate(s.db, s.hr, "Офер РПК", TEMPLATE, s.store);
    const r = await of.generateOffer(s.db, s.hr, s.id, tpl, { Ставка: "20 000" }, s.store, s.load);
    assert.deepEqual((await sum()).offers, { sent: 1, signed: 0, pending: 1, outdated: 0 }, "🔴 надісланий офер не пораховано");
    const user = (await s.c.query(`SELECT user_id FROM hiring_candidates WHERE id = $1`, [s.id])).rows[0].user_id;
    await s.c.query(`INSERT INTO doc_signatures (file_id, version, sha256, signed_by, method, approved_at) SELECT id, version, sha256, $2, 'telegram_code', now() FROM doc_files WHERE id = $1`, [r.docId, user]);
    assert.deepEqual((await sum()).offers, { sent: 1, signed: 1, pending: 0, outdated: 0 }, "🔴 підписаний офер не пораховано");
    assert.equal((await hiringSummary(s.db as never, { from: "2020-01-01", to: "2020-01-31" })).offers.sent, 0, "🔴 офер поза когортою періоду");
  } finally { await s.done(); }
});

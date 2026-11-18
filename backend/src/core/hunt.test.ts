import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { contactKey, maskPhone, topDirections, unentity } from "./hunt.js";

/**
 * 🎯 ХАНТИНГ (15–16.11.2026, ТЗ Івана) — гейти `#3960`–`#3964`, `#3967`, `#3969`. Правила — `core/hunt.ts`; скан — `core/lardiSync.ts`
 * (чисті гейти `#3965`, `#3966`, `#3968` — у `core/lardiSync.test.ts`).
 */

/**
 * #3960 — ЧИСТІ ПРАВИЛА: контакт = найменший номер цифрами (порядок і формат номерів не важать), без телефону —
 * «компанія|імʼя»; маска лишає 2 останні цифри; топ напрямків — за кількістю; сутності HTML розшифровуються.
 * 🧨 Червоніє, якщо брати перший номер замість найменшого або маска віддасть номер повністю.
 */
test("#3960 ХАНТИНГ: ключ контакту, маска телефону, топ напрямків, назви без &quot;", () => {
  const a = contactKey([{ n: "+380 67 111 22 33" }, { n: "+380501112233" }], "X", "Y");
  const b = contactKey([{ n: "+380501112233" }, { n: "+380671112233" }], "Інша", "Інший");
  assert.equal(a, "380501112233", "🔴 ключ — не найменший номер");
  assert.equal(a, b, "🔴 той самий набір номерів у різному порядку дав різні контакти");
  assert.equal(contactKey([], " Фірма ", "Оля"), "фірма|оля", "🔴 без телефону — не «компанія|імʼя»");
  const m = maskPhone("+380671112233");
  assert.ok(m.endsWith("33") && !m.includes("1112"), `🔴 маска розкриває номер: ${m}`);
  assert.deepEqual(topDirections(["Київ → Львів", "Дніпро → Одеса", "Київ → Львів", "А → Б", "Дніпро → Одеса", "Київ → Львів"]),
    [{ dir: "Київ → Львів", n: 3 }, { dir: "Дніпро → Одеса", n: 2 }]);
  assert.equal(unentity("&quot;Балі Сервіс&quot;, ТОВ"), "\"Балі Сервіс\", ТОВ");
});

async function scratch(t: { skip: (m: string) => void }) {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const s = provisionScratch();
  if ("unavailable" in s) { t.skip(skipReason(s)); return null; }
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: s.url });
  await c.connect();
  await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
  const u = async (email: string, role: string) =>
    (await c.query(`INSERT INTO users (email, password_hash, role, role_override, full_name) VALUES ($1,'x','manager',$2,$1) RETURNING id`, [email, role])).rows[0].id as number;
  return { c, db: c as unknown as import("./secrets.js").Db, u, done: async () => { await c.end(); s.dispose(); } };
}

/** Архів `lardi_offers` → заявки й події радару: той самий одноразовий блок `schema.sql`, що на проді. */
const backfill = (c: import("pg").Client) => c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
/** Хвилин від київської півночі — щоб «сьогодні» в очікуванні рахувалось тим самим годинником, що й радар. */
const kyivMinutes = () => { const t = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Kyiv" }); return Number(t.slice(11, 13)) * 60 + Number(t.slice(14, 16)); };

/** Заявка в архів `lardi_offers` (`ago` — годин тому). */
async function offer(c: import("pg").Client, side: string, id: number, route: number, company: string, face: string, phones: string[], ago: number, opts: { frm?: string; tox?: string; total?: number | null } = {}) {
  await c.query(
    `INSERT INTO lardi_offers (side, offer_id, from_id, to_id, first_seen, company, face, phones, frm, tox, total)
     VALUES ($1, $2, $3, $3, now() - make_interval(hours => $4), $5, $6, $7, $8, $9, $10)`,
    [side, id, route, ago, company, face, JSON.stringify(phones.map((n) => ({ m: [], n }))), opts.frm ?? "Київ", opts.tox ?? "Львів", opts.total ?? null]);
}

/**
 * #3961 — ДОСТУП ПОІМЕННИЙ: людина зі списку `hunt_access` — так; інша з ТІЄЮ САМОЮ роллю (адмін) — ні. Засів схеми
 * не додає нікого, якщо Івана/Сергія/Олександра в базі немає, і не перезаписує вже наявний список.
 * 🧨 Червоніє, якщо `huntAllowed` перевірятиме роль або засів повторюватиметься щовикату.
 */
test("#3961 ЖИВИЙ SQL ХАНТИНГУ: доступ — за списком, а не за роллю; засів не перезаписує", async (t) => {
  const s = await scratch(t); if (!s) return;
  const h = await import("./hunt.js");
  try {
    const a1 = await s.u("a1@uts.ua", "admin"), a2 = await s.u("a2@uts.ua", "admin");
    await s.c.query(`INSERT INTO hunt_access (user_id) VALUES ($1)`, [a1]);
    assert.equal(await h.huntAllowed(s.db, a1), true, "🔴 людина зі списку не пройшла");
    assert.equal(await h.huntAllowed(s.db, a2), false, "🔴 адмін поза списком пройшов — межа рольова, а не поіменна");
    await s.c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    assert.deepEqual((await s.c.query(`SELECT user_id FROM hunt_access`)).rows.map((r) => r.user_id), [a1], "🔴 повторна міграція змінила список доступу");
    // Межа стоїть у роутері ПЕРЕД усіма роутами, крім `/access`.
    const src = readFileSync(path.join(import.meta.dirname, "..", "routes", "hunt.js"), "utf8");
    const gate = src.search(/if \(!\(await huntAllowed\(db\(\), me\(req\)\)\)\)\s*return res\.status\(403\)/);
    assert.ok(gate > 0, "🔴 у роутері немає поіменної межі");
    for (const r of ["/radar", "/contacts/phones", "/candidates\"", "/candidates/:id/stage"])
      assert.ok(src.indexOf(`huntRouter.${r === "/contacts/phones" || r === "/candidates/:id/stage" ? "post" : "get"}("${r.replace("\"", "")}`) > gate, `🔴 роут ${r} оголошено ДО поіменної межі`);
  } finally { await s.done(); }
});

/**
 * #3962 — ЖИВИЙ SQL РАДАРУ: одна заявка, побачена кількома сканами чи маршрутами, — один раз; два імені з тим самим
 * номером — один контакт; ЮТС поза радаром; вікна 1/7/30 днів по обидва боки межі; «у воронці» позначено, «лише нові» — без нього.
 * 🧨 Червоніє, якщо рахувати рядки архіву замість заявок, не виключити своїх або злити контакти за імʼям.
 */
test("#3962 ЖИВИЙ SQL РАДАРУ: унікальні заявки, контакт за номером, свої поза, вікна періодів, позначка воронки", async (t) => {
  const s = await scratch(t); if (!s) return;
  const h = await import("./hunt.js");
  try {
    await offer(s.c, "cargo", 1, 10, "Альфа, ТОВ", "Оля", ["+380501112233"], 2);
    await offer(s.c, "cargo", 1, 11, "Альфа, ТОВ", "Оля", ["+380501112233"], 5);          // та сама заявка іншим маршрутом
    await offer(s.c, "cargo", 2, 10, "Альфа, ТОВ", "Ольга", ["+380501112233"], 24 * 3, { total: 20000 }); // інше імʼя, той самий номер
    await offer(s.c, "lorry", 3, 10, "Альфа, ТОВ", "Оля", ["+380501112233"], 24 * 20);
    await offer(s.c, "cargo", 4, 10, "Бета", "Петро", ["+380671234567"], 24 * 40);         // поза 30 днями
    await offer(s.c, "cargo", 5, 10, "ЮТС, ТОВ", "Наш", ["+380630000000"], 1);             // свої
    await backfill(s.c);
    const r = await h.radar(s.db, { days: 30 });
    assert.deepEqual(r.rows.map((x) => x.key), ["380501112233"], "🔴 не той склад радару (свої / поза 30 днями / злиття)");
    const o = r.rows[0];
    const today = kyivMinutes() >= 125 ? 1 : 0; // подія 2 год тому — «сьогодні», лише якщо в Києві вже після ~02:05
    assert.deepEqual([o.h1, o.d7, o.d30, o.cargo, o.lorry, o.pricePct], [0, 2, 3, 2, 1, 33], "🔴 вікна чи унікальність заявок рахуються не так");
    if (Math.abs(kyivMinutes() - 120) > 5) assert.equal(o.d1, today, "🔴 «сьогодні» рахується не від київської півночі");
    assert.deepEqual([o.live, o.bot, o.hours], [false, false, null], "🔴 архівні події (час нашого скану) дали години чи мітку бота");
    assert.ok(!o.phones[0].includes("1112"), "🔴 радар віддав повний номер");
    assert.deepEqual((await h.radar(s.db, { days: 7 })).rows.map((x) => x.d7), [2]);
    await h.addCandidate(s.db, (await s.u("i@uts.ua", "hr")), { key: "380501112233" });
    assert.equal((await h.radar(s.db, { days: 30 })).rows[0].candidate?.stage, "picked", "🔴 радар не бачить, що контакт у воронці");
    assert.equal((await h.radar(s.db, { days: 30, show: "new" })).rows.length, 0, "🔴 «лише нові» показав того, хто у воронці");
  } finally { await s.done(); }
});

/**
 * #3963 — ЖИВИЙ SQL ВОРОНКИ: додавання кладе знімок активності й перший рядок історії; двічі живим — 409; кожна зміна
 * етапу — рядок історії; «Відмова» без причини — 400; повернення з відмови, коли контакт уже знову у воронці, — 409;
 * перегляд телефону пишеться в журнал; коментар без тексту — 400.
 * 🧨 Червоніє, якщо зміна етапу не пише історію або відмова приймається без причини.
 */
test("#3963 ЖИВИЙ SQL ВОРОНКИ: знімок і історія, двічі — 409, відмова з причиною, журнал телефону", async (t) => {
  const s = await scratch(t); if (!s) return;
  const h = await import("./hunt.js");
  try {
    const iv = await s.u("i@uts.ua", "hr");
    await offer(s.c, "cargo", 1, 10, "Альфа", "Оля", ["+380501112233"], 2);
    await backfill(s.c);
    const { id } = await h.addCandidate(s.db, iv, { key: "380501112233", interest: "60 заявок на тиждень" });
    await assert.rejects(h.addCandidate(s.db, iv, { key: "380501112233" }), /уже у воронці/);
    const d0 = await h.candidateDetail(s.db, id);
    assert.equal(d0.source.d30, 1, "🔴 знімок активності не збережено");
    assert.deepEqual(d0.phones, ["+380501112233"], "🔴 у воронці мають бути повні номери");
    await h.changeStage(s.db, iv, id, { to: "call" });
    await assert.rejects(h.changeStage(s.db, iv, id, { to: "rejected" }), /причину/);
    await h.changeStage(s.db, iv, id, { to: "rejected", reason: "salary" });
    const hist = (await s.c.query(`SELECT from_stage, to_stage, reason FROM hunt_stage_history WHERE candidate_id = $1 ORDER BY id`, [id])).rows;
    assert.deepEqual(hist.map((x) => `${x.from_stage}>${x.to_stage}${x.reason ? ":" + x.reason : ""}`), ["null>picked", "picked>call", "call>rejected:salary"]);
    const { id: id2 } = await h.addCandidate(s.db, iv, { key: "380501112233" });
    assert.ok(id2 !== id, "🔴 після відмови контакт не можна було додати знову");
    await assert.rejects(h.changeStage(s.db, iv, id, { to: "call" }), /іншою карткою/);
    await assert.rejects(h.addComment(s.db, iv, id2, { text: "  " }), /Порожній/);
    await h.addComment(s.db, iv, id2, { text: "Подзвонив, цікаво", remindAt: "2026-12-01T10:00:00Z" });
    assert.equal((await h.candidateDetail(s.db, id2)).timeline.filter((x: { kind: string }) => x.kind === "comment").length, 1);
    await h.revealPhones(s.db, iv, "380501112233");
    assert.equal((await s.c.query(`SELECT count(*)::int AS n FROM hunt_phone_views WHERE user_id = $1`, [iv])).rows[0].n, 1, "🔴 перегляд телефону не в журналі");
  } finally { await s.done(); }
});

/** Заявка живого скану в документованій формі Ларді (`ago` — хвилин тому від ОДНІЄЇ мітки: Ларді віддає ту саму дату щоскану). */
const T0 = Date.now();
const lardiItem = (id: number, refId: number, phone: string, ago: number, o: { repeatAgo?: number; auto?: boolean; to?: string; area?: string; price?: number } = {}) => ({
  id, dateCreate: T0 - ago * 60_000, dateRepeat: o.repeatAgo != null ? T0 - o.repeatAgo * 60_000 : T0 - ago * 60_000,
  waypointListSource: [{ town: { id: 1, name: "Київ" }, area: { id: 1, name: o.area ?? "Київська" }, country: { id: 1, name: "Україна", sign: "UA" } }],
  waypointListTarget: [{ town: { id: 2, name: o.to === "PL" ? "Варшава" : "Львів" }, country: { sign: o.to ?? "UA" } }],
  payment: o.price ? { value: o.price, currency: { name: "грн" } } : {}, repeat: { auto: o.auto ?? false, countToday: 0 },
  owner: { refId, contactId: refId * 10, name: `Фірма ${String(refId)}`, face: `Менеджер ${String(refId)}`, phones: [{ number: phone }] },
});

/**
 * #3967 — ЖИВИЙ SQL СКАНУ: нова заявка — подія `new` на `dateCreate`; та сама ще раз — жодної події; `dateRepeat` зрушив —
 * `repeat`; заявка, що вже є в архіві, — без другої `new`. Радар: «за годину» з живих подій, міжнародні, вантажовласники
 * (за `lardi_shippers`), бот за `repeat.auto` і фільтр «приховати», область відправки.
 * 🧨 Червоніє, якщо повторний скан плодить події, підняття не пишеться або архівна заявка рахується двічі.
 */
test("#3967 ЖИВИЙ SQL СКАНУ ЛАРДІ: new/repeat без дублів, архів без другої «нової», фільтри радару й мітка бота", async (t) => {
  const s = await scratch(t); if (!s) return;
  const h = await import("./hunt.js");
  const { parseProposal } = await import("./lardiSync.js");
  const { recordProposals } = await import("./lardiSyncDb.js");
  const P = (it: unknown, kind: "cargo" | "lorry" = "cargo") => parseProposal(kind, it)!;
  const ev = async () => (await s.c.query(`SELECT proposal_id::int AS id, type, source FROM lardi_proposal_events ORDER BY proposal_id, type`)).rows.map((r) => `${r.id}:${r.type}:${r.source}`);
  try {
    await offer(s.c, "cargo", 900, 10, "Архів", "Олег", ["+380990000001"], 5);
    await backfill(s.c);
    assert.deepEqual(await recordProposals(s.db, [P(lardiItem(1, 7, "+380501112233", 30)), P(lardiItem(2, 7, "+380501112233", 20, { to: "PL" }))]), { fresh: 2, events: 2 });
    assert.deepEqual(await recordProposals(s.db, [P(lardiItem(1, 7, "+380501112233", 30))]), { fresh: 0, events: 0 }, "🔴 повторний скан тієї самої заявки дав подію");
    assert.deepEqual(await recordProposals(s.db, [P(lardiItem(1, 7, "+380501112233", 30, { repeatAgo: 5 }))]), { fresh: 0, events: 1 }, "🔴 підняття не записано");
    assert.deepEqual(await recordProposals(s.db, [P(lardiItem(1, 7, "+380501112233", 30, { repeatAgo: 5 }))]), { fresh: 0, events: 0 }, "🔴 те саме підняття записано двічі");
    assert.deepEqual(await recordProposals(s.db, [P(lardiItem(900, 8, "+380990000001", 300))]), { fresh: 0, events: 0 }, "🔴 архівна заявка отримала другу «нову»");
    assert.deepEqual(await ev(), ["1:new:live", "1:repeat:live", "2:new:live", "900:new:archive"]);
    await recordProposals(s.db, [P(lardiItem(3, 9, "+380671234567", 10, { auto: true, area: "Львівська" }))]);
    await s.c.query(`INSERT INTO lardi_shippers (ref_id) VALUES (9)`);
    const all = await h.radar(s.db, { period: "h1" });
    const a = all.rows.find((r) => r.key === "380501112233")!;
    assert.deepEqual([a.h1, a.intl, a.live, a.bot, a.shipper], [3, 1, true, false, false], "🔴 «за годину», міжнародні чи позначки живого контакту рахуються не так");
    assert.ok(!all.rows.some((r) => r.key === "380990000001"), "🔴 архівна подія 5 год тому потрапила в «за годину»");
    const b = all.rows.find((r) => r.key === "380671234567")!;
    assert.deepEqual([b.bot, b.shipper, b.area], [true, true, "Львівська"], "🔴 бот за repeat.auto, вантажовласник чи область не позначені");
    assert.deepEqual((await h.radar(s.db, { period: "h1", hideBots: "1" })).rows.map((r) => r.key), ["380501112233"], "🔴 «приховати автоповтор» не прибрав бота");
    assert.deepEqual((await h.radar(s.db, { period: "h1", ctype: "no_shippers" })).rows.map((r) => r.key), ["380501112233"], "🔴 «без вантажовласників» лишив вантажовласника");
    assert.deepEqual((await h.radar(s.db, { period: "h1", ctype: "shippers" })).rows.map((r) => r.key), ["380671234567"], "🔴 «лише вантажовласники» — не той склад");
    assert.deepEqual((await h.radar(s.db, { period: "h1", dir: "intl" })).rows.map((r) => r.key), ["380501112233"], "🔴 «міжнародні» — не той склад");
    assert.deepEqual((await h.radar(s.db, { period: "h1", dir: "intl" })).rows[0].h1, 1, "🔴 у «міжнародних» порахувались внутрішні заявки");
    assert.deepEqual((await h.radar(s.db, { period: "h1", area: "львів" })).rows.map((r) => r.key), ["380671234567"], "🔴 фільтр області не працює");
    assert.equal(all.live.until !== null && all.archiveUntil !== null, true, "🔴 радар не каже, до коли живі й архівні дані");
  } finally { await s.done(); }
});

/**
 * #3977 — ДОВЕДЕННЯ ДО ТЗ, ЖИВИЙ SQL: рейтинг компанії в рядку радару; «експедитори» = без вантажовласників і
 * перевізників; свої за ID Ларді поза радаром; строк зберігання по обидва боки межі (91 день не у воронці — видалено,
 * 89 днів — лишився, 91 день у воронці — лишився); нагадування — раз, не для відмови; звіт рахує «дійшли» за історією.
 * 🧨 Червоніє, якщо чистити контакт із воронки, слати нагадування двічі або рахувати звіт за поточним етапом.
 */
test("#3977 ЖИВИЙ SQL ХАНТИНГУ ДО ТЗ: рейтинг, експедитори, свої за ID, 90 днів, нагадування раз, звіт за історією", async (t) => {
  const s = await scratch(t); if (!s) return;
  const h = await import("./hunt.js");
  const { parseProposal } = await import("./lardiSync.js");
  const { recordProposals, markCompanies, purgeStaleContacts } = await import("./lardiSyncDb.js");
  const P = (it: Record<string, unknown>) => parseProposal("cargo", it)!;
  const rated = (id: number, ref: number, phone: string, pos: number) => { const it = lardiItem(id, ref, phone, 10) as { owner: Record<string, unknown> }; it.owner.rating = { positiveCommentCount: pos, negativeCommentCount: 1 }; return P(it as never); };
  try {
    await recordProposals(s.db, [rated(1, 7, "+380501112233", 40), rated(2, 8, "+380671234567", 5), rated(3, 9, "+380931234567", 9), rated(4, h.OWN_LARDI_REF_IDS[0], "+380630000000", 1)]);
    await markCompanies(s.db, [8], "shipper"); await markCompanies(s.db, [9], "carrier"); await markCompanies(s.db, [9], "shipper");
    const all = await h.radar(s.db, { period: "h1" });
    assert.deepEqual(all.rows.map((r) => r.key).sort(), ["380501112233", "380671234567", "380931234567"], "🔴 своя компанія за ID Ларді потрапила в радар");
    assert.deepEqual(all.rows.find((r) => r.key === "380501112233")!.rating, { pos: 40, neg: 1 }, "🔴 рейтинг компанії не дійшов до радару");
    assert.deepEqual((await h.radar(s.db, { period: "h1", ctype: "forwarders" })).rows.map((r) => r.key), ["380501112233"], "🔴 «експедитори» лишили вантажовласника чи перевізника");
    assert.deepEqual((await h.radar(s.db, { period: "h1", ctype: "carriers" })).rows.map((r) => [r.key, r.shipper, r.carrier]), [["380931234567", true, true]], "🔴 позначки компанії не складаються");

    const iv = await s.u("i@uts.ua", "hr");
    const { id } = await h.addCandidate(s.db, iv, { key: "380671234567" });
    await s.c.query(`UPDATE lardi_proposals SET last_seen_at = now() - interval '91 days' WHERE id IN (1, 2)`);
    await s.c.query(`UPDATE lardi_proposals SET last_seen_at = now() - interval '89 days' WHERE id = 3`);
    assert.equal(await purgeStaleContacts(s.db), 1, "🔴 видалено не рівно один застарілий контакт");
    assert.deepEqual((await s.c.query(`SELECT id::int FROM lardi_proposals WHERE id IN (1,2,3) ORDER BY id`)).rows.map((r) => r.id), [2, 3], "🔴 межа 90 днів або захист воронки не працює");
    assert.equal((await s.c.query(`SELECT count(*)::int AS n FROM lardi_proposal_events WHERE proposal_id = 1`)).rows[0].n, 0, "🔴 події видаленої заявки лишились");

    await h.addComment(s.db, iv, id, { text: "Передзвонити", remindAt: new Date(Date.now() - 60_000).toISOString() });
    await h.addComment(s.db, iv, id, { text: "Пізніше", remindAt: new Date(Date.now() + 3_600_000).toISOString() });
    const due = await h.dueReminders(s.db);
    assert.deepEqual(due.map((d) => [d.text, d.user_id, d.candidate_id]), [["Передзвонити", iv, id]], "🔴 нагадування: не той склад");
    await h.markReminded(s.db, due.map((d) => d.id));
    assert.equal((await h.dueReminders(s.db)).length, 0, "🔴 нагадування прийшло б удруге");
    await h.addComment(s.db, iv, id, { text: "Після відмови", remindAt: new Date(Date.now() - 60_000).toISOString() });
    await h.changeStage(s.db, iv, id, { to: "call" }); await h.changeStage(s.db, iv, id, { to: "interview" });
    await h.changeStage(s.db, iv, id, { to: "rejected", reason: "salary" });
    assert.equal((await h.dueReminders(s.db)).length, 0, "🔴 нагадування по кандидату з відмовою");
    await h.addCandidate(s.db, iv, { key: "380931234567" });
    const rep = await h.report(s.db);
    assert.deepEqual(rep.stages.slice(0, 4).map((x) => [x.key, x.reached, x.now, x.conversionPct]),
      [["picked", 2, 1, 100], ["call", 1, 0, 50], ["interview", 1, 0, 100], ["approval", 0, 0, 0]], "🔴 звіт рахує не за історією етапів");
    assert.deepEqual(rep.rejects, [{ reason: "salary", from_stage: "interview", n: 1 }], "🔴 причини відмов у звіті");
  } finally { await s.done(); }
});

/**
 * #3964 — ФРОНТ: пункт «Хантинг» зʼявляється лише за відповіддю сервера (`fetchHuntAccess`), а не за роллю.
 * 🧨 Червоніє, якщо показувати пункт усім із вкладкою «Найм».
 */
test("#3964 ФРОНТ ХАНТИНГУ: пункт у «Наймі» лише за `/api/hunt/access`", () => {
  const src = readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", "pages", "dashboard", "sections", "HiringSection.tsx"), "utf8");
  assert.match(src, /fetchHuntAccess\(\)\.then\(setCanHunt\)/, "🔴 доступ до «Хантингу» не питають у сервера");
  assert.match(src, /if \(canHunt\) tabs\.push\(\["hunt", "Хантинг"\]\)/, "🔴 пункт «Хантинг» не залежить від відповіді сервера");
  assert.match(src, /active === "hunt" && canHunt && <HiringHunt/, "🔴 екран рендериться без перевірки доступу");
});

/**
 * #3969 — ФРОНТ ПРОХОДУ 3: період «Година», фільтри напрямку / типу компанії / області, «приховати автоповтор»,
 * мітка бота й години публікації в картці, плашка, що живий скан не працює, з текстом помилки сервера.
 * 🧨 Червоніє, якщо прибрати будь-який із цих елементів ТЗ п.6–8 з екрана.
 */
test("#3969 ФРОНТ ХАНТИНГУ, прохід 3: година, фільтри ТЗ, бот, години, плашка живого скану", () => {
  const src = readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", "pages", "dashboard", "sections", "HiringHunt.tsx"), "utf8");
  for (const [re, why] of [
    [/\["h1", "Година"\]/, "період «Година»"], [/hideBots/, "фільтр «приховати автоповтор»"], [/"intl"/, "фільтр «міжнародні»"],
    [/"no_shippers"/, "фільтр типу компанії"], [/area/, "фільтр області"], [/схоже на автоповтор/, "мітка бота"],
    [/Зазвичай публікує/, "години публікації в картці"], [/live\.error/, "плашка з помилкою живого скану"],
  ] as [RegExp, string][]) assert.match(src, re, `🔴 на екрані немає: ${why}`);
});

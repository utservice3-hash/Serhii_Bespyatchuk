import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { contactKey, maskPhone, topDirections, unentity } from "./hunt.js";

/**
 * 🎯 ХАНТИНГ (15.11.2026, ТЗ Івана) — гейти `#3960`–`#3964`. Правила — `core/hunt.ts`.
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
    const r = await h.radar(s.db, { days: 30 });
    assert.deepEqual(r.rows.map((x) => x.key), ["380501112233"], "🔴 не той склад радару (свої / поза 30 днями / злиття)");
    const o = r.rows[0];
    assert.deepEqual([o.d1, o.d7, o.d30, o.cargo, o.lorry, o.pricePct], [1, 2, 3, 2, 1, 33], "🔴 вікна чи унікальність заявок рахуються не так");
    assert.ok(!o.phones[0].includes("1112"), "🔴 радар віддав повний номер");
    assert.deepEqual((await h.radar(s.db, { days: 1 })).rows.map((x) => x.d1), [1]);
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

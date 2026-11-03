import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { verdictOf, claimBlocked } from "../core/carrierPhones.js";

/**
 * 📵 ЗАДАЧА 7359 — НОМЕРИ ПЕРЕВІЗНИКІВ НА ЕКРАНІ КЛІЄНТІВ (ТЗ Юлії «Контакти клієнтів», етап 1).
 *
 * Перевізник = номер із машин Lardi або номер, який закривали як «Перевізник»; номер з угодою замовника в роботі
 * чи в «Успіх» — ні (рішення Романа 03.11.2026). Три наслідки: «Якість даних», розмови на екрані клієнтів,
 * «Взяти в роботу» в нічийних. Кожне твердження — по обидва боки межі, на СВОЄМУ кластері: довідник, дзвінки й
 * обробники роутів виконуються проти бази з нуля.
 */
/** Джерело `src` (тест біжить із `dist`). */
const SRC = (rel: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "src", rel), "utf8");

type Client = { query<R = Record<string, unknown>>(q: string, p?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>; end(): Promise<void> };
let ready: Promise<Client | string> | null = null;
function db(): Promise<Client | string> {
  ready ??= (async () => {
    const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
    const scratch = provisionScratch();
    if ("unavailable" in scratch) return skipReason(scratch);
    process.env.DATABASE_URL = scratch.url;
    process.env.JWT_SECRET ??= "test";
    process.env.KOMMO_BASE_URL ??= "https://x.invalid";
    process.env.KOMMO_API_TOKEN ??= "test";
    const { default: pg } = await import("pg");
    const c = new pg.Client({ connectionString: scratch.url });
    await c.connect();
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    await c.query("INSERT INTO pipeline_stage_map (pipeline_id, status_id, funnel_stage) VALUES (8921932, 142, 'paid') ON CONFLICT DO NOTHING");
    await c.query("INSERT INTO teams(id,name) VALUES (1,'РПК-А'),(2,'РПК-Б') ON CONFLICT DO NOTHING");
    await c.query("INSERT INTO users(id,email,password_hash,role,full_name) VALUES (1,'kvp@uts.ua','x','admin','КВП') ON CONFLICT DO NOTHING");
    await c.query(`INSERT INTO managers(id,name,team_id,is_active,kommo_user_id) VALUES (1,'Яцик',1,true,501),(2,'Дмитрук',2,true,502)
                   ON CONFLICT DO NOTHING`);
    return c as unknown as Client;
  })();
  return ready;
}
after(async () => {
  const c = await ready;
  if (c && typeof c !== "string") {
    await c.end();
    const { pool } = await import("../db/pool.js");
    await pool.end();
  }
});

const deal = (c: Client, id: number, name: string, pipeline: number, status: number, o: { reject?: string; key?: string; mgr?: number } = {}) =>
  c.query(`INSERT INTO deals(kommo_id,name,pipeline_id,status_id,reject_reason,client_key,client_key_raw,client_name,manager_id,price,closed_at_kommo,created_at_kommo)
           VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,1000,now() - interval '5 days',now() - interval '10 days')`,
    [id, name, pipeline, status, o.reject ?? null, o.key ?? null, o.key ? `Клієнт ${o.key}` : null, o.mgr ?? null]);
const contact = async (c: Client, dealId: number, contactId: number, phone: string) => {
  await c.query("INSERT INTO deal_contacts(deal_kommo_id, contact_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [dealId, contactId]);
  await c.query("INSERT INTO contact_phones(contact_id, phone) VALUES ($1,$2) ON CONFLICT DO NOTHING", [contactId, phone]);
};
const lardi = (c: Client, id: number, side: string, phone: string, company = "ФОП Возій") =>
  c.query(`INSERT INTO lardi_offers(side, offer_id, from_id, to_id, company, phones) VALUES ($1,$2,1,2,$3,$4::jsonb)`,
    [side, id, company, JSON.stringify([{ n: `+${phone}` }])]);
const rebuild = async (c: Client) => {
  const { rebuildCarrierPhones } = await import("../core/carrierPhones.js");
  return rebuildCarrierPhones(c);
};
const inDict = async (c: Client, phone: string) =>
  (await c.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM carrier_phones WHERE p9 = right($1, 9)", [phone])).rows[0].n === 1;
type Handler = (req: unknown, res: unknown, next: (e?: unknown) => void) => Promise<void>;
async function handler(method: "get" | "post", p: string): Promise<Handler> {
  const { dashboardRouter } = await import("./dashboard.js");
  type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: { handle: unknown }[] } };
  const layer = (dashboardRouter as unknown as { stack: Layer[] }).stack.find((l) => l.route?.path === p && l.route.methods[method]);
  assert.ok(layer, `🔴 роут ${method.toUpperCase()} ${p} зник — гейт втратив предмет`);
  return layer.route!.stack[layer.route!.stack.length - 1].handle as Handler;
}
async function call(h: Handler, req: Record<string, unknown>): Promise<{ code: number; body: unknown }> {
  let code = 200; let body: unknown; let thrown: unknown = null;
  const res = { status(x: number) { code = x; return res; }, json(b: unknown) { body = b; return res; } };
  await h(req, res, (e?: unknown) => { if (e) thrown = e; }).catch((e) => { thrown = e; });
  assert.equal(thrown, null, `🔴 обробник впав: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
  return { code, body };
}

test("#3590 ДОВІДНИК ПЕРЕВІЗНИКІВ: Lardi-машини й «Перевізник» — так; вантажі Lardi й інша причина — ні; угода замовника — виняток, воронки перевізника — ні", async (t) => {
  const c = await db(); if (typeof c === "string") return t.skip(c);
  const P = { lorry: "380673590001", cargo: "380673590002", hist: "380673590003", other: "380673590004",
    won: "380673590005", open: "380673590006", payment: "380673590007", stage: "380673590008", byName: "380673590009" };
  await lardi(c, 1, "lorry", P.lorry);
  await lardi(c, 2, "cargo", P.cargo);
  await deal(c, 35901, "ТОВ Вантаж", 8921928, 143, { reject: "Перевізник" }); await contact(c, 35901, 3591, P.hist);
  await deal(c, 35902, "ТОВ Інше", 8921928, 143, { reject: "Дубль" }); await contact(c, 35902, 3592, P.other);
  await lardi(c, 3, "lorry", P.won); await deal(c, 35903, "ТОВ Замовник", 8921932, 142); await contact(c, 35903, 3593, P.won);
  await lardi(c, 4, "lorry", P.open); await deal(c, 35904, "ТОВ У роботі", 8921932, 61234567); await contact(c, 35904, 3594, P.open);
  await lardi(c, 5, "lorry", P.payment); await deal(c, 35905, "Оплата перевізнику", 7341740, 142); await contact(c, 35905, 3595, P.payment);
  await lardi(c, 6, "lorry", P.stage); await deal(c, 35906, "Дзвінок", 8921928, 70419108); await contact(c, 35906, 3596, P.stage);
  await deal(c, 35907, P.byName, 8921928, 143, { reject: "Перевізник" });                    // номер лише в НАЗВІ угоди
  const n = await rebuild(c);

  assert.equal(await inDict(c, P.lorry), true, "🔴 номер із машин Lardi не впізнано перевізником (ТЗ: «номер з Lardi»)");
  assert.equal(await inDict(c, P.cargo), false, "🔴 номер із ВАНТАЖІВ Lardi став перевізником — там і замовники, й експедитори");
  assert.equal(await inDict(c, P.hist), true, "🔴 номер, який закривали як «Перевізник», не впізнано (ТЗ)");
  assert.equal(await inDict(c, P.other), false, "🔴 закрита з ІНШОЮ причиною угода зробила номер перевізником");
  assert.equal(await inDict(c, P.byName), true, "🔴 номер лише в назві угоди «Перевізник» — історію не знайдено");
  assert.equal(await inDict(c, P.won), false, "🔴 номер з угодою замовника в «Успіх» лишився перевізником — рішення Романа 03.11: виняток");
  assert.equal(await inDict(c, P.open), false, "🔴 номер з угодою замовника в роботі лишився перевізником — рішення Романа 03.11: виняток");
  assert.equal(await inDict(c, P.payment), true, "🔴 «оплата перевізнику» зарахована угодою замовника — перевізника знято з довідника");
  assert.equal(await inDict(c, P.stage), true, "🔴 угода етапу фільтра (її створив сам дзвінок) зарахована винятком");
  assert.equal(n, 5, "кількість номерів, яку повернула перебудова, ≠ складу довідника");
  assert.equal(await rebuild(c), 5, "🔴 повторна перебудова не ідемпотентна — довідник розростається або порожніє");
});

test("#3591 РОЗМОВИ НА НОМЕР ПЕРЕВІЗНИКА НЕ РАХУЮТЬСЯ: дзвінки місяця без них; номер замовника й невідомий номер — рахуються", async (t) => {
  const c = await db(); if (typeof c === "string") return t.skip(c);
  const CAR = "380673591001", CLI = "380673591002", KEY = "кліент3591";
  await lardi(c, 3591, "lorry", CAR);
  await rebuild(c);
  const ins = (id: string, phone: string | null, sec: number) => c.query(
    `INSERT INTO ringostat_calls(uniqueid,calldate,call_type,billsec,client_phone,client_key) VALUES ($1,'2026-10-15 12:00+03','out',$2,$3,$4)`,
    [id, sec, phone, KEY]);
  await ins("r3591a", CAR, 60); await ins("r3591b", CAR, 0); await ins("r3591c", CLI, 45); await ins("r3591d", null, 30);
  const { callsByMonth } = await import("../core/clientCalls.js");
  const m = (await callsByMonth([KEY], "2026-10")).get(KEY);
  assert.deepEqual(m, { calls: 2, talks: 2 },
    "🔴 дзвінки місяця: розмова/спроба на номер перевізника зарахована клієнту (ТЗ: «розмови рахуються тільки з номерами замовників»), "
    + "або загубились дзвінки замовника й дзвінок без номера");
  // Ті самі умови стоять у «останній розмові» й «спробах» реактивації та в картці — одним виразом, не копією.
  const react = SRC("core/reactivation.ts");
  assert.equal(react.match(/notCarrierCallSql\("rc"\)/g)?.length, 2, "🔴 «остання розмова» або «спроби» реактивації рахують номери перевізників");
  const dash = SRC("routes/dashboard.ts");
  const card = dash.slice(dash.indexOf("const [cardStep, cardPhones, cardLastCall"), dash.indexOf("carrierTalks: Number("));
  assert.equal(card.match(/carrierPhones\.notCarrierCallSql\("rc"\)/g)?.length, 2, "🔴 картка клієнта: остання розмова або перелік розмов рахують номери перевізників");
});

test("#3592 СТАН НОМЕРІВ КЛІЄНТА: немає номера · лише перевізники · є перевізник · усе гаразд; фізособа — за ключем; «взяти» блокує лише «лише перевізники»", async (t) => {
  assert.equal(verdictOf([]), "no_phone");
  assert.equal(verdictOf([{ carrier: {} }, { carrier: {} }]), "only_carrier");
  assert.equal(verdictOf([{ carrier: {} }, { carrier: null }]), "has_carrier");
  assert.equal(verdictOf([{ carrier: null }]), "ok");
  assert.equal(claimBlocked("only_carrier"), true, "🔴 клієнта з самими номерами перевізників можна взяти в роботу (ТЗ, крок 3)");
  for (const v of ["no_phone", "has_carrier", "ok"] as const)
    assert.equal(claimBlocked(v), false, `🔴 «${v}» блокує «Взяти в роботу» — ТЗ забороняє лише коли ВСІ номери перевізницькі`);

  const c = await db(); if (typeof c === "string") return t.skip(c);
  const CAR1 = "380673592001", CAR2 = "380673592002", CLI = "380673592003", PERSON = "380673592004";
  await lardi(c, 35921, "lorry", CAR1); await lardi(c, 35922, "lorry", CAR2); await lardi(c, 35923, "lorry", PERSON);
  // Номери лише на ПРОГРАНИХ угодах клієнта, інакше виняток «угода замовника» знімає їх із довідника.
  await deal(c, 35921, "Угода 1", 8921932, 143, { key: "тільки3592" }); await contact(c, 35921, 35921, CAR1);
  await deal(c, 35922, "Угода 2", 8921932, 143, { key: "змішаний3592" }); await contact(c, 35922, 35922, CAR2);
  await deal(c, 35923, "Угода 3", 8921932, 143, { key: "змішаний3592" }); await contact(c, 35923, 35923, CLI);
  await rebuild(c);
  const { clientPhones } = await import("../core/carrierPhones.js");
  const m = await clientPhones(c, ["тільки3592", "змішаний3592", "безномера3592", PERSON]);
  assert.equal(verdictOf(m.get("тільки3592") ?? []), "only_carrier");
  assert.equal(verdictOf(m.get("змішаний3592") ?? []), "has_carrier");
  assert.equal(verdictOf(m.get("безномера3592") ?? []), "no_phone");
  assert.equal(verdictOf(m.get(PERSON) ?? []), "only_carrier", "🔴 фізособа (ключ = телефон) — її номер не перевірено");
  assert.equal(m.get("змішаний3592")?.find((p) => p.phone === CAR2)?.carrier?.lardi, true, "джерело «Lardi» не дійшло до рядка");
});

test("#3593 «ВЗЯТИ В РОБОТУ»: лише номери перевізників → 409 і нічого не закріплено; є номер замовника → закріплено", async (t) => {
  const c = await db(); if (typeof c === "string") return t.skip(c);
  const CAR = "380673593001", CLI = "380673593002";
  await lardi(c, 35931, "lorry", CAR);
  await deal(c, 35931, "Угода", 8921932, 143, { key: "перевізний3593" }); await contact(c, 35931, 35931, CAR);
  await deal(c, 35932, "Угода", 8921932, 143, { key: "живий3593" }); await contact(c, 35932, 35932, CLI);
  await rebuild(c);
  const h = await handler("post", "/orphan-clients/claim");
  const auth = { userId: 1, role: "admin", roleKey: "admin", managerId: null, teamId: null };
  const a = await call(h, { auth, body: { clientKey: "перевізний3593", managerId: 1 } });
  assert.equal(a.code, 409, "🔴 клієнта з самими номерами перевізників узято в роботу (ТЗ, крок 3)");
  assert.match(String((a.body as { error?: string }).error), /лише номери перевізників/, "відмова без пояснення — людина не знає, що виправити");
  const pinned = (k: string) => c.query("SELECT 1 FROM loyalty_overrides WHERE client_key = $1 AND pinned_manager_id IS NOT NULL", [k]);
  assert.equal((await pinned("перевізний3593")).rowCount, 0, "🔴 відмова сказала 409, а клієнта однаково закріплено");
  const b = await call(h, { auth, body: { clientKey: "живий3593", managerId: 1 } });
  assert.equal(b.code, 200, "🔴 дзеркало: клієнта з номером замовника не можна взяти — перевірка гасить усіх");
  assert.equal((await pinned("живий3593")).rowCount, 1, "клієнта з номером замовника не закріплено");
});

test("#3594 «ЯКІСТЬ ДАНИХ» · НОМЕРИ: клієнти екрана без номера замовника — у списку з командою; тімлід бачить лише свою команду, адмін — обидві", async (t) => {
  const c = await db(); if (typeof c === "string") return t.skip(c);
  const CAR = "380673594001", OK = "380673594002";
  // Клієнт екрана = 2+ успішні угоди. «а3594» (команда 1) — без номерів; «б3594» (команда 2) — номер замовника на
  // успішній угоді й номер перевізника на програній; «в3594» (команда 2) — лише номер замовника (у списку немає).
  for (const [id, key, mgr] of [[35941, "а3594", 1], [35942, "а3594", 1], [35943, "б3594", 2], [35944, "б3594", 2],
    [35945, "в3594", 2], [35946, "в3594", 2]] as const) await deal(c, id, `Угода ${String(id)}`, 8921932, 142, { key, mgr });
  await contact(c, 35943, 35943, OK); await contact(c, 35945, 35945, "380673594003");
  await deal(c, 35947, "Програна", 8921932, 143, { key: "б3594", mgr: 2 }); await contact(c, 35947, 35947, CAR);
  await lardi(c, 35941, "lorry", CAR);
  await rebuild(c);
  const h = await handler("get", "/data-quality/carrier-phones");
  type Body = { counts: { clients: number }; dictionary: { phones: number }; items: { clientKey: string; verdict: string; teamId: number | null }[] };
  const admin = (await call(h, { auth: { userId: 1, role: "admin", roleKey: "admin", managerId: null, teamId: null }, query: {} })).body as Body;
  const mine = (k: string) => admin.items.find((x) => x.clientKey === k);
  assert.equal(mine("а3594")?.verdict, "no_phone", "🔴 клієнт екрана без жодного номера не потрапив у «Якість даних»");
  assert.equal(mine("б3594")?.verdict, "has_carrier", "🔴 клієнт із номером перевізника не потрапив у «Якість даних»");
  assert.equal(mine("в3594"), undefined, "🔴 клієнт лише з номером замовника потрапив у список — список став шпалерами");
  assert.ok(admin.dictionary.phones > 0, "довідник порожній у відповіді — екран казав би «ще не зібрано»");
  const lead = (await call(h, { auth: { userId: 2, role: "team_lead", roleKey: "team_lead", managerId: 1, teamId: 1 }, query: {} })).body as Body;
  assert.deepEqual(lead.items.filter((x) => x.clientKey.endsWith("3594")).map((x) => x.clientKey), ["а3594"],
    "🔴 тімлід команди 1 бачить клієнтів чужої команди (або не бачить своїх)");
  const denied = await call(h, { auth: { userId: 3, role: "manager", roleKey: "manager", managerId: 1, teamId: 1 }, query: {} });
  assert.equal(denied.code, 403, "🔴 менеджер бачить «Якість даних» — межа та сама, що в /data-quality");
});

/** Чистий модуль фронта (без імпортів) — виконуємо його, а не читаємо текст. */
async function groupsModule() {
  const ts = (await import("typescript")).default;
  const src = readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", "pages", "dashboard", "carrierPhoneGroups.ts"), "utf8");
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  type Item = { clientKey: string; managerId: number; teamId: number | null };
  return await import(`data:text/javascript,${encodeURIComponent(js)}`) as {
    NO_TEAM: string;
    groupCarrierItems: <T extends Item>(items: T[]) => { teamKey: string; teamName: string; total: number; managers: { managerId: number; items: T[] }[] }[];
  };
}

test("#3595 «ЯКІСТЬ ДАНИХ» · РОЗКЛАД: команда → менеджер → клієнти; кожен клієнт рівно раз; без команди — «Поза командами»; без номера замовника — першими", async () => {
  const { groupCarrierItems, NO_TEAM } = await groupsModule();
  const it = (k: string, mgr: number, team: number | null, verdict: "no_phone" | "only_carrier" | "has_carrier") =>
    ({ clientKey: k, clientName: k, managerId: mgr, managerName: `М${String(mgr)}`, teamId: team, teamName: team == null ? null : `Т${String(team)}`, verdict });
  const items = [it("а", 1, 1, "has_carrier"), it("б", 1, 1, "no_phone"), it("в", 2, 1, "only_carrier"), it("г", 3, null, "has_carrier")];
  const g = groupCarrierItems(items);
  const flat = g.flatMap((t) => t.managers.flatMap((m) => m.items.map((x) => x.clientKey)));
  assert.deepEqual([...flat].sort(), ["а", "б", "в", "г"], "🔴 клієнт загубився або роздвоївся в розкладі");
  assert.equal(g.reduce((s, t) => s + t.total, 0), items.length, "🔴 Σ команд ≠ числу клієнтів у шапці");
  assert.equal(g.find((t) => t.teamKey === "none")?.teamName, NO_TEAM, "🔴 клієнт без команди — порожня назва замість «Поза командами»");
  assert.deepEqual(g[0].managers.find((m) => m.managerId === 1)?.items.map((x) => x.clientKey), ["б", "а"],
    "🔴 «без номера замовника» не першим — найгірше ховається під «є номер перевізника»");
});

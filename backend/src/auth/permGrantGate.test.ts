import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateGrant, catalogGaps, PERMISSION_CATALOG } from "./permGrant.js";
import { viewDenied, ONE_ON_ONE_DENY } from "../oneOnOne/visibility.js";

/**
 * 🔒 #230–#230g — ПІДВИЩЕННЯ ПРИВІЛЕЇВ І МОВЧАЗНІ ДВЕРІ.
 *
 * Дірка заміряна 27.08.2026 і доведена читанням джерела: `validRolePayload`
 * пропускав права БЕЗ перевірки, а `PATCH /users/:id` приймає будь-який наявний
 * ключ ролі, у т.ч. самому собі (самозахист блокує лише пониження). Носій
 * `manage_users` міг видати собі `write_off_debt` — право, якого власник адміну
 * свідомо не давав.
 */

const SRC = (rel: string) => readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), "utf8");

test("#230 невідомий ключ права відхиляється", () => {
  const v = validateGrant({ view_balances: true, супер_право: true }, PERMISSION_CATALOG);
  assert.equal(v.ok, false, "🔴 сито пропустило ключ, якого немає в каталозі");
  if (v.ok) return;
  assert.equal(v.status, 400, "невідоме право — це зіпсоване тіло (400), а не відмова в доступі");
  assert.match(v.error, /супер_право/, "причина мусить НАЗВАТИ ключ, інакше її не полагодити");
});

test("#230b відоме право, якого актор НЕ має, видати не можна", () => {
  const v = validateGrant({ write_off_debt: true }, ["view_balances", "manage_users"]);
  assert.equal(v.ok, false, "🔴 актор видав право, якого не має сам — це і є самопідвищення");
  if (v.ok) return;
  assert.equal(v.status, 403, "право існує, але не в актора — це 403, не 400");
  assert.match(v.error, /write_off_debt/);
});

test("#230c ДЗЕРКАЛО: право, яке актор МАЄ, проходить — і зняття теж", () => {
  // Без цього дзеркала сито означало б «нічого не можна», а #230b був би зелений
  // на мертвій функції, що відмовляє завжди.
  const ok = validateGrant({ view_balances: true }, ["view_balances"]);
  assert.equal(ok.ok, true, "🔴 актор не може видати право, яке має сам — сито глухе");
  // Зняття дозволене навіть тому, хто права не має: сито стереже ПІДВИЩЕННЯ.
  const off = validateGrant({ write_off_debt: false }, ["manage_users"]);
  assert.equal(off.ok, true, "🔴 зняття чужого права заблоковано — сито ширше за задум");
  if (off.ok) assert.equal(off.perms.write_off_debt, false);
});

test("#230d каталог ПОКРИВАЄ всі ключі, що є в roles (напрямок: БД ⊆ каталог)", async (t) => {
  if (!process.env.DATABASE_URL) return t.skip("немає DATABASE_URL — перевірка проти живих ролей неможлива");
  const { pool } = await import("../db/pool.js");
  const rows = (await pool.query<{ permissions: Record<string, unknown> }>("SELECT permissions FROM roles")).rows;
  const keys = rows.flatMap((r) => Object.keys(r.permissions ?? {}));
  assert.ok(keys.length > 0, "🔴 у roles жодного права — перевіряти нема чого, це провал, а не успіх");
  assert.deepEqual(
    catalogGaps(keys), [],
    "🔴 у БД є право, якого немає в каталозі коду. Саме в цей бік: якби джерелом істини\n" +
    "   була БД, будь-який ключ у ній ставав би дозволеним автоматично — сито узаконювало б\n" +
    "   те, від чого захищає. Внести ключ у PERMISSION_CATALOG СВІДОМО або прибрати з ролей.",
  );
});

test("#230e гейт manage_users спрацьовує ДО сита — 403, а не 400", () => {
  const s = SRC("routes/settings.ts");
  for (const route of [/post\(\s*"\/roles"/, /put\(\s*"\/roles\/:key"/]) {
    const i = s.search(route);
    assert.ok(i > 0, `не знайшов роут ${route}`);
    const body = s.slice(i, i + 2200);
    const gate = body.indexOf("requireManageUsers");
    const sieve = body.indexOf("validateGrant");
    assert.ok(gate >= 0 && sieve > 0, "у роуті немає або гейта, або сита");
    assert.ok(gate < sieve,
      "🔴 сито стоїть ПЕРЕД гейтом manage_users: чужа роль дістане 400 замість 403,\n" +
      "   і гарантія «403 == спрацював гейт» зламається (на цьому вже відкочували прод 04.08).");
  }
});

test("#230f МІГРАЦІЯ ДВІЧІ: КВП і адмін дістають 1×1, фінансист — НІ", async (t) => {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const schema = readFileSync(fileURLToPath(new URL("../../src/db/schema.sql", import.meta.url)), "utf8");
  const client = new pg.Client({ connectionString: scratch.url });
  try {
    await client.connect();
    // 🔴 ДВІЧІ — і це весь сенс гейта. Синки ролей копіюють `permissions` адміна
    // ЦІЛКОМ, тож право, видане адміну, на ДРУГОМУ прогоні розтеклося б на
    // фінансиста. Один прогін цього не показує взагалі.
    await client.query(schema);
    await client.query(schema);
    const rows = (await client.query<{ key: string; permissions: Record<string, unknown> }>(
      "SELECT key, permissions FROM roles")).rows;
    const has = (k: string, p: string) => rows.find((r) => r.key === k)?.permissions?.[p] === true;
    assert.ok(rows.length >= 4, "🔴 у scratch-базі немає ролей — схема не засіялась, перевіряти нема чого");

    assert.ok(has("kvp", "view_all_1x1"), "🔴 КВП не дістав наскрізний перегляд — скарга власника не полагоджена");
    assert.ok(has("kvp", "edit_1x1_forms"), "🔴 КВП не дістав форми");
    assert.ok(has("admin", "view_all_1x1"), "🔴 адмін не дістав наскрізний перегляд");

    for (const k of ["financier", "team_lead", "manager"]) {
      assert.ok(!has(k, "view_all_1x1"),
        `🔴 «${k}» дістав view_all_1x1 на ДРУГОМУ прогоні міграції — право розтеклося через\n` +
        "   синк, що копіює набір адміна. Це та сама тиха видача, від якої стоїть рядок зняття.");
      assert.ok(!has(k, "edit_1x1_forms"), `🔴 «${k}» дістав edit_1x1_forms`);
    }
    // 🔴 Межа рішення власника: адміну відкрито ЛИШЕ перегляд.
    assert.ok(!has("admin", "edit_1x1_forms"), "🔴 адмін дістав форми — рішення відкрило лише перегляд");
    assert.ok(!has("admin", "write_off_debt"), "🔴 адмін дістав write_off_debt — межу власника порушено");

    for (const dead of ["approve_plans", "submit_plans", "manage_goals", "enter_manual_stats", "export"]) {
      assert.ok(rows.every((r) => r.permissions?.[dead] !== true), `🔴 мертве право «${dead}» лишилось у ролях`);
    }
  } finally {
    await client.end().catch(() => {});
    scratch.dispose();
  }
});

test("#230g порожньо ≠ відмова: три двері 1×1 відповідають словами", () => {
  // Чиста функція: відмовляємо лише тому, чия вибірка не може бути непорожньою.
  assert.equal(viewDenied(false, false), ONE_ON_ONE_DENY, "🔴 роль без права й без проведення дістає порожнечу замість відмови");
  assert.equal(viewDenied(true, false), null, "🔴 наскрізний перегляд заблоковано");
  assert.equal(viewDenied(false, true), null, "🔴 тімлід, що проводить тип A, втратив свої зустрічі");
  assert.match(ONE_ON_ONE_DENY, /view_all_1x1/, "текст мусить називати право, інакше людина не знає, що просити");

  // Джерело: усі ТРИ двері справді кличуть предикат. Межа слова обовʼязкова —
  // `viewDenied_OFF(...)` типова підміна, і підрядок її пропустив би.
  const s = SRC("routes/oneOnOnes.ts");
  const calls = [...s.matchAll(/\bviewDenied\b(?!\w)\s*\(/g)].length;
  assert.equal(calls, 3,
    `🔴 предикат кличеться ${calls} раз(и) замість 3. Двері: /meetings/:type/:managerId,\n` +
    "   /stats/scores, /enps. `/conduct-types` НАВМИСНО лишається 200 — це довідка,\n" +
    "   з якої фронт дізнається, що людині доступно.");
});

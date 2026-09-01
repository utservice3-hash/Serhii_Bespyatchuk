import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { needsApi, needsBackendEnv, API_BASE } from "../testMode.js";
import { ROUTE_BOUNDARY_EXEMPTIONS } from "../auth/gates.js";

/**
 * Tests #300-#308 — SSO into the time tracker.
 *
 * Numbers come from #300-#349, reserved up front: gate #223 sees collisions in one tree only,
 * so two branches written in parallel do not see each other until one reaches prod.
 *
 * Some checks read source as text. The frontend has no runner here, and the properties guarded
 * are structural — a key absent from a list, a handler not reading params. Same approach as
 * bundleApiBase.test.ts.
 */

/**
 * Роут `/tracker-assertion` мовчить 503 без налаштованого трекера, тож гейтам #311/#311b
 * потрібні НЕПОРОЖНІ значення. Ставимо лише те, чого немає: на прод-сервері `.env` уже
 * несе справжні, і перетирати їх не можна. Жодного мережевого виклику цей роут не робить.
 */
process.env.TRACKER_URL ||= "https://tracker.invalid";
process.env.TRACKER_SSO_KEY ||= "test-only-not-a-secret";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/** One handler's body, so a check cannot accidentally pass on a neighbour. */
function handlerBody(source: string, decl: string): string {
  const start = source.indexOf(decl);
  assert.ok(start >= 0, `не знайдено оголошення ${decl} — тест втратив предмет`);
  const rest = source.slice(start + decl.length);
  const next = rest.search(/\nauthRouter\.(get|post|put|delete|patch)\(/);
  return next === -1 ? rest : rest.slice(0, next);
}

// boundaries and access

test("#300 без токена адреса трекера не видається", needsApi(), async () => {
  const r = await fetch(`${API_BASE}/api/auth/tracker-sso`);
  assert.equal(r.status, 401,
    "ендпоінт віддає посилання, яке ВПУСКАЄ в трекер. Без requireAuth його міг би взяти будь-хто");
});

test("#301 усі три роути трекера названі в реєстрі меж", () => {
  // Gate #17 would fail the build anyway, but not on the reason. An entry without one is
  // "made it green", not a decision.
  for (const [method, p] of [
    ["GET", "/api/auth/tracker-sso"],
    ["POST", "/api/auth/tracker-assertion"],
    ["POST", "/api/auth/tracker-identity"],
  ] as const) {
    const found = ROUTE_BOUNDARY_EXEMPTIONS.find((e) => e.method === method && e.path === p);
    assert.ok(found, `${method} ${p} не названо в ROUTE_BOUNDARY_EXEMPTIONS`);
    assert.ok(found.why.trim().length > 40, `причина для ${p} надто коротка, щоб бути причиною`);
  }
});

// configuration

test("#302 адреса й ключ трекера беруться ЛИШЕ з оточення, без літерального дефолту", () => {
  const src = read("backend/src/config.ts");
  const block = src.slice(src.indexOf("tracker: {"), src.indexOf("ringostat: {"));

  assert.match(block, /process\.env\.TRACKER_URL \?\? ""/,
    "адреса мусить бути порожньою за замовчуванням — інакше збірка без налаштувань показувала б "
    + "кнопку, яка веде в нікуди");
  assert.match(block, /process\.env\.TRACKER_SSO_KEY \?\? ""/);
  assert.doesNotMatch(block, /required\(/,
    "required() тут завалив би СТАРТ дашборду, коли трекер ще не налаштовано");
  assert.doesNotMatch(block, /sslip|https:\/\/[^`"]*uts/,
    "у config.ts не має бути зашитої адреси трекера, а ключа — тим паче");
});

// response shape

test("#303 відповідь містить РІВНО ключ url", () => {
  const body = handlerBody(read("backend/src/routes/auth.ts"), 'authRouter.get("/tracker-sso"');

  assert.match(body, /res\.json\(\{ url: /, "успішна відповідь мусить віддавати саме url");
  assert.doesNotMatch(body, /res\.json\(\{\s*\.\.\./,
    "розпакування чужого тіла у відповідь — поле, що приїхало без рішення");
});

test("#304 ендпоінт НЕ читає параметрів запиту — інакше це відкритий редирект", () => {
  const body = handlerBody(read("backend/src/routes/auth.ts"), 'authRouter.get("/tracker-sso"');

  /**
   * 🔴 ПЕРША РЕДАКЦІЯ ЦЬОГО ГЕЙТА БУЛА ТВЕРДЖЕННЯМ ПРО ОРФОГРАФІЮ, А НЕ ГЕЙТОМ.
   * Вона забороняла підрядок `req.query` — і лишалась ЗЕЛЕНОЮ на робочому відкритому
   * редиректі, написаному як `const { query } = req` (заміряно саботажем 01.09.2026,
   * 10 pass / 0 fail). Ті самі ворота оминають `req.body`, `req.params`, `req.originalUrl`.
   *
   * Тому твердження тепер про ВЛАСТИВІСТЬ: із запиту обробник бере РІВНО `req.auth`
   * (кого впустили), і нічого більше. Мета переходу може прийти лише з конфігу.
   */
  const props = [...body.matchAll(/\breq\s*\.\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  const foreign = [...new Set(props)].filter((k) => k !== "auth").sort();
  // Твердження і текст — з ОДНОГО набору: інакше відмова назве сторонній ключ.
  assert.deepEqual(foreign, [],
    `обробник читає із запиту не лише auth: ${foreign.join(", ")} — мета переходу мусить залежати САМЕ від конфігу`);

  assert.doesNotMatch(body, /(?:const|let|var)\s*\{[^}]*\}\s*=\s*req\b/,
    "деструктуризація з `req` — той самий доступ до параметрів, лише іншими словами");
  assert.match(body, /config\.tracker\.url/, "адреса мусить будуватися з конфігу");
});

// nav

test("#305 пункт видно ролі з ПОРОЖНІМ screens — тобто всім", () => {
  const src = read("frontend/src/components/Layout.tsx");

  // In NAV_GROUPS this item would be filtered out for everyone: navGroupsForRole returns only
  // what a role's screen_access lists, and no role lists "tracker". Hence: after the filter.
  assert.match(src, /const navGroups = withTracker\(navGroupsForRole\(/,
    "пункт мусить вливатися після фільтра screens, інакше він невидимий для всіх");
  const fn = src.slice(src.indexOf("function withTracker"), src.indexOf("export function Layout"));
  assert.match(fn, /return \[\{ label: TRACKER_GROUP/,
    "якщо фільтр вичистив «Аналітику», групу треба створити — інакше кастомна роль втрачає кнопку");
});

test("#306 ключ tracker НЕ потрапив у NAV_GROUPS", () => {
  const src = read("frontend/src/components/Layout.tsx");
  const groups = src.slice(src.indexOf("export const NAV_GROUPS"), src.indexOf("export type NavKey"));

  // In NAV_GROUPS the key would also feed Ctrl+K and the URL validator, where no such screen
  // exists and the route renders blank — and the role editor would turn it into a gate.
  assert.doesNotMatch(groups, /"tracker"|key: "tracker"/,
    "tracker у NAV_GROUPS = порожній екран у Ctrl+K і рольовий перемикач у налаштуваннях");
});

test("#307 іконку для пункту описано", () => {
  const src = read("frontend/src/components/NavIcon.tsx");
  assert.match(src, /\n\s*tracker: </,
    "без запису в мапі пункт малюється нейтральним колом — «іконки не описано»");
});

// the browser hand-back page

test("#309 маршрут /tracker-auth оголошено ПЕРЕД /:section", () => {
  const src = read("frontend/src/App.tsx");
  const auth = src.indexOf('path="/tracker-auth"');
  const section = src.indexOf('path="/:section"');

  // /:section збігається з будь-яким одним сегментом, тож оголошений раніше він проковтнув би
  // /tracker-auth — і агент чекав би на порту відповідь, якої ніхто не надішле.
  assert.ok(auth > 0, "маршрут /tracker-auth зник");
  assert.ok(section > 0, "маршрут /:section зник — тест втратив предмет");
  assert.ok(auth < section, "/tracker-auth мусить бути раніше за /:section");
});

test("#310 адреса повернення будується з жорсткого хоста, а не з запиту", () => {
  const src = read("frontend/src/pages/TrackerAuth.tsx");

  // З запиту береться ЛИШЕ номер порту. Готова адреса в параметрі перетворила б сторінку на
  // відкритий редирект, яким будь-хто скерував би людину куди завгодно.
  assert.match(src, /new URL\(`http:\/\/127\.0\.0\.1:\$\{port\}\/callback`\)/,
    "хост мусить бути зашитий у код");
  assert.doesNotMatch(src, /params\.get\("(url|next|return|redirect)/,
    "адреса повернення не може приходити параметром");
});

// the one that matters most

test("#308 звичайний токен входу НЕ приймається як посвідчення для трекера", needsBackendEnv(), async () => {
  const { signToken } = await import("../auth/auth.js");
  const { signAssertion, verifyAssertion } = await import("../auth/trackerSso.js");

  // Without the purpose check an ordinary 12-hour dashboard token would pass, putting a
  // full-privilege credential into two more processes, one of them a laptop.
  const login = signToken({
    userId: 7, email: "hto@uts.ua", role: "admin", roleKey: "admin",
    managerId: null, teamId: null,
  });
  assert.equal(verifyAssertion(login), null,
    "токен входу прийнято як посвідчення — перевірки purpose немає або вона не працює");

  // Mirror: without it this would stay green if verifyAssertion rejected everything.
  assert.deepEqual(verifyAssertion(signAssertion(7, "hto@uts.ua")), { userId: 7, email: "hto@uts.ua" });
  assert.equal(verifyAssertion("не-токен"), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Правки власника 01.09.2026 (#311-#312). Причини — у коді, який вони стережуть.
// ─────────────────────────────────────────────────────────────────────────────

/** Виклик роутера БЕЗ сокета: мок-`req`/`res`, жодного сервера поруч із бойовою базою. */
async function callRouter(method: string, url: string, headers: Record<string, string>) {
  const express = (await import("express")).default;
  const { authRouter } = await import("./auth.js");
  const app = express();
  app.use("/api/auth", authRouter);
  return await new Promise<{ code: number; body: any }>((resolve) => {
    const res: any = {
      code: 200, body: undefined,
      status(c: number) { this.code = c; return this; },
      json(b: unknown) { this.body = b; resolve({ code: this.code, body: b }); return this; },
      end() { resolve({ code: this.code, body: this.body }); return this; },
      setHeader() { return this; }, getHeader() { return undefined; },
    };
    (app as any).handle({ method, url, originalUrl: url, headers, body: {} }, res, () =>
      resolve({ code: 404, body: undefined }));
  });
}

test("#311 посвідчення НЕ продовжує саме себе: /tracker-assertion його ВІДХИЛЯЄ", needsBackendEnv(), async () => {
  const { signAssertion } = await import("../auth/trackerSso.js");
  /**
   * 🔴 ЗАМІРЯНО ЖИВИМ ВИКЛИКОМ 01.09.2026, ДО ПРАВКИ: посвідчення підписане тим самим
   * JWT_SECRET, `verifyToken` призначення не дивиться, тож посвідчення проходило як Bearer,
   * і цей роут видавав за ним НОВЕ — три продовження поспіль дали HTTP 200. Двохвилинний
   * строк життя був декоративним: хто здобув одне, тримав його безстроково.
   */
  const r = await callRouter("POST", "/api/auth/tracker-assertion",
    { authorization: `Bearer ${signAssertion(7, "hto@uts.ua")}` });
  assert.equal(r.code, 403,
    `посвідчення прийнято (HTTP ${r.code}) — ланцюг «посвідчення → нове посвідчення» знову безкінечний`);
  assert.equal(r.body?.error, "assertion_not_accepted");
});

test("#311b 🪞 ДЗЕРКАЛО: справжній токен входу роут ПРИЙМАЄ — інакше правка обірвала б трекер", needsBackendEnv(), async () => {
  const { signToken } = await import("../auth/auth.js");
  const { verifyAssertion } = await import("../auth/trackerSso.js");
  /**
   * Односторонній предикат тут — найгірше з можливого: або пропустить дірку, або обірве
   * живу браузерну сесію, з якої агент забирає посвідчення. Тому обидва боки, поруч.
   */
  const login = signToken({
    userId: 7, email: "hto@uts.ua", role: "admin", roleKey: "admin",
    managerId: null, teamId: null,
  });
  const r = await callRouter("POST", "/api/auth/tracker-assertion", { authorization: `Bearer ${login}` });
  assert.equal(r.code, 200, `токен входу відхилено (HTTP ${r.code}) — це обірвало б вхід у трекер усім`);
  assert.deepEqual(verifyAssertion(r.body?.assertion ?? ""), { userId: 7, email: "hto@uts.ua" },
    "роут віддав щось, що не є нашим посвідченням");
});

/**
 * 🔴 ПОДІЛ НА ДВА, І ПРИЧИНА НЕ КОСМЕТИЧНА. Перша редакція тримала предикат і структурні
 * перевірки в одному тесті — а імпорт `trackerSso.js` тягне `config`, який кидає на
 * відсутньому `JWT_SECRET` ще НА ІМПОРТІ. У стенді (де біжить крок 0) `.env` немає, тож
 * цілий гейт там ПАДАВ — рівно та хвороба `#308`, яку цей же прохід і лікував. Тепер
 * структурна половина біжить усюди, а під щитом лише те, що справді потребує оточення.
 */
test("#312 трекер відкривають ЛИШЕ тим, кому ввімкнено — і в меню, і на сервері", () => {
  // Сервер: ховання у FE нічого не закриває, адресу можна попросити напряму.
  const body = handlerBody(read("backend/src/routes/auth.ts"), 'authRouter.get("/tracker-sso"');
  assert.match(body, /tracker_enabled/, "SELECT не бере ознаку — перевіряти нема з чого");
  assert.match(body, /trackerAllowed\(person\)[\s\S]{0,120}403/,
    "обробник не відмовляє 403 за ознакою — межа лишилась лише в меню");

  // Меню: пункт вливається за прапорцем із токена, а не всім підряд.
  const src = read("frontend/src/components/Layout.tsx");
  assert.match(src, /withTracker\(navGroupsForRole\(role, screens\), trackerEnabled\)/,
    "пункт додається без прапорця — кнопку знову побачать усі");
  assert.match(src, /if \(!enabled\) return groups;/,
    "withTracker не має раннього виходу — прапорець нічого не змінює");
});

test("#312b рішення «кому відкривати трекер» — обидва боки межі", needsBackendEnv(), async () => {
  const { trackerAllowed } = await import("../auth/trackerSso.js");
  assert.equal(trackerAllowed({ tracker_enabled: true }), true, "кому ввімкнено — мусить пускати");
  assert.equal(trackerAllowed({ tracker_enabled: false }), false,
    "кому НЕ вмикали — не пускати: до правки кнопку бачили всі 8 ролей, зокрема 10 таких людей");
  assert.equal(trackerAllowed(undefined), false, "невідомий рядок — не привід відкривати трекер");
});

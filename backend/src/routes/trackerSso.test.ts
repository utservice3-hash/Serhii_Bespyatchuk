import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { needsApi, API_BASE } from "../testMode.js";
import { ROUTE_BOUNDARY_EXEMPTIONS } from "../auth/gates.js";

/**
 * ТЕСТИ #300–#308 — ЄДИНИЙ ВХІД У ТРЕКЕР ЧАСУ.
 *
 * Трекер це окрема наша система з власним сервером. Дашборд для нього постачальник ОСОБИ, і
 * саме на цьому припущенні тримаються всі перевірки нижче.
 *
 * Номери взято з діапазону #300–#349, заброньованого наперед. Реєстр (гейт #223) бачить
 * зіткнення лише в ОДНОМУ дереві, тож дві гілки, які пишуться паралельно, одна одну не бачать
 * доти, доки одна не доїде на прод — і номер задвоюється тихо.
 *
 * Частина перевірок читає ВИХІДНИЙ КОД як текст. Це не лінощі: фронт тут не має власного
 * раннера, а властивості, які стережуться, — структурні («ключа немає в списку», «параметрів не
 * читаємо»). Той самий прийом уже вживається в `bundleApiBase.test.ts`.
 */

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/** Тіло обробника від його оголошення до наступного — щоб перевіряти саме його, а не сусідів. */
function handlerBody(source: string, decl: string): string {
  const start = source.indexOf(decl);
  assert.ok(start >= 0, `не знайдено оголошення ${decl} — тест втратив предмет`);
  const rest = source.slice(start + decl.length);
  const next = rest.search(/\nauthRouter\.(get|post|put|delete|patch)\(/);
  return next === -1 ? rest : rest.slice(0, next);
}

// ─────────────────────────────────────────────────────────── межі й доступ

test("#300 без токена адреса трекера не видається", needsApi(), async () => {
  const r = await fetch(`${API_BASE}/api/auth/tracker-sso`);
  assert.equal(r.status, 401,
    "ендпоінт віддає посилання, яке ВПУСКАЄ в трекер. Без requireAuth його міг би взяти будь-хто");
});

test("#301 усі три роути трекера названі в реєстрі меж", () => {
  // Гейт #17 однаково завалив би збірку, але з нього не видно ПРИЧИНИ. Тут перевіряється, що
  // причина написана — реєстр без причини це «зробив зелено», а не рішення.
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

// ─────────────────────────────────────────────────────────── конфігурація

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

// ─────────────────────────────────────────────────────────── форма відповіді

test("#303 відповідь містить РІВНО ключ url", () => {
  const body = handlerBody(read("backend/src/routes/auth.ts"), 'authRouter.get("/tracker-sso"');

  assert.match(body, /res\.json\(\{ url: /, "успішна відповідь мусить віддавати саме url");
  assert.doesNotMatch(body, /res\.json\(\{\s*\.\.\./,
    "розпакування чужого тіла у відповідь — поле, що приїхало без рішення");
});

test("#304 ендпоінт НЕ читає параметрів запиту — інакше це відкритий редирект", () => {
  const body = handlerBody(read("backend/src/routes/auth.ts"), 'authRouter.get("/tracker-sso"');

  // «Додати ?next=» — очевидне наступне прохання і єдиний спосіб це зламати: адреса, куди веде
  // кнопка, мусить будуватися лише з конфігу.
  assert.doesNotMatch(body, /req\.query/, "адреса переходу не може залежати від запиту");
  assert.match(body, /config\.tracker\.url/, "адреса мусить будуватися з конфігу");
});

// ─────────────────────────────────────────────────────────── меню

test("#305 пункт видно ролі з ПОРОЖНІМ screens — тобто всім", () => {
  const src = read("frontend/src/components/Layout.tsx");

  // Головний тест меню. Якби пункт лежав у NAV_GROUPS, `navGroupsForRole` при наявному screens
  // віддавав би лише те, що є в screen_access ролі — а ключа `tracker` там немає в жодної, отже
  // пункт не побачив би НІХТО. Саме тому він додається ПІСЛЯ фільтра.
  assert.match(src, /const navGroups = withTracker\(navGroupsForRole\(/,
    "пункт мусить вливатися після фільтра screens, інакше він невидимий для всіх");
  const fn = src.slice(src.indexOf("function withTracker"), src.indexOf("export function Layout"));
  assert.match(fn, /return \[\{ label: TRACKER_GROUP/,
    "якщо фільтр вичистив «Аналітику», групу треба створити — інакше кастомна роль втрачає кнопку");
});

test("#306 ключ tracker НЕ потрапив у NAV_GROUPS", () => {
  const src = read("frontend/src/components/Layout.tsx");
  const groups = src.slice(src.indexOf("export const NAV_GROUPS"), src.indexOf("export type NavKey"));

  // У NAV_GROUPS ключ живив би ще й Ctrl+K та валідацію адреси (Dashboard.tsx) — а екрана з такою
  // назвою не існує, тож перехід дав би порожню сторінку. Плюс редактор ролей зробив би з нього
  // рольовий перемикач, тобто знову гейт.
  assert.doesNotMatch(groups, /"tracker"|key: "tracker"/,
    "tracker у NAV_GROUPS = порожній екран у Ctrl+K і рольовий перемикач у налаштуваннях");
});

test("#307 іконку для пункту описано", () => {
  const src = read("frontend/src/components/NavIcon.tsx");
  assert.match(src, /\n\s*tracker: </,
    "без запису в мапі пункт малюється нейтральним колом — «іконки не описано»");
});

// ─────────────────────────────────────────────────────────── найважливіше

test("#308 звичайний токен входу НЕ приймається як посвідчення для трекера", async () => {
  const { signToken } = await import("../auth/auth.js");
  const { signAssertion, verifyAssertion } = await import("../auth/trackerSso.js");

  // 🔴 Без перевірки `purpose` сюди пройшов би звичайний 12-годинний токен дашборду — і
  // повнопривілейна обліковка опинилася б ще в двох процесах, зокрема на чужому ноутбуці.
  const login = signToken({
    userId: 7, email: "hto@uts.ua", role: "admin", roleKey: "admin",
    managerId: null, teamId: null,
  });
  assert.equal(verifyAssertion(login), null,
    "токен входу прийнято як посвідчення — перевірки purpose немає або вона не працює");

  // Дзеркало: без нього тест зеленів би й тоді, якби verifyAssertion відкидала геть усе.
  assert.deepEqual(verifyAssertion(signAssertion(7, "hto@uts.ua")), { userId: 7, email: "hto@uts.ua" });
  assert.equal(verifyAssertion("не-токен"), null);
});

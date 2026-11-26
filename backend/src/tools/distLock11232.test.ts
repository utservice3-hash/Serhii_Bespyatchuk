import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { needsApi, API_BASE } from "../testMode.js";

/**
 * 🔒 ЗБІРКА БЕКЕНДА НЕ РОЗДАЄТЬСЯ ВЕБОМ (задача 11232; зустріч по дашборду 25.11.2026: «прибрати номери телефонів з
 * відкритого доступу»).
 *
 * Заміряно 26.11.2026 з браузера БЕЗ входу: на проді веб-корінь = увесь git-чекаут, і nginx хостингу віддає файли зі
 * «статичним» розширенням напряму, повз Node і логін. `/backend/dist/index.js` (69 827 байт) і
 * `/backend/dist/core/missedCalls.test.js` (93 593 байт, у фікстурах — номери телефонів) приходили вмістом файла;
 * `.ts` / `.json` / `.md` / `.sql` ідуть у Node і дають сторінку входу. `.htaccess` на статику nginx не діє, а каталог
 * із правами 700 дає 403 (замір 24.11.2026). Тому права на `dist` ставить сама збірка — `dist` перестворюється кожним викатом.
 */
const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const DIST = path.join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const LOCK = path.join(ROOT, "backend/scripts/lockDist.mjs");
const perms = (p: string) => statSync(p).mode & 0o777;

/**
 * #11232 🪞 — КАТАЛОГ ЗБІРКИ ЗАКРИТИЙ ДЛЯ ВСІХ, КРІМ ВЛАСНИКА, І РОБИТЬ ЦЕ САМА ЗБІРКА. Чотири твердження:
 *   · збірка, з якої біжить цей тест, групі й решті недоступна (жодного біта з 077), а власник її читає;
 *   · `lockDist.mjs` на чужому корені з `dist` 755 робить 700, і файл усередині власник і далі читає (дзеркало: скрипт
 *     не ламає роботу сервера); без `dist` — код 1, а не мовчазний успіх;
 *   · `npm run build` кличе скрипт після копіювання ресурсів і до `version.json`; базу в кроці `test` — теж;
 *   · крок `deliver` закриває доставлений `dist` докрута ПІСЛЯ копіювання.
 * 🧨 Червоніє, якщо прибрати `lockDist` зі збірки, поставити в ньому права, що лишають читання решті (напр. 755), або
 * прибрати `chmod` з `deliver` / поставити його перед `cp`.
 */
test("#11232 🪞 ЗБІРКА — ЛИШЕ ВЛАСНИКУ: права ставить сама збірка і доставка в докрут; без dist — помилка, а не успіх", () => {
  assert.ok(existsSync(path.join(DIST, "index.js")), "🔴 предмет: тест біжить не зі збірки — перевіряти права нема на чому");
  assert.equal(perms(DIST) & 0o077, 0, `🔴 каталог збірки відкритий групі або решті (права ${perms(DIST).toString(8)}) — nginx віддасть *.js без логіна`);
  assert.ok(readFileSync(path.join(DIST, "index.js"), "utf8").length > 1000, "🔴 власник не читає власну збірку — сервер не стартує");

  const dir = mkdtempSync(path.join(tmpdir(), "uts-lock-"));
  try {
    mkdirSync(path.join(dir, "dist", "core"), { recursive: true });
    writeFileSync(path.join(dir, "dist", "core", "a.js"), "export const a = 1;\n");
    chmodSync(path.join(dir, "dist"), 0o755);
    assert.equal(perms(path.join(dir, "dist")), 0o755, "фікстура: каталог мусить стартувати відкритим");
    const r = spawnSync(process.execPath, [LOCK, dir], { encoding: "utf8" });
    assert.equal(r.status, 0, `🔴 lockDist впав на звичайному каталозі: ${r.stderr}`);
    assert.equal(perms(path.join(dir, "dist")), 0o700, "🔴 після lockDist каталог не 700");
    assert.equal(readFileSync(path.join(dir, "dist", "core", "a.js"), "utf8"), "export const a = 1;\n", "🔴 власник більше не читає файл збірки");
    const empty = mkdtempSync(path.join(tmpdir(), "uts-lock-empty-"));
    try {
      const e = spawnSync(process.execPath, [LOCK, empty], { encoding: "utf8" });
      assert.equal(e.status, 1, "🔴 без dist скрипт мусить впасти: «закрито» про каталог, якого немає, — успіх за 0 мс");
    } finally { rmSync(empty, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }

  const build = (JSON.parse(read("backend/package.json")) as { scripts: Record<string, string> }).scripts.build;
  assert.match(build, /node scripts\/copyAssets\.mjs && node scripts\/lockDist\.mjs && node scripts\/writeVersion\.mjs/, "🔴 збірка не закриває dist (або робить це не після копіювання ресурсів)");

  const deploy = read("backend/src/tools/deploy.ts");
  const baseAt = deploy.indexOf("const beBase = `${base}/backend`;");
  assert.ok(baseAt > 0, "🔴 збірку бази в кроці test не знайдено");
  assert.match(deploy.slice(baseAt, deploy.indexOf("const runTests", baseAt)), /sh\("node", \[`\$\{c\.be\}\/scripts\/lockDist\.mjs`, beBase\], c\.be\);/, "🔴 база в кроці test лишається відкритою");
  const at = deploy.indexOf('deliver: (c) => run("deliver"');
  assert.ok(at > 0, "🔴 крок deliver не знайдено");
  const body = deploy.slice(at, deploy.indexOf("distNotEmpty:", at)).replace(/\/\/.*$/gm, "");
  const cp = body.indexOf('sh("cp", ["-r", c.be + "/dist", c.prodBe + "/dist"]);');
  const lock = body.indexOf('sh("chmod", ["700", c.prodBe + "/dist"]);');
  assert.ok(cp > 0, "🔴 deliver більше не копіює dist стенда в докрут — порядок звіряти нема з чим");
  assert.ok(lock > cp, "🔴 deliver не закриває доставлений dist після копіювання — докрут роздає збірку без логіна");
});

/**
 * #11232b (прод) — ЗОВНІ ФАЙЛИ ЗБІРКИ НЕ ПРИХОДЯТЬ ВМІСТОМ, А САЙТ ЖИВИЙ. Ходить на ту саму адресу, що й приймання
 * (`API_BASE`; у ланцюгу викату це публічний `https://dashboard.uts.ua`, тобто через nginx).
 *   · `/backend/dist/index.js` і `/backend/dist/core/missedCalls.test.js`: або не 200, або сторінка застосунку (HTML);
 *   · 🪞 `/api/health` — 200 і `/` — HTML: «закрито» не досягнуто тим, що лежить увесь сайт.
 * ⚠️ На локальній адресі (127.0.0.1) запит іде в Node повз nginx, і твердження там тривіальне — про це гейт каже
 * діагностикою; доказова сила лише через публічну адресу. До викату цієї правки гейт на проді ЧЕРВОНИЙ — це і є замір 26.11.
 * 🧨 Червоніє, якщо `dist` докрута знову читається рештою (права 755) — nginx віддасть файл; або якщо закрили так, що
 * перестав відповідати сам сервер.
 */
test("#11232b (прод) файли збірки бекенда зовні не віддаються вмістом; сам сайт і /api/health живі", needsApi(), async (t) => {
  if (/\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(API_BASE)) t.diagnostic(`API_BASE=${API_BASE} — повз nginx; доказ лише через публічну адресу`);
  const get = async (p: string) => { const r = await fetch(`${API_BASE}${p}`, { redirect: "manual" }); return { status: r.status, body: await r.text() }; };
  const isHtml = (b: string) => /^\s*<!doctype html/i.test(b);
  const health = await get("/api/health");
  assert.equal(health.status, 200, "🔴 /api/health не 200 — сервер не відповідає, «файли закриті» нічого б не довело");
  const home = await get("/");
  assert.ok(home.status === 200 && isHtml(home.body), "🔴 головна не віддає застосунок — закрили більше, ніж треба");
  for (const p of ["/backend/dist/index.js", "/backend/dist/core/missedCalls.test.js"]) {
    assert.ok(existsSync(path.join(DIST, p.replace("/backend/dist/", ""))), `🔴 предмет: ${p} немає в збірці — перевірка адреси нічого б не довела`);
    const r = await get(p);
    assert.ok(r.status !== 200 || isHtml(r.body), `🔴 ${p} приходить без логіна вмістом файла (${r.body.length} симв.) — каталог збірки відкритий вебу`);
  }
});

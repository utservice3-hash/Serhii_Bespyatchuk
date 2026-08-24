import test from "node:test";
import assert from "node:assert/strict";
import { needsApi } from "../testMode.js";

const BASE = process.env.API_BASE ?? "";

/**
 * 🖱 ГЕЙТИ ПРО ТЕ, ЩО КОРИСТУВАЧ РЕАЛЬНО МОЖЕ ЗРОБИТИ (24.08.2026)
 *
 * Привід: власник на живому екрані натиснув кнопки — і нічого. А приймання Е3
 * було зелене й показувало «робочий клік-цикл». Розбір показав, що воно
 * перевіряло НЕ ТЕ:
 *
 *   1. «Клік» у прийманні був `element.click()` з `page.evaluate` — синтетичний
 *      виклик ПРЯМО на елементі. Він спрацьовує, навіть якщо елемент перекритий
 *      оверлеєм, має `pointer-events: none`, нульовий розмір або лежить за межами
 *      екрана. Тобто доведено було «обробник працює», а не «людина дотягнеться».
 *   2. Клік-цикл «зміна відповідального → перечитування» робився `curl`-ом.
 *      Браузера в тій перевірці не було взагалі.
 *
 * ⚠️ Обидві підміни я зробив, ідучи за правильною порадою «не використовуй
 * force-клік, бо він влучає в те, що зверху». Порада закрила одну діру й
 * відкрила іншу — і цього я не помітив і не сказав.
 */

test("#191 зниклий асет дає 404, а не index.html із кодом 200", needsApi(), async () => {
  // 🔴 МЕХАНІЗМ, ЩО ПОЯСНЮЄ «КНОПКИ НЕ НАТИСКАЮТЬСЯ» БЕЗ ЖОДНОЇ ПОМИЛКИ В КОДІ.
  //
  // SPA-фолбек віддавав `index.html` на будь-який шлях поза `/api`. Крок деплою
  // «прибрати старий бандл» разом із ним означав: браузер із закешованим старим
  // `index.html` просить видалений `/assets/index-СТАРИЙ.js` і отримує HTML із
  // кодом 200. Далі `Unexpected token '<'` — і сторінка стоїть намальована, але
  // без жодного обробника.
  //
  // Заміряно на живому проді 24.08.2026 ДО фікса: `200 text/html`.
  const r = await fetch(`${BASE}/assets/zzz-such-bundle-never-existed.js`);
  assert.equal(r.status, 404,
    `🔴 зниклий асет віддав ${r.status} — SPA-фолбек знову ковтає відсутні бандли, `
    + "і видалення старої збірки тихо ламає вкладки з кешем");
  const ct = r.headers.get("content-type") ?? "";
  assert.ok(!ct.includes("text/html"),
    `🔴 content-type «${ct}» — браузер спробує виконати HTML як JS`);

  // 🪞 ДЗЕРКАЛО: справжній асет ПРАЦЮЄ. Без цього гейт зеленів би й тоді, коли
  // ми зламали віддачу статики зовсім — «усе 404» виглядало б як надійність.
  const html = await (await fetch(`${BASE}/`)).text();
  const real = html.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/)?.[1];
  assert.ok(real, "🔴 в index.html немає посилання на бандл — перевіряти нічого");
  const ok = await fetch(`${BASE}/assets/${real}`);
  assert.equal(ok.status, 200, `🔴 живий бандл ${real} віддає ${ok.status} — сайт зламаний`);
  assert.ok((ok.headers.get("content-type") ?? "").includes("javascript"),
    "🔴 живий бандл віддається не як JS");
});

test("#192 SPA-фолбек лишається для МАРШРУТІВ, і це не той самий випадок", needsApi(), async () => {
  // Дзеркало до `#191`: фікс мав прибити фолбек ЛИШЕ під `/assets`. Якщо він
  // зачепив і маршрути, то глибокі посилання (`/receivables`, `/report`) почнуть
  // давати 404 — тобто «полагодивши» тихий баг, ми зробили гучний.
  const r = await fetch(`${BASE}/receivables`);
  assert.equal(r.status, 200, "🔴 маршрут SPA віддає не 200 — фікс зачепив зайве");
  assert.ok((r.headers.get("content-type") ?? "").includes("text/html"),
    "🔴 маршрут SPA більше не віддає HTML");
});

/**
 * 🖱 #193 — КЛІК СПРАВЖНЬОЮ МИШЕЮ, з hit-testing.
 *
 * 🔴 ЧЕСНА МЕЖА, ЯКУ ТРЕБА ЗНАТИ, А НЕ ВДАВАТИ ПОКРИТТЯ (вимога власника
 * 24.08.2026). Цей гейт потребує БРАУЗЕРА. На прод-сервері його немає — ані
 * chromium, ані playwright, і ставити його туди означало б тягнути ~400 МБ на
 * бойову машину заради тесту. Тому:
 *
 *   · у середовищі, де браузер Є (контейнер асистента, машина розробника) —
 *     гейт виконується і клікає МИШЕЮ;
 *   · на проді — чесно ПРОПУСКАЄТЬСЯ з названою причиною.
 *
 * Пропуск тут — не формальність: саме він означає, що «клік у браузері» на
 * проді НЕ покритий, і це треба читати як межу, а не як зелене.
 *
 * ⚠️ Чому саме `page.click()`, а не `element.click()`: перший робить hit-testing
 * (чи видно, чи не перекрито, чи приймає події), другий викликає обробник
 * навпростець. Уся різниця між «працює» і «людина може цим скористатись».
 */
test("#193 клік МИШЕЮ: контроли реагують, ПВК АРСЕНАЛ розгортається", needsApi(), async (t) => {
  // ⚠️ Специфікатор У ЗМІННІЙ — навмисно. `playwright` не є залежністю бекенду
  // (і не має нею ставати: ~400 МБ на бойову машину заради тесту), тож прямий
  // `import("playwright")` не пройшов би `tsc` у жодному середовищі. Змінна
  // лишає розвʼязання на рантайм, де воно й має вирішуватись.
  // Шлях можна задати явно: у контейнері асистента playwright лежить поза
  // `node_modules` бекенду (ставити його туди означало б тягнути браузер у
  // залежності бойового сервера). `PLAYWRIGHT_MODULE` — саме для цього випадку.
  const SPEC = process.env.PLAYWRIGHT_MODULE ?? "playwright";
  let chromium: { launch: (o?: unknown) => Promise<any> };
  try {
    ({ chromium } = (await import(SPEC)) as { chromium: { launch: (o?: unknown) => Promise<any> } });
  } catch {
    return t.skip("playwright недоступний у цьому середовищі — клік мишею НЕ перевірено "
      + "(на прод-сервері браузера немає; це межа покриття, а не зелений результат)");
  }
  const token = process.env.TEST_BEARER;
  if (!token) {
    return t.skip("немає TEST_BEARER — клік мишею НЕ перевірено (потрібен короткоживучий токен)");
  }

  // Шлях до бінаря — теж явний. У контейнері асистента chromium лежить у
  // /opt/pw-browsers (PLAYWRIGHT_BROWSERS_PATH), і без цього launch мовчки падає,
  // а гейт «пропускається» — тобто мовчазний пропуск замість перевірки.
  const exe = process.env.PLAYWRIGHT_CHROMIUM;
  const browser = await chromium.launch(exe ? { executablePath: exe } : undefined)
    .catch((e: unknown) => { console.log("   playwright launch:", String(e).slice(0, 140)); return null; });
  if (!browser) return t.skip("браузер не стартував — клік мишею НЕ перевірено");
  try {
    const ctx = await browser.newContext({ viewport: { width: 1700, height: 1100 } });

    // 🔌 API-виклики виконуємо в NODE, а не в браузері.
    //
    // Зібраний фронт б'є в АБСОЛЮТНИЙ origin (`VITE_API_URL`), і в закритих
    // середовищах — зокрема в контейнері асистента — chromium не має виходу
    // назовні ВЗАГАЛІ, хоч `fetch` у node працює. Без перехоплення сторінка
    // вічно стоїть на «Завантаження…», а гейт падає по таймауту, і причина
    // виглядає як «розкриття зламане», хоч зламана мережа.
    //
    // ⚠️ Підміняється лише ТРАНСПОРТ. Відповіді — бойові, з того самого API,
    // до якого ходить решта `test:prod`.
    await ctx.route("**/api/**", async (route: any) => {
      const rq = route.request();
      const url: string = rq.url();
      const target = url.includes("/api/") ? BASE + url.slice(url.indexOf("/api/")) : url;
      try {
        const r = await fetch(target, {
          method: rq.method(),
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: ["GET", "HEAD"].includes(rq.method()) ? undefined : rq.postData() ?? undefined,
        });
        await route.fulfill({
          status: r.status, body: Buffer.from(await r.arrayBuffer()),
          headers: { "content-type": r.headers.get("content-type") ?? "application/json" },
        });
      } catch { await route.fulfill({ status: 502, body: "{}" }); }
    });

    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e: unknown) => errors.push(String(e).slice(0, 200)));

    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page.evaluate((tk: string) => localStorage.setItem("token", tk), token);
    await page.goto(`${BASE}/receivables`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("text=Боржники", { timeout: 45_000 });
    await page.waitForTimeout(1500);

    // (1) Олівець «змінити» — клік МИШЕЮ, з перевіркою, що поповер справді відкрився.
    const pencil = page.locator("button", { hasText: "змінити" }).first();
    await pencil.scrollIntoViewIfNeeded();
    await pencil.click({ timeout: 8000 });
    await page.waitForTimeout(700);
    assert.ok(await page.locator("text=Відповідальний за борг").count() > 0,
      "🔴 клік мишею по «змінити» не відкрив контрол — саме це бачив власник");
    // ⌨️ І ЗАКРИВАЄТЬСЯ ESC. Поки цього не було, підкладка відкритого діалога
    // накривала таблицю, і наступний клік по клієнту «не проходив» — тобто
    // відсутність Esc читалась як зламане розкриття.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    assert.equal(await page.locator("text=Відповідальний за борг").count(), 0,
      "🔴 Esc не закрив контрол — модалку можна покинути лише кнопкою");

    // (2) Склейка.
    const merge = page.locator("button", { hasText: "Обʼєднати клієнтів" }).first();
    await merge.click({ timeout: 8000 });
    await page.waitForTimeout(700);
    assert.ok(await page.locator("text=Зникне як окремий рядок").count() > 0,
      "🔴 клік мишею по «Обʼєднати клієнтів» не відкрив діалог");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    assert.equal(await page.locator("text=Зникне як окремий рядок").count(), 0,
      "🔴 Esc не закрив діалог склейки — його підкладка блокуватиме весь екран");

    // (3) 🔴 САМЕ ПВК АРСЕНАЛ, а не «якийсь клієнт». Він єдиний ЗМІШАНИЙ:
    // 11 рахунків із 40 через 1С, битий лінк на угоду, воронка поза мапою етапів.
    // Якщо розкриття колись зламається на даних, зламається саме тут.
    const pvk = page.locator("button", { hasText: "ПВК АРСЕНАЛ" }).first();
    await pvk.scrollIntoViewIfNeeded();
    await pvk.click({ timeout: 8000 });
    await page.waitForTimeout(2500);
    assert.ok(await page.locator("text=Разом:").count() > 0,
      "🔴 ПВК АРСЕНАЛ не розгорнувся — деталізації рахунків немає");
    // 🪞 І з ДАНИМИ, а не порожня: «Разом: 0 рах.» виглядало б так само зелено.
    const detail = await page.locator("table").first().innerText();
    assert.match(detail, /Рахунок №/, "🔴 розкриття без шапки рахунків");
    assert.ok(/\d{6}/.test(detail), "🔴 у розкритті немає жодного номера рахунку — воно порожнє");

    // (4) 🔴 ВУЗЬКИЙ ЕКРАН — ОКРЕМИЙ ВИПАДОК, І САМЕ ВІН БУВ ЗЛАМАНИЙ.
    //
    // На 430px `.app-shell` стає колонкою, а сайдбар — горизонтальною смугою.
    // Але `height: 100vh` і `position: sticky` з базового правила не скидались,
    // тож смуга розтягувалась на ВЕСЬ екран і накривала таблицю: клік по клієнту
    // фізично не долітав, його зʼїдав сайдбар.
    //
    // ⚠️ Перевіряємо HIT-TESTING-ом, а не «кнопка є в DOM»: у DOM вона була
    // весь час, і `element.click()` спрацьовував. Різниця між «обробник живий»
    // і «людина може натиснути» — рівно тут.
    const narrow = await ctx.newPage();
    await narrow.setViewportSize({ width: 430, height: 900 });
    await narrow.goto(`${BASE}/receivables`, { waitUntil: "domcontentloaded" });
    await narrow.waitForSelector("text=Боржники", { timeout: 45_000 });
    await narrow.waitForTimeout(2000);
    const nb = narrow.locator("button", { hasText: "ПВК АРСЕНАЛ" }).first();
    await nb.evaluate((el: any) => el.scrollIntoView({ block: "center", behavior: "instant" }));
    await narrow.waitForTimeout(600);
    const box = await nb.boundingBox();
    assert.ok(box, "🔴 на вузькому екрані кнопки клієнта немає взагалі");
    const topEl = await narrow.evaluate(([x, y]: [number, number]) => {
      const el = document.elementFromPoint(x, y);
      return el ? `${el.tagName}.${String((el as HTMLElement).className || "").slice(0, 24)}` : "нічого";
    }, [box!.x + box!.width / 2, box!.y + box!.height / 2]);
    assert.ok(!/sidebar/i.test(topEl),
      `🔴 у точці кнопки лежить «${topEl}» — сайдбар знову накриває таблицю на вузькому екрані`);
    await nb.click({ timeout: 8000 });
    await narrow.waitForTimeout(2500);
    assert.ok(await narrow.locator("text=Разом:").count() > 0,
      "🔴 на вузькому екрані клієнт не розгортається");
    await narrow.close();

    assert.deepEqual(errors, [], `🔴 JS-помилки на сторінці: ${errors.slice(0, 3).join(" · ")}`);
  } finally {
    await browser.close();
  }
});

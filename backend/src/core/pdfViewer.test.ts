import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 📄 ПЕРЕГЛЯДАЧ PDF ЯК У SEREDA (24.09.2026) — гейти `#722`–`#724`.
 * Рішення Романа: «точна копія середи, прям такий самий перегляд пдф». Усі числа нижче — ЗАМІР
 * живого переглядача Sereda (урок «Welcome to UTS», 17 сторінок), а не наш смак.
 */
const FE = fileURLToPath(new URL("../../../frontend/", import.meta.url).href.replace("/backend/dist/", "/backend/src/"));
const VIEWER = `${FE}src/pages/dashboard/sections/PdfViewer.tsx`;

/** Чиста математика ВИКОНУЄТЬСЯ, а не читається: транспіляція файла без імпортів, як у сусідніх гейтах. */
async function math() {
  const ts = (await import("typescript")).default;
  const src = readFileSync(`${FE}src/pages/dashboard/pdfViewerMath.ts`, "utf8");
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return await import(`data:text/javascript,${encodeURIComponent(js)}`);
}

/**
 * #722 — МАСШТАБ СХОДИНКАМИ SEREDA, ДО ЦИФРИ, В ОБИДВА БОКИ. Перша редакція («×1.25 / ÷1.25») давала
 * вниз 79 і 63 замість 78 і 62 — тобто формула була «схожа», а ряд — ні. Тримаємо РЯДИ, а не формулу.
 * Плюс незалежна перевірка: спуск до 50% і чотири «+» дають 124% — рівно те число, на якому зупинилась
 * сама Sereda, коли масштаб повертали назад (заміряно тим самим проходом, під нього правило не підбиралось).
 * 🧨 Червоніє, якщо змінити крок, межі, округлення або дати кнопці працювати на межі.
 */
test("#722 ПЕРЕГЛЯДАЧ PDF: масштаб сходинками Sereda — 50…300%, до цифри в обидва боки", async () => {
  const m = await math();
  const walk = (from: number, fn: (z: number) => number, n: number) => {
    const out: string[] = []; let z = from;
    for (let i = 0; i < n; i++) { z = fn(z); out.push(m.zoomLabel(z)); }
    return { out, z };
  };
  const up = walk(1, m.zoomIn, 6);
  assert.deepEqual(up.out, ["125%", "156%", "195%", "244%", "300%", "300%"], "🔴 ряд «+» розійшовся з Sereda");
  const down = walk(3, m.zoomOut, 10);
  assert.deepEqual(down.out, ["240%", "192%", "154%", "123%", "98%", "78%", "62%", "50%", "50%", "50%"], "🔴 ряд «−» розійшовся з Sereda");
  assert.equal(walk(down.z, m.zoomIn, 4).out.at(-1), "124%", "🔴 повернення від 50% не дає 124%, як у Sereda");

  // Межі — по обидва боки кожної (правило 11): на межі кнопка гасне, за крок до неї — ні.
  assert.equal(m.canZoomIn(3), false, "🔴 «+» працює на 300%");
  assert.equal(m.canZoomIn(2.44), true, "🔴 «+» згасла до межі");
  assert.equal(m.canZoomOut(0.5), false, "🔴 «−» працює на 50%");
  assert.equal(m.canZoomOut(0.62), true, "🔴 «−» згасла до межі");
  assert.equal(m.zoomOut(0.5), 0.5, "🔴 масштаб опустився нижче 50%");
  assert.equal(m.zoomIn(3), 3, "🔴 масштаб піднявся вище 300%");
  assert.equal(m.zoomLabel(1), "100%");
});

/**
 * #722b — ЛІЧИЛЬНИК «N / M» ІДЕ ЗА ПРОКРУТКОЮ. Поточна сторінка — та, на яку припадає середина вікна.
 * Стик двох сторінок перевірено з обох боків на один піксель, інакше тест доводив би лише, що функція
 * щось повертає.
 * 🧨 Червоніє, якщо рахувати від верху вікна замість середини, зсунути межу або віддати 0 на порожньому.
 */
test("#722b ПЕРЕГЛЯДАЧ PDF: лічильник сторінки — за серединою вікна, стик з обох боків", async () => {
  const m = await math();
  const tops = [0, 400, 800];
  assert.equal(m.pageAtScroll(tops, 0, 400), 1);
  assert.equal(m.pageAtScroll(tops, 199, 400), 1, "🔴 сторінка перемкнулась раніше, ніж нова зайняла середину вікна");
  assert.equal(m.pageAtScroll(tops, 200, 400), 2, "🔴 сторінка не перемкнулась, коли нова дійшла до середини вікна");
  assert.equal(m.pageAtScroll(tops, 99999, 400), 3, "🔴 за кінцем документа лічильник не показує останню");
  assert.equal(m.pageAtScroll([], 0, 400), 1, "🔴 порожній документ дає не 1 — на панелі було б «0 / 0»");
});

/**
 * #723 — УСІ ЕКРАНИ НАВЧАННЯ ПОКАЗУЮТЬ PDF ЧЕРЕЗ `PdfViewer`, жоден — вікном браузера. Перелік екранів
 * береться ВІД ПРЕДМЕТА (правило 12): кожен файл, що тягне файл навчання (`fetchTrainingFileBlobUrl`), —
 * а не від здогаду про назви. І порожній перелік — провал, а не зелене.
 * 🧨 Червоніє, якщо будь-який такий екран поверне `<iframe>` для pdf або з'явиться новий екран без переглядача.
 */
test("#723 ПЕРЕГЛЯДАЧ PDF: кожен екран навчання з pdf — через PdfViewer, без вікна браузера", () => {
  const screens: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".tsx") && /\bfetchTrainingFileBlobUrl\b/.test(readFileSync(p, "utf8"))) screens.push(p);
    }
  };
  walk(`${FE}src`);
  assert.ok(screens.length >= 3, `🔴 екранів із файлами навчання знайдено ${screens.length} — перевірці нема що перевіряти`);
  for (const p of screens) {
    const src = readFileSync(p, "utf8");
    const name = p.slice(FE.length);
    if (!/application\/pdf/.test(src)) continue;
    assert.match(src, /<PdfViewer src=\{/, `🔴 ${name} показує pdf не через PdfViewer`);
    assert.ok(!/<iframe src=\{(blob|blobUrl|fileUrl)\}/.test(src), `🔴 ${name} знову відкриває файл навчання вікном браузера`);
  }
});

/**
 * #723b — У ПЕРЕГЛЯДАЧІ НЕМАЄ ТОГО, ЧОГО НЕМАЄ В SEREDA: завантаження, друку, шару тексту. На панелі —
 * рівно дві кнопки (масштаб). ⚠️ Це відтворення вигляду, а НЕ захист: файл однаково приходить у браузер.
 * 🧨 Червоніє, якщо додати в переглядач завантаження, друк, виділення тексту чи третю кнопку.
 */
test("#723b ПЕРЕГЛЯДАЧ PDF: без завантаження, друку й шару тексту — як у Sereda", () => {
  const src = readFileSync(VIEWER, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  for (const bad of [/\bdownload\b/i, /\.print\(/, /TextLayer|textLayer|renderTextLayer/, /AnnotationLayer|annotationLayer/, /requestFullscreen/])
    assert.ok(!bad.test(src), `🔴 у переглядачі з'явилось те, чого немає в Sereda: ${bad}`);
  assert.equal((src.match(/<button\b/g) ?? []).length, 2, "🔴 на панелі не рівно дві кнопки (−, +)");
  assert.match(src, /p\.render\(\{ canvas: c, viewport: vp/, "🔴 сторінка малюється не на полотні");
});

/** Сценарії збірки, яким тут не місце: усе `.js`/`.mjs`, крім ОДНОГО основного бандлу і ОДНОГО воркера pdf. */
export function strayScripts(files: string[]): string[] {
  const scripts = files.filter((f) => /\.(m?js)$/.test(f));
  const main = scripts.filter((f) => /^index-[^.]+\.js$/.test(f));
  const worker = scripts.filter((f) => /^pdf\.worker\.min-[^.]+\.mjs$/.test(f));
  const stray = scripts.filter((f) => !main.includes(f) && !worker.includes(f));
  return [...stray, ...main.slice(1), ...worker.slice(1)];
}

/**
 * #724 — ВОРКЕР PDF — ЄДИНИЙ ДОЗВОЛЕНИЙ ДОДАТКОВИЙ СЦЕНАРІЙ ЗБІРКИ, НАЗВАНИЙ ПОІМЕННО. Заміряно: `#225`
 * рахує лише `.js`, тож воркер (`.mjs`) проходив би КРІЗЬ ДІРКУ — і так само пройшов би будь-який інший
 * `.mjs`-чанк, тобто саме той 404 після викату, від якого `#225` стереже. Цей гейт закриває дірку: воркер
 * дозволено явно, решту — ні. Воркер `cssGuard` не зносить (той прибирає лише `index-*`), а сервер віддає
 * `.mjs` як `application/javascript` — заміряно пробою на проді 24.09.
 * 🧨 Червоніє, якщо в збірці зʼявиться другий бандл, другий воркер або будь-який інший `.mjs`.
 */
test("#724 ЗБІРКА: окрім одного бандлу — лише один воркер pdf, будь-який інший сценарій червоніє", () => {
  // Предикат — на власних входах, по обидва боки.
  assert.deepEqual(strayScripts(["index-A.js", "index-B.css", "pdf.worker.min-C.mjs", "logo-D.jpg"]), [], "🔴 законна збірка названа зайвою");
  assert.deepEqual(strayScripts(["index-A.js", "vendor-E.mjs"]), ["vendor-E.mjs"], "🔴 чужий .mjs пройшов — рівно дірка #225");
  assert.deepEqual(strayScripts(["index-A.js", "index-F.js"]), ["index-F.js"], "🔴 другий бандл пройшов");
  assert.deepEqual(strayScripts(["index-A.js", "pdf.worker.min-C.mjs", "pdf.worker.min-G.mjs"]), ["pdf.worker.min-G.mjs"], "🔴 другий воркер пройшов");

  // Реальна збірка, якщо вона є. Її відсутність не робить тест порожнім: предикат вище виконався.
  const dir = `${FE}dist/assets`;
  if (!existsSync(dir)) return;
  const files = readdirSync(dir);
  assert.deepEqual(strayScripts(files), [], `🔴 у збірці зайві сценарії: ${strayScripts(files).join(", ")}`);
  assert.ok(files.some((f) => /^pdf\.worker\.min-[^.]+\.mjs$/.test(f)), "🔴 у збірці немає воркера pdf — переглядач не відкриє жодного документа");
});

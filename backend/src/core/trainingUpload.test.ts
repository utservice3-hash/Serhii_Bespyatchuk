import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkUpload, MAX_UPLOAD_BYTES, ALLOWED_UPLOAD, ACCEPT_ATTR } from "./trainingUpload.js";

const fe = (p: string) => readFileSync(fileURLToPath(new URL(`../../../frontend/src/${p}`, import.meta.url)), "utf8");
const ROUTE = fileURLToPath(new URL("../../src/routes/training.ts", import.meta.url));

/**
 * 📎 ЗАВАНТАЖЕННЯ В НАВЧАННЯ (23.09.2026) — гейти `#710`–`#712`.
 * Привід: «має бути можливість додавати фото та відео». Сервер файл приймав завжди, але типу
 * не перевіряв НІХТО, а додати крок можна було лише кружним шляхом через «Бібліотеку».
 */

/**
 * #710 — БІЛИЙ СПИСОК І МЕЖА, ПО ОБИДВА БОКИ. Фото й відео проходять (те, заради чого прохід),
 * виконуване й inline-небезпечне — ні. Межа перевіряється РІВНО на ній і на крок далі: фікстура
 * з одного значення доводила б лише те, що функція щось повертає (правило 11).
 * 🧨 Червоніє, якщо прибрати перевірку типу, пустити svg/exe або зняти стелю розміру.
 */
test("#710 ЗАВАНТАЖЕННЯ: фото й відео можна, виконуване й svg — ні, межа розміру тримає", () => {
  // ✅ те, заради чого робився прохід
  assert.equal(checkUpload("image/png", 1024).ok, true, "🔴 фото не приймається");
  assert.equal(checkUpload("image/jpeg", 1024).ok, true);
  assert.equal(checkUpload("video/mp4", 1024).ok, true, "🔴 відео не приймається");
  assert.equal(checkUpload("video/quicktime", 1024).ok, true, "🔴 відео з айфона (.mov) не приймається");
  assert.equal(checkUpload("application/pdf", 1024).ok, true);
  // Тип із параметром — браузери шлють і так.
  const withParam = checkUpload("IMAGE/PNG; charset=binary", 1024);
  assert.equal(withParam.ok, true, "🔴 тип із параметром або у верхньому регістрі не впізнано");

  // ❌ бік «не приймаємо»
  for (const bad of ["application/x-msdownload", "image/svg+xml", "text/html", "application/x-sh"]) {
    const v = checkUpload(bad, 1024);
    assert.equal(v.ok, false, `🔴 «${bad}» пройшов — а файли віддаються inline`);
    if (!v.ok) assert.equal(v.status, 400);
  }
  const unknown = checkUpload(null, 1024);
  assert.equal(unknown.ok, false, "🔴 невідомий тип пройшов");
  if (!unknown.ok) assert.match(unknown.reason, /розширення/, "🔴 відмова не каже, що робити далі");

  // 🔴 Межа — рівно на ній і на байт далі. І це РІЗНІ відмови: «завеликий» ≠ «не той тип».
  assert.equal(checkUpload("video/mp4", MAX_UPLOAD_BYTES).ok, true, "🔴 файл рівно по межі має проходити");
  const over = checkUpload("video/mp4", MAX_UPLOAD_BYTES + 1);
  assert.equal(over.ok, false);
  if (!over.ok) { assert.equal(over.status, 413); assert.match(over.reason, /посиланням/, "🔴 відмова не пропонує вихід для великого відео"); }
  assert.equal(checkUpload("image/png", 0).ok, false, "🔴 порожній файл пройшов");

  // `accept` для форми будується з того самого списку — інакше діалог вибору показував би інше.
  for (const k of ["image/png", "video/mp4"]) assert.ok(ACCEPT_ATTR.includes(k), `🔴 «${k}» немає в accept`);
  assert.equal(ACCEPT_ATTR.split(",").length, Object.keys(ALLOWED_UPLOAD).length, "🔴 accept і білий список розійшлись");
});

/**
 * #711 — КРОК ДОДАЄТЬСЯ В КУРСІ, а не лише в «Бібліотеці», і йде ТИМ САМИМ роутом. Доти шлях
 * був кружний, і саме тому з екрана читалось «фото й відео додати не можна».
 * 🧨 Червоніє, якщо прибрати «+ Крок», сховати діалог від редактора або завести власний шлях у сервер.
 */
test("#711 КУРС: крок додається прямо в темі, наявним роутом, із прев'ю до збереження", () => {
  const s = fe("pages/dashboard/sections/TrainingCourses.tsx");
  assert.match(s, /setAddTo\(\{ id: m\.id, name: m\.name \}\)/, "🔴 кнопки «+ Крок» у темі немає");
  assert.ok(s.includes("function AddStep("), "🔴 діалог додавання кроку зник");
  assert.match(s, /createTrainingMaterial\(\{ folderId: folder\.id/, "🔴 крок кладеться не в ту тему або не тим роутом");
  // Екран не відчиняє власних дверей у сервер (те саме твердження, що й `#707`).
  assert.ok(!/api\.(get|post|patch|delete)\(/.test(s), "🔴 екран сам ходить у сервер повз функції `api.ts`");
  // Прев'ю саме фото й відео — інакше «завантажив не те» зʼясується вже кроком у курсі.
  assert.match(s, /file\.type\.startsWith\("image\/"\) && preview/, "🔴 немає прев'ю фото");
  assert.match(s, /file\.type\.startsWith\("video\/"\) && preview/, "🔴 немає прев'ю відео");
  assert.match(s, /URL\.revokeObjectURL\(u\)/, "🔴 blob-адреса прев'ю не звільняється — памʼять тектиме при кожній заміні файла");
});

/**
 * #712 — МЕЖА РОЗМІРУ ІСНУЄ В ОДНІЙ КОПІЇ. Було три: роут, форма бібліотеки і (з цим проходом)
 * форма курсу. Копії збігаються рівно доти, доки їх не чіпають; розійшовшись, вони дають 413
 * ПІСЛЯ хвилини завантаження — найдорожчий спосіб дізнатися про межу.
 * 🧨 Червоніє, якщо будь-який фронтовий екран знову заведе власне число замість серверного.
 */
test("#712 МЕЖА ЗАВАНТАЖЕННЯ: одне джерело — ядро; фронт бере число з відповіді, а не своє", () => {
  const route = readFileSync(ROUTE, "utf8");
  assert.match(route, /import \{ checkUpload, MAX_UPLOAD_BYTES, ACCEPT_ATTR \} from "\.\.\/core\/trainingUpload\.js";/,
    "🔴 роут більше не бере правила з ядра");
  assert.match(route, /const verdict = checkUpload\(/, "🔴 роут перевіряє завантаження власноруч");
  assert.ok(!/\b45 \* 1024 \* 1024\b/.test(route), "🔴 у роуті знову зашите власне число межі");

  // 🔴 Жоден екран навчання не має власної константи межі — він отримує `upload` із відповіді.
  for (const f of ["pages/dashboard/sections/TrainingCourses.tsx", "pages/dashboard/sections/TrainingSection.tsx"]) {
    const src = fe(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    assert.ok(!/const\s+MAX_[A-Z_]*\s*=\s*\d/.test(src), `🔴 ${f} знову тримає власне число межі`);
    assert.match(src, /upload\.maxBytes/, `🔴 ${f} не бере межу з відповіді сервера`);
    /* 🔴 Наявності `upload.maxBytes` ДЕСЬ у файлі замало — саме на цьому гейт лишився зеленим на
       саботажі 23.09: число повернули в ПОРІВНЯННЯ, а згадка вціліла в сусідньому рядку (показ МБ).
       Тому твердження про предмет: зашитої межі в байтах у файлі не існує. Ділення на 1024*1024
       заради підпису законне — множення числа на 1024*1024 є саме межею. */
    assert.ok(!/\d+\s*\*\s*1024\s*\*\s*1024/.test(src), `🔴 ${f} порівнює розмір із зашитим числом байтів`);
  }
  assert.match(fe("api.ts"), /export interface TrainingUploadRules \{ maxBytes: number; accept: string \}/,
    "🔴 тип правил завантаження зник — фронту нема звідки взяти межу");
});

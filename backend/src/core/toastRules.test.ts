import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

/**
 * Правила сповіщень (стандарт «Еволюція бренду UTS», 07.10.2026) — гейти ВИКОНУЮТЬ чистий модуль
 * фронта `components/toastRules.ts`, а не читають його текст. Шлях будується змінною: статичний
 * `import "…/frontend/…"` не пройшов би збірку бекенду, а рантайм Node знімає типи сам.
 */
const spec = fileURLToPath(new URL("../../../frontend/src/components/toastRules.ts", import.meta.url).href.replace("/dist/", "/src/"));
type Tone = "ok" | "info" | "warn" | "err";
type It = { id: number; tone: Tone; event?: boolean; hasAction?: boolean; loading?: boolean; key?: string; count?: number; text?: string };
type Mod = {
  toastLifetime: (it: Partial<It> & { tone: Tone }) => number | null;
  visibleToasts: (items: It[], max?: number) => { shown: It[]; hidden: number };
  upsertToast: (items: It[], next: It) => It[];
  TOAST_PLAIN_MS: number; TOAST_MAX_SHOWN: number;
};
const load = async () => (await import(spec)) as Mod;

/**
 * #1230 — СКІЛЬКИ ВИСИТЬ: лише успіх чи інформація без кнопки зникають самі (5 с); помилка, кнопка
 * дії, подія й незавершена операція — до закриття (WCAG 2.2.1; Carbon, Atlassian, Primer, Material 3).
 * 🧨 Червоніє, якщо помилці, тосту з «Відновити» чи події «чекає вашого прийняття» дати таймер —
 * рівно та вада, що була в задачнику (7 с) і Опитуваннях (3,2 с).
 */
test("#1230 СПОВІЩЕННЯ: зникає сам лише тост без кнопки й без помилки; помилка, дія, подія — до закриття", async () => {
  const R = await load();
  assert.equal(R.TOAST_PLAIN_MS, 5000);
  assert.equal(R.toastLifetime({ tone: "ok" }), 5000, "🔴 звичайний успіх не зникає сам");
  assert.equal(R.toastLifetime({ tone: "info" }), 5000);
  assert.equal(R.toastLifetime({ tone: "err" }), null, "🔴 ПОМИЛКА ЗНИКАЄ САМА");
  assert.equal(R.toastLifetime({ tone: "ok", hasAction: true }), null, "🔴 тост із «Відновити» зникає раніше, ніж людина встигне натиснути");
  assert.equal(R.toastLifetime({ tone: "ok", event: true }), null, "🔴 подія «чекає вашого прийняття» зникає сама");
  assert.equal(R.toastLifetime({ tone: "warn", event: true }), null, "🔴 пропущений дзвінок зникає сам");
  assert.equal(R.toastLifetime({ tone: "info", loading: true }), null, "🔴 «Зберігаю…» зникає до результату");
});

/**
 * #1231 — «ЩЕ N»: видно до трьох; під кнопку ховаються спершу звичайні тости, потім події й дії,
 * помилки — останніми. Фікстура по обидва боки: наплив успіхів НЕ витісняє помилку, а коли
 * помилок більше, ніж місць, видно найновіші.
 * 🧨 Червоніє, якщо ховати просто найстаріший (так було б у наївній стопці — помилка зникла б першою).
 */
test("#1231 СПОВІЩЕННЯ: «Ще N» ховає спершу звичайні, потім події, помилки — останніми", async () => {
  const R = await load();
  assert.equal(R.TOAST_MAX_SHOWN, 3);
  const items: It[] = [
    { id: 1, tone: "err" }, { id: 2, tone: "ok" }, { id: 3, tone: "ok", event: true },
    { id: 4, tone: "ok" }, { id: 5, tone: "ok", hasAction: true }, { id: 6, tone: "ok" },
  ];
  const v = R.visibleToasts(items);
  assert.equal(v.hidden, 3);
  assert.deepEqual(v.shown.map((x) => x.id), [1, 3, 5], "🔴 наплив успіхів витіснив помилку або подію");
  // Усі «липкі»: ховається подія, а не помилка.
  const sticky = R.visibleToasts([{ id: 1, tone: "err" }, { id: 2, tone: "ok", event: true }, { id: 3, tone: "err" }, { id: 4, tone: "ok", hasAction: true }]);
  assert.deepEqual(sticky.shown.map((x) => x.id), [1, 3, 4], "🔴 під «Ще N» сховано помилку, хоча була подія");
  // Інший бік межі: самі помилки — видно три найновіші, жодна не губиться без «Ще N».
  const errs = R.visibleToasts([1, 2, 3, 4].map((id) => ({ id, tone: "err" as Tone })));
  assert.deepEqual([errs.shown.map((x) => x.id), errs.hidden], [[2, 3, 4], 1]);
  assert.deepEqual(R.visibleToasts([{ id: 1, tone: "ok" }]).hidden, 0);
});

/**
 * #1232 — ТОЙ САМИЙ КЛЮЧ ЗАМІНЮЄ, А НЕ ДОДАЄ: «Зберігаю…» стає «Збережено» на тому самому місці,
 * серія пропущених дзвінків — одним тостом із лічильником. Без ключа — новий тост поруч.
 * 🧨 Червоніє, якщо однаковий ключ дасть другий тост (стопка «3 пропущені» з трьох окремих).
 */
test("#1232 СПОВІЩЕННЯ: однаковий ключ замінює тост і рахує повтори; без ключа — новий", async () => {
  const R = await load();
  let xs: It[] = [];
  xs = R.upsertToast(xs, { id: 1, tone: "info", loading: true, key: "save-5", text: "Зберігаю…" });
  xs = R.upsertToast(xs, { id: 2, tone: "ok", key: "save-5", text: "Збережено" });
  assert.equal(xs.length, 1, "🔴 «Зберігаю…» і «Збережено» — два тости замість одного");
  assert.deepEqual([xs[0].id, xs[0].text, xs[0].loading], [1, "Збережено", undefined], "🔴 заміна не на тому місці або «крутилка» лишилась");
  xs = R.upsertToast(xs, { id: 3, tone: "warn", event: true, key: "missed" });
  xs = R.upsertToast(xs, { id: 4, tone: "warn", event: true, key: "missed" });
  xs = R.upsertToast(xs, { id: 5, tone: "warn", event: true, key: "missed" });
  assert.equal(xs.filter((x) => x.key === "missed").length, 1, "🔴 серія дзвінків дала кілька тостів");
  assert.equal(xs.find((x) => x.key === "missed")!.count, 3, "🔴 лічильник серії не рахує повтори");
  xs = R.upsertToast(xs, { id: 6, tone: "ok" });
  xs = R.upsertToast(xs, { id: 7, tone: "ok" });
  assert.equal(xs.length, 4, "🔴 тости без ключа злились — різні дії людини загубились");
});

/**
 * #1233 — ТОСТ ОДИН НА ВЕСЬ ДАШБОРД. До 07.10.2026 їх було три: спільний (внизу праворуч), задачника
 * й месенджера (угорі праворуч, 7 с) і Опитувань (внизу по центру, 3,2 с). Критерій — від предмета:
 * у БУДЬ-ЯКОМУ файлі фронта, крім `Toasts.tsx`, не може бути власного стану тостів; задачник,
 * месенджер (`Dashboard.tsx`) і Опитування кличуть `useToast()`.
 * 🧨 Червоніє, якщо повернути `const [toasts, setToasts] = useState` чи `toastMsg` у будь-який екран.
 */
test("#1233 СПОВІЩЕННЯ: один тост — у фронті немає власного стану тостів поза Toasts.tsx", async () => {
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const path = await import("node:path");
  const root = fileURLToPath(new URL("../../../frontend/src", import.meta.url).href.replace("/dist/", "/src/"));
  const files: string[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d)) { const p = path.join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(n)) files.push(p); } };
  walk(root);
  assert.ok(files.length > 100, `🔴 обхід фронта знайшов лише ${files.length} файлів — гейт нічого не перевіряє`);
  const own = /\[\s*\w*[tT]oasts?(Msg)?\w*\s*,\s*set\w+\s*\]\s*=\s*useState/;
  const offenders = files.filter((f) => !f.endsWith(path.join("components", "Toasts.tsx")) && own.test(readFileSync(f, "utf8"))).map((f) => path.relative(root, f));
  assert.deepEqual(offenders, [], "🔴 власний тост поза Toasts.tsx: " + offenders.join(", "));
  for (const rel of ["pages/Dashboard.tsx", "pages/dashboard/sections/SurveysSection.tsx"]) {
    assert.match(readFileSync(path.join(root, rel), "utf8"), /=\s*useToast\(\)/, `🔴 ${rel} не користується спільним тостом`);
  }
});

const feSpec = (rel: string) => fileURLToPath(new URL(`../../../frontend/src/${rel}`, import.meta.url).href.replace("/dist/", "/src/"));

/**
 * #1234 — ЗВУК: ОДИН АУДІОКОНТЕКСТ НА СТОРІНКУ, І ВИМИКАЧ ПРАЦЮЄ. Доти кожен сигнал створював новий
 * `AudioContext` і не закривав його — після кількох десятків подій звук зникав. Виконуємо модуль із
 * заглушкою аудіо: п'ять сигналів — один контекст; вимкнено — жодного тону; за замовчуванням — увімкнено.
 * 🧨 Червоніє, якщо створювати контекст на кожен сигнал або ігнорувати вимикач.
 */
test("#1234 СПОВІЩЕННЯ: звук — один аудіоконтекст на сторінку, вимикач вимикає, за замовчуванням увімкнено", async () => {
  let made = 0, tones = 0;
  const store = new Map<string, string>();
  class FakeCtx {
    state = "running"; currentTime = 0; destination = {};
    constructor() { made++; }
    resume() { return Promise.resolve(); }
    createOscillator() { tones++; return { connect() {}, frequency: { value: 0 }, type: "", start() {}, stop() {} }; }
    createGain() { return { connect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } }; }
  }
  const g = globalThis as Record<string, unknown>;
  g.window = { AudioContext: FakeCtx };
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  try {
    const S = await import(feSpec("components/notifySound.ts") + "?t=1") as { playNotifySound: (s: boolean) => void; soundEnabled: () => boolean; setSoundEnabled: (b: boolean) => void };
    assert.equal(S.soundEnabled(), true, "🔴 звук вимкнений за замовчуванням");
    for (let i = 0; i < 5; i++) S.playNotifySound(i % 2 === 0);
    assert.equal(made, 1, `🔴 ${made} аудіоконтекстів на 5 сигналів — кожен сигнал створює свій`);
    assert.equal(tones, 3 * 2 + 2 * 1, "🔴 «добре» має два тони, нейтральний — один");
    S.setSoundEnabled(false);
    const before = tones;
    S.playNotifySound(true);
    assert.equal(tones, before, "🔴 вимкнений звук однаково звучить");
  } finally { delete g.window; delete g.localStorage; }
});

/**
 * #1235 — СПОВІЩЕННЯ БРАУЗЕРА: лише на ПРИХОВАНІЙ вкладці, з `tag`; дозвіл — після першого кліку,
 * а не при відкритті сторінки. Фікстура по обидва боки: видима вкладка — нічого; прихована — одне
 * сповіщення з тегом; до кліку запиту дозволу немає, після кліку — рівно один.
 * 🧨 Червоніє, якщо сповіщати й на видимій вкладці (дубль поруч із тостом) чи питати дозвіл одразу.
 */
test("#1235 СПОВІЩЕННЯ: браузер — лише прихована вкладка з тегом; дозвіл — після першого кліку", async () => {
  const shown: { body: string; tag: string }[] = [];
  let asked = 0;
  const listeners: Array<() => void> = [];
  class FakeNotification {
    static permission = "default";
    static requestPermission() { asked++; return Promise.resolve("granted"); }
    constructor(_t: string, o: { body: string; tag: string }) { shown.push(o); }
  }
  const g = globalThis as Record<string, unknown>;
  const doc = { hidden: false, addEventListener: (_e: string, f: () => void) => listeners.push(f), removeEventListener: () => {} };
  g.Notification = FakeNotification; g.document = doc;
  try {
    const B = await import(feSpec("components/browserNotify.ts") + "?t=1") as { askNotifyPermissionOnFirstClick: () => void; notifyBrowser: (b: string, t: string) => void };
    B.askNotifyPermissionOnFirstClick();
    assert.equal(asked, 0, "🔴 дозвіл питають одразу, без дії людини");
    assert.equal(listeners.length, 1, "🔴 немає очікування першого кліку");
    listeners[0]();
    assert.equal(asked, 1, "🔴 після кліку дозвіл так і не попросили");
    FakeNotification.permission = "granted";
    B.notifyBrowser("видима", "k1");
    assert.equal(shown.length, 0, "🔴 сповіщення на ВИДИМІЙ вкладці — дубль поруч із тостом");
    doc.hidden = true;
    B.notifyBrowser("Чекає вашого прийняття", "accept-5");
    assert.deepEqual(shown, [{ body: "Чекає вашого прийняття", tag: "accept-5" }], "🔴 на прихованій вкладці сповіщення немає або без тегу");
  } finally { delete g.Notification; delete g.document; }
});

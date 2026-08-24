/**
 * 📮 ГЕЙТИ ПОШТАРЯ ТРИВОГ (#112–#116).
 *
 * 🔴 ЩО САМЕ СТЕРЕЖЕМО. Не «чи вміє код надіслати повідомлення» — це видно з
 * першого прогону. Стережемо ТРИ властивості, кожну з яких ми вже одного разу
 * втратили і кожна коштувала простою:
 *   • тривога КАЖЕ, ЩО РОБИТИ (алерт без дії читають один раз, далі ігнорують);
 *   • тривога НЕ ПОВТОРЮЄТЬСЯ щохвилини (канал-спамер глушать — і далі він мовчить
 *     уже назавжди, тобто спам це не незручність, а тиха втрата сигналізації);
 *   • дедуп ПЕРЕЖИВАЄ РЕСТАРТ (наявні вартові дедуплять `Set`-ом у памʼяті, а
 *     половина наших тривог — ПРО рестарти: дедуп зникав рівно в аварії).
 *
 * Гейти ганяють СПРАВЖНІЙ `alertPush` із СПРАВЖНІМИ SQL проти СПРАВЖНЬОЇ схеми —
 * підмінюються лише джерело тривог і відправник. Переписати SQL «схоже» означало б
 * доводити ні про що (урок `#21c`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { skipReason, type Unavailable } from "../db/scratchDb.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { needsApi, API_BASE } from "../testMode.js";
// 🔴 ІМПОРТ САМЕ З `alertRules.js`, А НЕ З `alertPush.js`. Останній тягне
// `db/pool.js` → `config.js`, який кидає на відсутньому DATABASE_URL/JWT_SECRET ще
// НА ІМПОРТІ — тобто раніше, ніж встигне спрацювати skip, і весь файл падав би не
// через помилку в правилах, а через неможливість завантажитись. Перевірено: саме
// так він і впав на першому прогоні.
import {
  formatAlert, formatResolved, repeatAfterMin, isPointEvent, humanDuration, REPEAT_AFTER_MIN,
  classifyBoot, hasDeployGrace, DEPLOY_GRACE_MIN,
  summarizeRestarts, BOOT_LOOP_MIN, DEPLOY_INTENT_MIN,
} from "./alertRules.js";
import type { Alert } from "../health/alerts.js";

/** Читання ДЖЕРЕЛА (не збірки) — набір біжить із `dist`, а перевіряти треба `.ts`. */
function readSrc(rel: string): string {
  for (const r of [path.join(import.meta.dirname, "..", ".."), path.join(import.meta.dirname, "..", "..", "..")]) {
    try { return readFileSync(path.join(r, rel), "utf8"); } catch { /* далі */ }
  }
  assert.fail(`не знайдено ${rel} — перевірка не має права мовчки пропускатись`);
}

const A = (over: Partial<Alert> = {}): Alert => ({
  id: "sync:stale", severity: "critical", title: "Дані з CRM застаріли",
  detail: "Останній успішний синк 95 хв тому.", action: "Перевірити /api/health і job_locks.",
  since: null, ...over,
});

/** Підняти одноразовий кластер зі СПРАВЖНЬОЮ схемою і віддати клієнта. */
async function withScratch(t: { skip: (m: string) => void },
  body: (q: (s: string, p?: unknown[]) => Promise<{ rows: never[] }>) => Promise<void>): Promise<void> {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    await body(((s: string, p?: unknown[]) => c.query(s, p)) as never);
  } finally {
    await c.end().catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * #112 — КОЖНА ТРИВОГА КАЖЕ, ЩО РОБИТИ, І НОВІ ПОДІЇ СПРАВДІ ЗАРЕЄСТРОВАНІ.
 *
 * 🔴 Дві половини, і друга не менш важлива за першу. `#10.2` уже вимагає `action`
 * від тривог ДВИГУНА — але лише від тих, що зараз горять; на здоровій системі він
 * не перевіряє нічого. Тут перевіряється ФОРМАТ поштаря: дія має доїхати в текст
 * повідомлення, а не лишитись полем у JSON.
 *
 * 🧨 САБОТАЖ (виконано): прибрати `▶️ Що робити` з шаблону `formatAlert` → падає
 * перша перевірка; прибрати `build`/`boot` із `CHECKS` → падає друга.
 */
test("#112 повідомлення поштаря несе ДІЮ, і обидві нові події зареєстровані", async () => {
  const txt = formatAlert(A(), null);
  assert.match(txt, /Що робити/, "🔴 у повідомленні немає блоку «що робити» — таку тривогу читають один раз");
  assert.ok(txt.includes(A().action), "🔴 текст дії загубився при форматуванні");
  assert.ok(txt.includes(A().title) && txt.includes(A().detail), "🔴 загубився заголовок або деталі");

  // Повтор мусить ЧЕСНО казати, що він повтор, і скільки триває, — інакше людина
  // не відрізнить нову поломку від тієї самої, про яку вже знає.
  const rep = formatAlert(A(), { since: new Date(Date.now() - 3 * 3600_000), count: 2 });
  assert.match(rep, /ВСЕ ЩЕ/, "🔴 повтор не позначений як повтор");
  assert.match(rep, /3 год/, "🔴 повтор не каже, скільки вже триває");
  assert.match(rep, /Що робити/, "🔴 у повторі зникла дія");

  // Реєстрацію перевіряємо ПО ДЖЕРЕЛУ, а не імпортом `DECLARED_CHECKS`:
  // `health/alerts.ts` тягне `db/pool.js` → `config.js`, який кидає без DATABASE_URL
  // ще на імпорті, і цей гейт мовчки не виконувався б без БД — тобто саме тоді, коли
  // його й ганяють найчастіше. Той самий прийом, що `#24d`/`#111·роут`.
  const alertsSrc = readSrc("src/health/alerts.ts");
  for (const id of ["build", "boot"]) {
    assert.ok(new RegExp(`\\{\\s*id:\\s*"${id}"`).test(alertsSrc),
      `🔴 перевірку «${id}» не додано в CHECKS — подія оголошена в плані й не існує в коді`);
  }
});

/**
 * #112b — ДЕДУП: ДРУГИЙ ТІК ТОГО САМОГО ІНЦИДЕНТУ НЕ ШЛЕ.
 *
 * 🔴 Поштар біжить ЩОХВИЛИНИ. Без дедупу застряглий синк дав би 60 повідомлень за
 * годину; канал глушать після другого десятка, і далі сигналізації немає взагалі —
 * при формально «працюючих» алертах. Це той самий клас хибно-зеленого, що й
 * «успіх за 0 мс», лише з іншого боку.
 *
 * 🧨 САБОТАЖ (виконано): прибрати гілку тихого тіку (слати завжди) → `sent+repeated`
 * стає 3 замість 1, гейт червоніє.
 */
test("#112b другий і третій тік того самого інциденту НЕ шлють", async (t) => {
  await withScratch(t, async (query) => {
    const { alertPush } = await import("./alertPush.js");
    const sent: string[] = [];
    const deps = { collect: async () => ({ alerts: [A()], checksRan: 8, checksDeclared: 8 }),
      send: async (s: string) => { sent.push(s); }, query } as never;

    const r1 = await alertPush(deps);
    assert.equal(r1.sent, 1, "🔴 перша поява не надіслалась — сигналізація мовчить про нову поломку");
    const r2 = await alertPush(deps);
    const r3 = await alertPush(deps);
    assert.equal(r2.sent + r2.repeated, 0, "🔴 другий тік надіслав повтор — канал перетвориться на шум");
    assert.equal(r3.sent + r3.repeated, 0, "🔴 третій тік надіслав повтор");
    assert.equal(sent.length, 1, `🔴 надіслано ${sent.length} повідомлень замість 1 на інцидент`);

    // 🪞 ДЗЕРКАЛО: інцидент, чий час повтору МИНУВ, слати ЗОБОВʼЯЗАНИЙ. Без цього
    // гейт зеленів би й на поштарі, який не шле нічого й ніколи.
    await query(`UPDATE alert_state SET last_sent_at = now() - ($1 || ' minutes')::interval`,
      [String(REPEAT_AFTER_MIN + 5)]);
    const r4 = await alertPush(deps);
    assert.equal(r4.repeated, 1, "🔴 після 6 год нагадування не пішло — про поломку забули");
    assert.match(sent[1], /ВСЕ ЩЕ/, "🔴 нагадування не підписане як повтор");
  });
});

/**
 * #113 — ВІДБІЙ ПРИХОДИТЬ, І РІВНО ОДИН РАЗ.
 *
 * 🔴 Без відбою людина не знає, чи тривога ще чинна, і за два тижні перестає
 * відкривати канал — мовчазне «відновилось» коштує так само дорого, як мовчазна
 * поломка. А відбій, що повторюється, — це вже спам, тобто та сама втрата каналу.
 *
 * 🧨 САБОТАЖ (виконано): прибрати умову `k.resolved_at != null` у циклі відбою →
 * «✅ відновилось» приходить на КОЖНОМУ наступному тіку, друга перевірка червоніє.
 */
test("#113 відбій приходить рівно раз і каже тривалість інциденту", async (t) => {
  await withScratch(t, async (query) => {
    const { alertPush } = await import("./alertPush.js");
    const sent: string[] = [];
    const send = async (s: string) => { sent.push(s); };
    const on = { collect: async () => ({ alerts: [A()], checksRan: 8, checksDeclared: 8 }), send, query } as never;
    const off = { collect: async () => ({ alerts: [], checksRan: 8, checksDeclared: 8 }), send, query } as never;

    await alertPush(on);
    // Інцидент «прожив» 2 години — тривалість мусить бути в тексті, інакше відбій
    // не відповідає на єдине питання, заради якого його читають.
    await query(`UPDATE alert_state SET first_seen_at = now() - interval '2 hours'`);
    const r = await alertPush(off);
    assert.equal(r.resolved, 1, "🔴 відбою не було — незрозуміло, чи тривога ще чинна");
    assert.equal(sent.length, 2, "🔴 очікували 2 повідомлення (тривога + відбій)");
    assert.match(sent[1], /Відновилось/, "🔴 відбій не підписаний");
    assert.match(sent[1], /2 год/, "🔴 відбій не каже, скільки тривав інцидент");

    const r2 = await alertPush(off);
    const r3 = await alertPush(off);
    assert.equal(r2.resolved + r3.resolved, 0, "🔴 відбій повторюється — це спам, а не сигналізація");
    assert.equal(sent.length, 2, `🔴 після відбою надіслано ще ${sent.length - 2} зайвих повідомлень`);

    // 🪞 ДЗЕРКАЛО: та сама поломка ПІСЛЯ відбою — це НОВИЙ епізод, і про нього
    // мусять сказати. Інакше «один раз повідомили» перетворилось би на «більше
    // ніколи не повідомимо».
    const r4 = await alertPush(on);
    assert.equal(r4.sent, 1, "🔴 повторна поява після відбою не надіслалась — поломку сховали");
    assert.doesNotMatch(sent[2], /ВСЕ ЩЕ/,
      "🔴 новий епізод подано як продовження старого — лічильник нагадувань стосувався б минулої події");
  });
});

/**
 * #113b — ТОЧКОВА ПОДІЯ НЕ ОТРИМУЄ ВІДБОЮ.
 *
 * «✅ Відновилось: застосунок перезапустився» — беззмістовна фраза. Канал, у якому
 * трапляються беззмістовні фрази, читають гірше; це та сама втрата довіри, лише
 * повільніша.
 */
test("#113b «несподіваний рестарт» не шле відбою (точкова подія)", async (t) => {
  await withScratch(t, async (query) => {
    const { alertPush } = await import("./alertPush.js");
    const sent: string[] = [];
    const send = async (s: string) => { sent.push(s); };
    const boot = A({ id: "app:restart:42", title: "Застосунок перезапустився без викату" });
    await alertPush({ collect: async () => ({ alerts: [boot], checksRan: 8, checksDeclared: 8 }), send, query } as never);
    const r = await alertPush({ collect: async () => ({ alerts: [], checksRan: 8, checksDeclared: 8 }), send, query } as never);
    assert.equal(r.resolved, 0, "🔴 для точкової події надіслано відбій");
    assert.equal(sent.length, 1, "🔴 зайве повідомлення після точкової події");
    // Але сам інцидент мусить бути ЗАКРИТИЙ у стані — інакше він ніколи не
    // повториться (наступний рестарт має свій id, але порядок має бути чистий).
    const rows = (await query(`SELECT resolved_at, resolved_notified FROM alert_state WHERE id='app:restart:42'`)).rows as
      { resolved_at: Date | null; resolved_notified: boolean }[];
    assert.ok(rows[0]?.resolved_at, "🔴 точкова подія лишилась відкритою назавжди");
    assert.equal(rows[0].resolved_notified, false, "🔴 позначено як «повідомлено», хоч відбою не слали");
    assert.equal(isPointEvent("app:restart:42"), true);
    assert.equal(isPointEvent("sync:stale"), false, "🔴 звичайна тривога визнана точковою — вона втратить відбій");
  });
});

/**
 * #114 — ДЕДУП ПЕРЕЖИВАЄ РЕСТАРТ.
 *
 * 🔴 ГОЛОВНИЙ ГЕЙТ ПРОХОДУ. Наявні вартові (`freshnessWatch.alerted`,
 * `abandonAlerted`, `divergenceAlerted`) тримають дедуп у `Set` — і той Set
 * порожніє на кожному рестарті. Половина тривог, які ми шлемо, — ПРО падіння й
 * рестарти, тобто дедуп зникав РІВНО в аварії: після падіння канал отримував
 * повторно всі чинні тривоги.
 *
 * Рестарт емулюється чесно — свіжим імпортом модуля з обнуленим кешем: якби стан
 * жив у памʼяті, він би зник, і повтор пішов би.
 *
 * 🧨 САБОТАЖ (виконано): замінити читання `alert_state` на памʼятний `Set` →
 * після «рестарту» надсилається повтор, гейт червоніє.
 */
test("#114 дедуп переживає рестарт процесу (стан у БД, не в памʼяті)", async (t) => {
  await withScratch(t, async (query) => {
    const sent: string[] = [];
    const send = async (s: string) => { sent.push(s); };
    const collect = async () => ({ alerts: [A()], checksRan: 8, checksDeclared: 8 });

    const first = await import("./alertPush.js");
    await first.alertPush({ collect, send, query } as never);
    assert.equal(sent.length, 1);

    // «Рестарт»: модуль завантажується заново, будь-який модульний стан обнулено.
    const reborn = await import(`./alertPush.js?restart=${Date.now()}`) as typeof first;
    const r = await reborn.alertPush({ collect, send, query } as never);
    assert.equal(r.sent + r.repeated, 0,
      "🔴 після рестарту той самий інцидент надіслано ВДРУГЕ — дедуп у памʼяті, а не в БД. "
      + "Саме так канал заливає повторами в аварії, коли рестарти й трапляються");
    assert.equal(sent.length, 1, `🔴 після рестарту надіслано ще ${sent.length - 1} повторів`);

    // 🪞 ДЗЕРКАЛО: стан справді ЛЕЖИТЬ у таблиці, а не «просто нічого не сталось».
    const rows = (await query(`SELECT id, sent_count FROM alert_state`)).rows as { id: string; sent_count: number }[];
    assert.equal(rows.length, 1, "🔴 у alert_state порожньо — дедуп тримається ні на чому");
    assert.equal(Number(rows[0].sent_count), 1, "🔴 лічильник надсилань не ведеться");
  });
});

/**
 * #115 — САМ ПОШТАР ПІД НАГЛЯДОМ.
 *
 * 🔴 Замовклий поштар не подає ЖОДНОГО зовнішнього знаку: тривоги просто
 * перестають приходити, а тиша в каналі виглядає рівно як «усе добре». Це той
 * самий клас, що «успіх за 0 мс» і «папка бекапу є, копії немає» — порожнеча
 * читається як норма. Тому його мовчання мусить ловити банер.
 *
 * 🧨 САБОТАЖ (виконано): прибрати рядок `alertPush` із `MONITORED_JOBS` → червоніє.
 */
test("#115 alertPush сам у MONITORED_JOBS — поштар, що замовк, має бути видно", async () => {
  const { MONITORED_JOBS } = await import("./monitoredJobs.js");
  const j = MONITORED_JOBS.find((x) => x.name === "alertPush");
  assert.ok(j, "🔴 поштаря немає під наглядом — якщо він замовкне, це ніде не спливе, "
    + "а тиша в каналі читається як «усе добре»");
  assert.ok(j.everyMin > 0 && j.everyMin <= 5,
    `🔴 частота ${j.everyMin} хв — при рідкому тіку поріг мовчання (2×) стає надто широким`);
  assert.ok(j.why.length > 15, "🔴 у реєстрі не сказано, ЧИМ шкідливе його мовчання");

  // Крон справді зареєстрований — інакше реєстр описував би джобу, якої немає.
  const src = readSrc("src/index.ts");
  assert.match(src, /runJob\("alertPush"/, "🔴 alertPush не запускається жодним кроном");
  assert.match(src, /recordBoot\(\)/, "🔴 старт процесу не записується — «несподіваний рестарт» не з чим порівняти");
});

/**
 * #115b — ОГОЛОШЕНА ЧАСТОТА == СПРАВЖНІЙ КРОН.
 *
 * 🔴 ЧОМУ ЦЕ ОКРЕМИЙ ГЕЙТ. Сторож мовчання рахує «застряг» від `2× everyMin`. Якщо
 * крон стане рідшим за оголошене, поштар почне бити тривогу САМ НА СЕБЕ — і то
 * правдоподібну: «джоба alertPush мовчить N хв» при джобі, що працює як задумано.
 * Тобто розсинхрон двох чисел не ламає нічого видимого, а лише робить канал
 * шумним — рівно той спосіб, яким алерти привчають ігнорувати.
 *
 * Це той самий клас, що «прибираєш інваріанту — знайди всіх, хто на неї спирався»:
 * частота жила у ДВОХ місцях, і зміна одного з них тиха за побудовою. Спіймано на
 * зниженні 1 → 5 хв 21.08.2026: правку в `index.ts` зробив, а `everyMin: 1` у
 * реєстрі лишався б і перетворив кожен тік на фальшиву тривогу.
 *
 * 🧨 САБОТАЖ (виконано): лишити `everyMin: 1` при п'ятихвилинному кроні -> червоніє з обома числами.
 */
test("#115b оголошена частота поштаря == крону, яким він справді запускається", async () => {
  const { MONITORED_JOBS } = await import("./monitoredJobs.js");
  const declared = MONITORED_JOBS.find((x) => x.name === "alertPush")!.everyMin;

  // Крон беремо з ДЖЕРЕЛА: саме розбіжність джерела й реєстру ми й ловимо, тож
  // читати частоту з константи, яку обидва імпортують, означало б перевіряти «A == A».
  const src = readSrc("src/index.ts");
  const block = src.slice(0, src.indexOf(`runJob("alertPush"`));
  const last = [...block.matchAll(/cron\.schedule\("([^"]+)"/g)].pop();
  assert.ok(last, "🔴 не знайдено cron.schedule перед запуском alertPush");

  const spec = last[1];
  const m = /^\*\/(\d+) \* \* \* \*$/.exec(spec) ?? (spec === "* * * * *" ? ["", "1"] : null);
  assert.ok(m, `🔴 крон «${spec}» не хвилинного вигляду — гейт більше не вміє його прочитати, `
    + "а мовчазний гейт гірший за відсутній");

  assert.equal(Number(m[1]), declared,
    `🔴 крон каже «раз на ${m[1]} хв», реєстр наглядача — «${declared}». Сторож мовчання `
    + `рахує застій від 2×${declared} хв, тож поштар битиме тривогу сам на себе`);
});

/**
 * #117 — ТИХА ФОРА НА ШУМ ВИКАТУ: молода умова мовчить, стара — шле.
 *
 * 🔴 ЩО САМЕ СТЕРЕЖЕМО. Не «чи вміє код промовчати» — а те, що фора ВІДКЛАДАЄ
 * тривогу, а не СКАСОВУЄ її. Різниця тут вирішальна: придушення, яке не має
 * протилежної половини, зеленіє й тоді, коли сигналізація вимкнена назавжди.
 * Тому в гейті обовʼязково ОБИДВА боки — і мовчання, і спрацювання.
 *
 * Привід заміряний на власному викаті 1592eaf: плановий викат дав ЧОТИРИ
 * повідомлення (дві правдиві тривоги + два відбої) за кілька хвилин. Канал, що
 * передбачувано шумить на кожну планову дію, глушать разом зі справжніми
 * тривогами — тобто це не косметика, а захист самого гудка.
 *
 * 🧨 САБОТАЖ (виконано): прибрати виклик `suppressedByGrace` → перша перевірка
 * червоніє; зробити фору безумовною (`hasDeployGrace` → true) → червоніє дзеркало
 * про чужу подію; лишити фору назавжди (прибрати порівняння з порогом) → червоніє
 * перевірка «стара умова шле».
 */
test("#117 фора мовчить на молодій умові викату і НЕ мовчить на старій", async (t) => {
  await withScratch(t, async (query) => {
    const { alertPush } = await import("./alertPush.js");
    const sent: string[] = [];
    const stale = A({ id: "build:stale", severity: "warning",
      title: "Зібрано нову версію, але процес не перезапущено" });
    const deps = { collect: async () => ({ alerts: [stale], checksRan: 8, checksDeclared: 8 }),
      send: async (x: string) => { sent.push(x); }, query } as never;

    // ── 1. МОЛОДА умова (щойно зʼявилась) — звичайний викат. Мовчимо.
    const r1 = await alertPush(deps);
    assert.equal(r1.sent, 0, "🔴 молода `build:stale` надіслалась — кожен викат знову шумітиме");
    assert.equal(sent.length, 0, "🔴 у канал пішло повідомлення під час фори");

    // Рядок МУСИТЬ існувати: без запамʼятованого `first_seen_at` вік умови не було б
    // з чого рахувати, і фора діяла б вічно — тобто перевірка зникла б назовсім.
    const row = (await query(`SELECT sent_count, last_sent_at, first_seen_at FROM alert_state
                              WHERE id = 'build:stale'`)).rows as unknown as
      { sent_count: number; last_sent_at: Date | null }[];
    assert.equal(row.length, 1, "🔴 умову не записано — вік рахувати нема від чого, фора стане вічною");
    assert.equal(row[0].sent_count, 0, "🔴 порахували як надіслану, хоч промовчали");
    assert.equal(row[0].last_sent_at, null, "🔴 позначили час відправки там, де відправки не було");

    // ── 2. ТА САМА умова, що пережила поріг, — «зібрав і не перезапустив» (49 хв 05.08).
    await query(`UPDATE alert_state SET first_seen_at = now() - ($1 || ' minutes')::interval
                 WHERE id = 'build:stale'`, [String(DEPLOY_GRACE_MIN + 5)]);
    const r2 = await alertPush(deps);
    assert.equal(r2.sent, 1, `🔴 умова старша за ${DEPLOY_GRACE_MIN} хв не надіслалась — `
      + "фора СКАСУВАЛА тривогу замість відкласти, і 49-хвилинний випадок 05.08 пройшов би повз");
    assert.equal(r2.repeated, 0, "🔴 перше повідомлення поїхало гілкою повтору");
    assert.doesNotMatch(sent[0], /ВСЕ ЩЕ/,
      "🔴 перша фраза про подію — «ВСЕ ЩЕ»: людина не бачила попереднього повідомлення, бо його не було");
  });
});

/**
 * #117b — 🪞 ДЗЕРКАЛО: фора НЕ поширюється на решту тривог.
 *
 * 🔴 Без цієї половини «тиха фора» непомітно перетворилась би на «затримувати ВСЕ
 * на 10 хв»: застарілий синк, впала джоба, порожній роль-кеш — усе почало б
 * чекати, і жодна перевірка вище цього не побачила б. Односторонній тест на
 * мовчання зеленіє і тоді, коли канал мовчить завжди.
 */
test("#117b фора стосується ЛИШЕ двох подій викату — решта шле з першого тіку", async (t) => {
  await withScratch(t, async (query) => {
    const { alertPush } = await import("./alertPush.js");
    const sent: string[] = [];
    // `sync:stale` — щойно зʼявилась, тобто «молода» рівно так само, як `build:stale`.
    const deps = { collect: async () => ({ alerts: [A()], checksRan: 8, checksDeclared: 8 }),
      send: async (x: string) => { sent.push(x); }, query } as never;

    const r = await alertPush(deps);
    assert.equal(r.sent, 1, "🔴 звичайну тривогу теж придушено — фора накрила все, "
      + "і сигналізація мовчить перші 10 хв КОЖНОЇ поломки");
    assert.equal(sent.length, 1, "🔴 у канал нічого не пішло");

    // Реєстр фори — саме двоелементний, а не «усе, що схоже на викат».
    assert.ok(hasDeployGrace("build:stale") && hasDeployGrace("version:mismatch"),
      "🔴 подія викату випала з реєстру фори — шум повернеться");
    assert.ok(!hasDeployGrace("sync:stale") && !hasDeployGrace("roles:empty"),
      "🔴 у фору потрапила подія, яка до викату стосунку не має");
  });
});

/**
 * #117c — ПРО ЩО НЕ КАЗАЛИ, ПРО ТЕ Й ВІДБОЮ НЕ БУВАЄ.
 *
 * 🔴 Половина шуму — це відбої. Якби придушена умова, зникнувши, слала
 * «✅ відновилось», фора прибрала б два повідомлення з чотирьох, а людина читала б
 * підтвердження події, якої не бачила, — гірше за початковий шум, бо незрозуміло.
 */
test("#117c придушена умова зникає МОВЧКИ — відбою про неї не приходить", async (t) => {
  await withScratch(t, async (query) => {
    const { alertPush } = await import("./alertPush.js");
    const sent: string[] = [];
    const stale = A({ id: "build:stale", title: "Зібрано нову версію, але процес не перезапущено" });
    let alerts = [stale];
    const deps = { collect: async () => ({ alerts, checksRan: 8, checksDeclared: 8 }),
      send: async (x: string) => { sent.push(x); }, query } as never;

    await alertPush(deps);            // побачили, промовчали (фора)
    alerts = [];                      // рестарт стався — умова зникла
    const r = await alertPush(deps);
    assert.equal(r.resolved, 0, "🔴 надіслано «відновилось» про тривогу, якої людина не бачила");
    assert.equal(sent.length, 0, `🔴 у канал пішло ${sent.length} повідомлень замість тиші`);

    const row = (await query(`SELECT resolved_at IS NOT NULL AS res, resolved_notified
                              FROM alert_state WHERE id = 'build:stale'`)).rows as unknown as
      { res: boolean; resolved_notified: boolean }[];
    assert.equal(row[0].res, true, "🔴 інцидент не закрито — наступна поява не рахуватиметься новою");
    assert.equal(row[0].resolved_notified, false,
      "🔴 позначено як «повідомлено про відбій», хоч у канал нічого не йшло");
  });
});

/**
 * #116 — `/api/health.alertChannel.telegram` ВІДОБРАЖАЄ РЕАЛЬНУ КОНФІГУРАЦІЮ.
 *
 * 🔴 ЧОМУ ЦЕ ОКРЕМИЙ ГЕЙТ, А НЕ ДРІБНИЦЯ. 10.08.2026 вартові 15 годин справно
 * кликали `sendAdminAlert`, який мовчки виходив: у `.env` не було `TELEGRAM_*`.
 * Сигналізація, про несправність якої не сигналізують, гірша за її відсутність —
 * на неї розраховують. Поле мусить казати правду, інакше ми знову «маємо алерти».
 *
 * ⚠️ Заміряно 21.08.2026: `.env` змінили о 15:27, процес стартував о 14:17 — і
 * поле чесно показувало `false`, бо `dotenv` читає файл лише на старті. Тобто
 * гейт стереже саме те, на чому ми спіймались: канал «налаштований на диску» і
 * «підключений у процесі» — РІЗНІ факти.
 */
test("#116 health чесно каже, чи підключений канал сповіщень", needsApi(), async () => {
  const r = await fetch(`${API_BASE}/api/health`);
  assert.equal(r.status, 200, `🔴 /api/health віддав ${r.status}`);
  const h = await r.json() as { alertChannel?: { telegram: boolean; note?: string } };
  assert.ok(h.alertChannel, "🔴 у health немає alertChannel — стан гудка невидимий");
  assert.equal(typeof h.alertChannel.telegram, "boolean", "🔴 alertChannel.telegram не булеве");
  assert.ok((h.alertChannel.note ?? "").length > 20,
    "🔴 поле без пояснення: побачивши false, людина не знає, що робити");
  assert.equal(h.alertChannel.telegram, true,
    "🔴 канал НЕ підключений у живому процесі. Алерти нікуди не йдуть — "
    + "перевір TELEGRAM_BOT_TOKEN / TELEGRAM_ADMIN_IDS у backend/.env і ПЕРЕЗАПУСТИ процес "
    + "(dotenv читає файл лише на старті: змінити .env без рестарту недостатньо)");
});

/**
 * #116b — КРАХ І ВИКАТ РОЗРІЗНЯЮТЬСЯ ЗА sha (рішення власника 21.08.2026).
 *
 * 🔴 Без цього кожен наш деплой слав би «застосунок упав» — тобто кілька
 * фальшивих аварій на тиждень. Алерт, який регулярно бреше, вимикають, і разом із
 * ним вимикають справжні.
 *
 * 🧨 САБОТАЖ (виконано): повернути `crash` для будь-якого рестарту → друга
 * перевірка червоніє.
 */
test("#116b рестарт із НОВИМ sha — це викат, а не падіння", () => {
  assert.equal(classifyBoot("aaa", "aaa"), "crash",
    "🔴 рестарт на тому самому коді не визнано падінням — саме його ми й ловимо");
  assert.equal(classifyBoot("aaa", "bbb"), "deploy",
    "🔴 плановий викат подано як падіння — кожен деплой слав би фальшиву аварію");
  assert.equal(classifyBoot(null, "aaa"), "first",
    "🔴 перший старт (журнал порожній) визнано падінням — тривога на порожньому місці");
  assert.equal(classifyBoot(undefined, "aaa"), "first");
});

/**
 * #135 — НАШ ВЛАСНИЙ ВИКАТ НЕ Є АВАРІЄЮ (рішення власника 23.08.2026).
 *
 * 🔴 ПРИВІД, ЗАМІРЯНИЙ НА ПРОДІ 23.08. Наш деплой sha не міняє (збірка на місці +
 * `kill -TERM` + респавн конвеєром), тож `app_boot` за добу показав `deploy 1,
 * crash 17` — і кожен викат приходив користувачам банером «АВАРІЯ».
 *
 * 🧨 САБОТАЖ (виконано): прибрати гілку наміру з `classifyBoot` → червоніє перша
 * ж перевірка з назвою «намір не врахований».
 */
test("#135 заявлений намір робить рестарт на тому самому sha викатом", () => {
  const now = new Date("2026-08-23T12:00:00Z");
  const live = { expiresAt: new Date("2026-08-23T12:10:00Z") };
  assert.equal(classifyBoot("aaa", "aaa", live, now), "deploy-intent",
    "🔴 намір не врахований — наш власний викат далі приходить як аварія");
  assert.equal(classifyBoot("aaa", "bbb", live, now), "deploy",
    "🔴 намір не має підміняти звичайний викат зі зміненим sha");
});

/**
 * #135b — ДЗЕРКАЛО: БЕЗ НАМІРУ РЕСТАРТ ЛИШАЄТЬСЯ АВАРІЄЮ.
 *
 * 🔴 Без цієї пари #135 зеленів би й тоді, коли тривогу вимкнено ЗОВСІМ: «наш
 * викат мовчить» і «мовчить усе» — це те саме зелене. Односторонній тест тут
 * особливо небезпечний, бо ціна помилки — невидима аварія.
 *
 * 🧨 САБОТАЖ (виконано): зробити `classifyBoot` завжди тихою → червоніє.
 */
test("#135b без наміру той самий sha — це падіння", () => {
  const now = new Date("2026-08-23T12:00:00Z");
  assert.equal(classifyBoot("aaa", "aaa", null, now), "crash",
    "🔴 рестарт без наміру визнано викатом — справжня аварія стала невидимою");
  assert.equal(classifyBoot("aaa", "aaa", undefined, now), "crash",
    "🔴 відсутній аргумент має означати «наміру не було», а не «мовчимо»");
  assert.equal(classifyBoot(null, "aaa", null, now), "first",
    "🔴 перший старт не є падінням");
});

/**
 * #135c — ПРОТЕРМІНОВАНИЙ НАМІР НЕ ГЛУШИТЬ.
 *
 * 🔴 Намір без чинної стелі — це in-process прапорець, що застряг: рівно те, що
 * 10.08.2026 коштувало 14 год 52 хв простою («успіх за 0 мс»). Поки він стоїть,
 * аварії не видно, і про це ніхто не дізнається.
 *
 * ⚠️ Саме заради цієї перевірки `classifyBoot` бере `now` параметром: інакше її
 * довелося б писати очікуванням у реальному часі, тобто не писати взагалі.
 *
 * 🧨 САБОТАЖ (виконано): прибрати порівняння з `expiresAt` → червоніє.
 */
test("#135c намір зі спливлою стелею не глушить тривогу", () => {
  const now = new Date("2026-08-23T12:00:00Z");
  const dead = { expiresAt: new Date("2026-08-23T11:59:59Z") };
  assert.equal(classifyBoot("aaa", "aaa", dead, now), "crash",
    "🔴 протермінований намір усе ще глушить — прапорець без стелі, аварія невидима");
  const edge = { expiresAt: now };
  assert.equal(classifyBoot("aaa", "aaa", edge, now), "crash",
    "🔴 намір, що спливає РІВНО зараз, має вважатись мертвим, а не живим");
  assert.ok(DEPLOY_INTENT_MIN > 0 && DEPLOY_INTENT_MIN <= 60,
    "🔴 стеля наміру поза розумними межами — намір на пів доби це вікно сліпоти");
});

/**
 * #135f — «ВПАЛО РАЗ» І «ПАДАЄ ЩОХВИЛИНИ» МУСЯТЬ ЧИТАТИСЬ ПО-РІЗНОМУ
 * (рішення власника 23.08.2026).
 *
 * 📐 ЗАМІРЯНО НА ПРОДІ 23.08: `app_boot` id 9…24 — 16 стартів за 16 хвилин, рівно
 * раз на хвилину. Банер брав ОСТАННІЙ рядок і тільки його, тож на екрані це
 * виглядало точнісінько як одиничний рестарт: той самий заголовок, той самий
 * текст. Петля була невидима не тому, що даних бракувало, а тому, що їх не читали.
 *
 * 🧨 САБОТАЖ (виконано): звести `summarizeRestarts` до «завжди single» → червоніє
 * перевірка петлі; підняти поріг вище 16 → червоніє вона ж.
 */
test("#135f петля рестартів відрізняється від одиничного падіння", () => {
  assert.equal(summarizeRestarts(1, 0).kind, "single",
    "🔴 один рестарт подано як петлю — банер кричатиме про петлю на кожному падінні");
  assert.equal(summarizeRestarts(2, 5).kind, "repeat",
    "🔴 два рестарти — це вже не «одиничний», але ще не петля");

  // Той самий випадок, що був на проді.
  const real = summarizeRestarts(16, 16);
  assert.equal(real.kind, "loop",
    "🔴 16 рестартів за 16 хв не визнано петлею — саме це ми й пропустили 23.08");
  assert.equal(real.perHour, 56,
    "🔴 частота порахована по ПОДІЯХ, а не по проміжках — коротке вікно її завищує");

  assert.equal(summarizeRestarts(BOOT_LOOP_MIN, 3).kind, "loop", "🔴 поріг петлі не діє");
  assert.equal(summarizeRestarts(BOOT_LOOP_MIN - 1, 3).kind, "repeat",
    "🔴 нижче порога вже вважається петлею — межа зсунута");

  assert.equal(summarizeRestarts(1, 0).perHour, null,
    "🔴 в однієї точки немає частоти — вигадане число гірше за «невідомо»");
  assert.equal(summarizeRestarts(5, 0).perHour, null,
    "🔴 нульовий проміжок дав частоту — це ділення на нуль, а не заміряний темп");
});

/**
 * #135g — БАНЕР СПРАВДІ КОРИСТУЄТЬСЯ ЦИМ ПРАВИЛОМ, А НЕ МАЄ ВЛАСНОЇ КОПІЇ.
 *
 * 🔴 Чисте правило, яке ніхто не кличе, — це мертвий код, що виглядає як робочий
 * (урок `expected` у /teams і чипів «новий/постійний», де копія збігалася з ІНШОЮ
 * копією, а не з правилом). Тому перевіряємо ДЖЕРЕЛО перевірки здоровʼя.
 *
 * 🧨 САБОТАЖ (виконано): прибрати виклик `summarizeRestarts` із `checkAppBoot` →
 * червоніє.
 */
test("#135g checkAppBoot рахує петлю ядром, а не власним підрахунком", () => {
  const src = readSrc("src/health/alerts.ts");
  assert.match(src, /summarizeRestarts/,
    "🔴 банер не кличе `summarizeRestarts` — правило петлі живе двічі або не живе взагалі");
  assert.match(src, /app:restart-loop/,
    "🔴 у банера немає окремого стану петлі — вона знову читається як одиничний рестарт");
  assert.ok(!/isPointEvent\(["\`']app:restart-loop/.test(src),
    "🔴 петлю позначено точковою подією — тоді «петля припинилась» ніхто не скаже");
});

/** Тривалість інциденту має читатись людиною, а не бути «0 хв» чи «187 хв». */
test("#113c тривалість інциденту подається по-людськи", () => {
  assert.equal(humanDuration(5_000), "1 хв", "🔴 миттєвий інцидент показано як «0 хв»");
  assert.equal(humanDuration(45 * 60_000), "45 хв");
  assert.equal(humanDuration(3 * 3600_000), "3 год");
  assert.equal(humanDuration(3.5 * 3600_000), "3 год 30 хв");
  assert.match(humanDuration(50 * 3600_000), /^2 дн/);
  assert.match(formatResolved("Джоба мовчить", new Date(Date.now() - 90 * 60_000)), /1 год 30 хв/);
});

/** Інтервал повтору — параметр, а не число в тексті; `build:stale` наполегливіший. */
test("#112c інтервал повтору береться з правила, а не зашитий", () => {
  assert.equal(repeatAfterMin("sync:stale"), REPEAT_AFTER_MIN);
  assert.equal(repeatAfterMin("job:syncKommo:error"), REPEAT_AFTER_MIN);
  assert.equal(repeatAfterMin("build:stale"), 30,
    "🔴 build:stale повторюється раз на 6 год — нагадування прийшло б після того, як вікно викату минуло");
  assert.ok(repeatAfterMin("build:stale") < REPEAT_AFTER_MIN);
});

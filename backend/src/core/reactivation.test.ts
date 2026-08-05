import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * #25 — ІНТЕГРАЦІЙНИЙ ТЕСТ `clientStates` ПРОТИ СПРАВЖНЬОЇ БД.
 *
 * 🔴 НАВІЩО САМЕ ЦЕЙ ТЕСТ І САМЕ ЗАРАЗ. Дірку я назвав сам: жоден тест не ганяв
 * `clientStates` проти бази, тож `$TK`/`$TC` у шаблонному рядку JS (літерали, а
 * не підстановка) доїхали аж до пісочниці — SQL падав із «syntax error at or
 * near $», а локальний набір лишався зеленим. Юніт-тести чистих правил (#23)
 * такого не бачать у принципі: вони не виконують запит.
 *
 * Тому тут перевіряється не арифметика, а те, що ЗАПИТ ВИКОНУЄТЬСЯ І ВІДДАЄ ТЕ,
 * ЩО ТРЕБА, на контрольованих даних, де кожну цифру видно руками.
 *
 * ⚙️ Одноразовий кластер (`provisionScratch`). На прод-сервері бінарів PG немає —
 * там тест чесно пропускається з названою причиною.
 */

/**
 * ⚠️ ОДИН КЛАСТЕР НА ВЕСЬ ФАЙЛ, і це не оптимізація. `db/pool.js` — модульний
 * синглтон: він створюється на ПЕРШОМУ імпорті з тим `DATABASE_URL`, що був тоді.
 * Перша версія піднімала окремий кластер на кожен тест — і другий та третій
 * падали з «Connection terminated unexpectedly», бо пул дивився на вже знищену
 * базу. Тому: один `provisionScratch`, три підтести, спільний seed.
 */

const SCHEMA = path.join(import.meta.dirname, "..", "db", "schema.sql");
const DAY = 86400000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

/** Готує базу з клієнтами під КОЖЕН стан + задачі обох типів. */
async function seed(c: import("pg").Client): Promise<void> {
  await c.query(readFileSync(SCHEMA, "utf8"));
  await c.query(`INSERT INTO teams (id,name) VALUES (1,'РПК'),(2,'РНК') ON CONFLICT DO NOTHING`);
  await c.query(`INSERT INTO managers (id,name,team_id,is_active) VALUES
      (10,'Менеджер А',1,true), (20,'Менеджер Б',2,true) ON CONFLICT DO NOTHING`);
  await c.query(`INSERT INTO pipeline_stage_map (pipeline_id,status_id,funnel_stage)
      VALUES (8921932,142,'paid') ON CONFLICT DO NOTHING`);

  // Кожен клієнт — ТРИ оплати, різна давність ОСТАННЬОЇ.
  //
  // 🔴 ЧОМУ ТРИ, А НЕ ДВІ (як було). Двошляхова кваліфікація власника (05.08.2026)
  // визнає постійним безнал із 2 оплатами ЛИШЕ за ритмом ≤30 днів. У сіді інтервал
  // 400 днів і форма оплати не проставлена — тобто всі ці клієнти стали б РАЗОВИМИ,
  // і кожен тест про стани перевіряв би порожній список. Третя оплата дає
  // кваліфікацію «3+ за історію», не чіпаючи ДАТУ ОСТАННЬОЇ — а саме вона й
  // визначає стан, який ці тести перевіряють.
  //
  // ⚠️ Інтервали 200/200 → медіана 200 → сегмент `episodic`, поріг сплячого 60 —
  // той самий, що був у `unknown`. Тому межі 59/60/179/180 нижче лишились чинними.
  const clients: [string, string, number, number, number][] = [
    // ключ,                назва,          менеджер, днів тому, ціна
    ["активний",           "ТОВ Активний",   10,  10, 5000],
    ["сплячий",            "ТОВ Сплячий",    10,  70, 9000],
    ["втрачений",          "ТОВ Втрачений",  10, 200, 3000],
    ["межа59",             "ТОВ Межа59",     10,  59, 1000],
    ["межа60",             "ТОВ Межа60",     10,  60, 1000],
    ["межа179",            "ТОВ Межа179",    10, 179, 1000],
    ["межа180",            "ТОВ Межа180",    10, 180, 1000],
    ["чужий",              "ТОВ Чужий",      20,  70, 7000],
    ["пачковий",           "ТОВ Пачковий",   10,  90, 4000],
    ["сезонний",           "ТОВ Сезонний",   10, 120, 8000],
  ];
  let id = 1;
  for (const [key, name, mgr, ago, price] of clients) {
    for (const [i, when] of [ago + 400, ago + 200, ago].entries()) {
      await c.query(
        `INSERT INTO deals (kommo_id,name,manager_id,pipeline_id,status_id,price,client_key,client_key_raw,client_name,closed_at_kommo)
         VALUES ($1,'d',$2,8921932,142,$3,$4,$4,$5,$6)`,
        [id++, mgr, i === 2 ? price : 1, key, name, daysAgo(when)]);
    }
  }
  await c.query(`INSERT INTO loyalty_overrides (client_key, seasonal, seasonal_note) VALUES ('сезонний', true, 'зерно')`);
}

test("#25 clientStates ВИКОНУЄТЬСЯ проти БД і дає стани з ДАТ", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(scratch.unavailable);
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET ??= "test";
  process.env.KOMMO_BASE_URL ??= "https://x.invalid";
  process.env.KOMMO_API_TOKEN ??= "x";
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  const { pool } = await import("../db/pool.js");
  try {
    await seed(c);
    const R = await import("./reactivation.js");

    const rows = await R.clientStates({});
    const by = new Map(rows.map((r) => [r.clientKey, r]));

    // 🔴 Найголовніше: запит ВИКОНАВСЯ. Саме цього бракувало, коли `$TK` доїхав
    // до пісочниці — тоді тут був би виняток, а не порожній результат.
    assert.ok(rows.length > 0, "🔴 порожньо — це ПРОВАЛ, а не «немає даних»: клієнтів засіяно 10");
    assert.equal(rows.length, 10, "мали повернутись усі 10 постійних клієнтів");

    assert.equal(by.get("активний")?.state, "active");
    assert.equal(by.get("сплячий")?.state, "sleeping");
    assert.equal(by.get("втрачений")?.state, "lost");
    // Межі — на ЖИВОМУ запиті, а не лише в чистій функції: між ними ще стоїть
    // обчислення days_since у SQL по-київськи, і воно теж може поїхати.
    assert.equal(by.get("межа59")?.state, "active", "59 днів — ще постійний");
    assert.equal(by.get("межа60")?.state, "sleeping", "рівно 60 — уже сплячий");
    assert.equal(by.get("межа179")?.state, "sleeping", "179 — ще сплячий");
    assert.equal(by.get("межа180")?.state, "lost", "рівно 180 — уже втрачений");

    assert.equal(by.get("сезонний")?.seasonal, true);
    assert.equal(by.get("сезонний")?.seasonalNote, "зерно");
    assert.equal(by.get("активний")?.seasonal, false, "позначка не має протікати на інших");

    // Ранжування за цінністю рахує ядро — перевіряємо, що дані для нього справжні.
    const sleep = by.get("сплячий")!;
    assert.equal(sleep.orders, 3);
    assert.equal(sleep.lifetimeRevenue, 9002, "3 оплати: 9000 + 1 + 1");
    assert.ok(sleep.value > 0 && sleep.value < sleep.lifetimeRevenue,
      "свіжість має ЗМЕНШУВАТИ вагу сплячого, інакше сортування зведеться до виручки");
    assert.equal(by.get("активний")!.managerName, "Менеджер А");

    await t.test("#25b СКОУП: менеджер бачить своїх, команда — свою", async () => {

      const mine = await R.clientStates({ managerId: 10 });
      const theirs = await R.clientStates({ managerId: 20 });
      const team2 = await R.clientStates({ teamId: 2 });
      assert.equal(mine.length, 9, "у Менеджера А — девʼять клієнтів");
      assert.equal(theirs.length, 1, "у Менеджера Б — один");
      assert.equal(theirs[0].clientKey, "чужий");
      assert.equal(team2.length, 1, "команда РНК бачить лише свого");
      // ДЗЕРКАЛО: без скоупу видно ВСІХ. Без цієї половини тест зеленів би й тоді,
      // коли фільтр ріже все підряд.
      assert.equal((await R.clientStates({})).length, 10, "🔴 без скоупу мають бути ВСІ");

    });

    await t.test("#25c ЗАДАЧІ ОБОХ ТИПІВ і «повернено» — на живому запиті", async () => {

      // (а) задача на ОДНОГО клієнта
      await c.query(
        `INSERT INTO tasks (title,status,assignee_id,task_type,client_key,created_at)
         VALUES ('Реактивація','in_progress',10,'reactivation_client','сплячий',$1)`, [daysAgo(30)]);
      // (б) стара ПАЧКА з чеклістом — і ключ у ній зі СТАРОЮ нормалізацією (з пробілом).
      // Саме такі 16 із 94 і не зіставлялись напряму на проді.
      await c.query(
        `INSERT INTO tasks (title,status,assignee_id,task_type,checklist_json,created_at)
         VALUES ('Кампанія','in_progress',10,'reactivation',$1::jsonb,$2)`,
        [JSON.stringify([{ clientKey: "пачко вий", clientName: "ТОВ Пачковий", done: false }]), daysAgo(40)]);
      // оплата ПІСЛЯ створення пачкової задачі → клієнт «повернений»
      await c.query(
        `INSERT INTO deals (kommo_id,name,manager_id,pipeline_id,status_id,price,client_key,client_key_raw,client_name,closed_at_kommo)
         VALUES (9001,'d',10,8921932,142,12345,'пачковий','пачковий','ТОВ Пачковий',$1)`, [daysAgo(5)]);

      const map = await R.reactivationTasksByClient();
      assert.ok(map.has("сплячий"), "🔴 задача типу (а) не знайшлась");
      assert.ok(map.has("пачковий"),
        "🔴 ключ «пачко вий» із чекліста не звівся до «пачковий» — саме ці 16 із 94 і губились би");

      const rows = await R.clientStates({});
      const by = new Map(rows.map((r) => [r.clientKey, r]));
      assert.ok(by.get("сплячий")?.taskId, "задача має причепитись до клієнта");
      assert.equal(by.get("сплячий")?.taskStatus, "in_progress");
      assert.equal(by.get("пачковий")?.returned, true, "оплата після задачі → повернений");
      assert.equal(by.get("пачковий")?.returnedRevenue, 12345);
      assert.equal(by.get("активний")?.taskId, null, "клієнт без задачі не має її підхопити");

      const ret = await R.returnedAfterTask(30, {});
      assert.equal(ret.clients, 1, "повернувся рівно один");
      assert.equal(ret.revenue, 12345);
      // ДЗЕРКАЛО: вікно працює. Без нього метрика могла б рахувати «за весь час».
      assert.equal((await R.returnedAfterTask(1, {})).clients, 0,
        "🔴 оплата 5 днів тому потрапила у вікно «за 1 день» — вікно не застосовується");

    });

    await t.test("#25d КОНТАКТ = РОЗМОВА, спроби окремо; стан лишається від ОПЛАТИ", async () => {
      // 🔴 Питання, на яке відповідає цей підтест: чи можна тепер побудувати
      // ієрархію (потрібна команда в КОЖНОМУ рядку) і чи не почав дзвінок
      // впливати на стан. Друге важливіше за перше: саме тут найлегше «покращити»
      // логіку до «дзвонили → значить активний», і ніхто б цього не помітив.
      // 🟢 КОНТАКТ = РОЗМОВА (billsec>0), недодзвони — окремо як «спроби».
      // У «сплячого»: розмова 40 дн. тому, після неї ДВА недодзвони (3 і 5 дн.).
      // Саме та картина, заради якої правило й уводилось: контакту немає вже 40
      // днів, але менеджер працює — і одна цифра про це збрехала б.
      await c.query(
        `INSERT INTO ringostat_calls (uniqueid, calldate, call_type, disposition, billsec, duration, client_key)
         VALUES ('c1',$1,'out','NO ANSWER',0,12,'сплячий'),
                ('c2',$2,'in','ANSWERED',95,120,'сплячий'),
                ('c3',$3,'out','NO ANSWER',0,8,'втрачений'),
                ('c4',$4,'out','NO ANSWER',0,10,'сплячий'),
                ('c5',$5,'out','ANSWERED',31,40,'межа60'),
                -- 🔴 НЕДОДЗВІН ДО РОЗМОВИ. Без цього рядка дзеркало (д) було СЛІПЕ:
                -- саботаж «рахувати спроби за все життя, а не після розмови» не
                -- червонів, бо в даних просто не було спроби ПЕРЕД розмовою.
                -- Виявлено саботажем; дані виправлено, а не твердження послаблено.
                ('c6',$6,'out','NO ANSWER',0,7,'межа60')`,
        [daysAgo(3), daysAgo(40), daysAgo(2), daysAgo(5), daysAgo(200), daysAgo(210)]);

      const rows = await R.clientStates({});
      const by = new Map(rows.map((r) => [r.clientKey, r]));

      // (а) КОМАНДА є в кожного — інакше дерево провалюється в порожній вузол.
      assert.deepEqual(rows.filter((r) => !r.teamName).map((r) => r.clientKey), [],
        "🔴 є рядки без назви команди — ієрархія «команда → менеджер» не побудується");
      assert.equal(by.get("сплячий")?.teamName, "РПК");
      assert.equal(by.get("чужий")?.teamName, "РНК", "команда береться з ВІДПОВІДАЛЬНОГО менеджера");

      // (б) 🟢 КОНТАКТ = РОЗМОВА. Недодзвін 3 дні тому НЕ має стати «контактом» —
      // інакше екран звітував би про розмову, якої не було.
      const sleep = by.get("сплячий")!;
      assert.equal(sleep.lastTalkDays, 40,
        "🔴 як «контакт» узято недодзвін — контактом вважається лише розмова (billsec>0)");
      assert.equal(sleep.lastTalkDirection, "in");
      // Спроби — ті недодзвони, що ПІСЛЯ розмови, і рахуються окремо.
      assert.equal(sleep.attempts, 2, "🔴 недодзвони після розмови не порахувались як спроби");
      assert.equal(sleep.lastAttemptDays, 3, "🔴 остання спроба — найсвіжіший недодзвін");

      // (в) 🔴 ГОЛОВНЕ: ані розмова, ані спроби не зрушили стан.
      assert.equal(sleep.state, "sleeping",
        "🔴 стан поїхав за дзвінком — рахувати треба ВИКЛЮЧНО від останньої оплати");
      assert.equal(sleep.daysSince, 70, "анкер стану — оплата, і він не зрушив");

      // (г) ДЗЕРКАЛО №1: клієнт БЕЗ дзвінків лишається у списку з чесним null.
      // Без цієї половини тест зеленів би й тоді, якби JOIN викидав усіх, кому
      // дзвінок не знайшовся, — а це саме ті, кого треба реактивувати.
      const noCalls = by.get("активний")!;
      assert.equal(noCalls.lastTalk, null, "розмов немає → null, а не вигадана дата");
      assert.equal(noCalls.attempts, 0);
      assert.equal(rows.length, 10, "🔴 хтось зник зі списку через LEFT JOIN дзвінків");

      // (д) ДЗЕРКАЛО №2: клієнт, у якого Є розмова і НЕМАЄ недодзвонів після неї,
      // мусить показати контакт і НУЛЬ спроб. Без цього «спроби» могли б рахувати
      // всі недодзвони за життя і світитись у всіх підряд.
      const talkOnly = by.get("межа60")!;
      assert.equal(talkOnly.lastTalkDays, 200, "🔴 розмова не знайшлась");
      assert.equal(talkOnly.attempts, 0,
        "🔴 порахована спроба, що була ДО розмови — вікно «після контакту» не застосовується");
      // І дзеркало до «спроб без розмови»: у «втраченого» розмов немає ЗОВСІМ,
      // тож недодзвін має піти у спроби, а контакт лишитись порожнім.
      const noTalk = by.get("втрачений")!;
      assert.equal(noTalk.lastTalk, null, "🔴 недодзвін підмінив собою контакт");
      assert.equal(noTalk.attempts, 1, "🔴 без жодної розмови спроби мають рахуватись усі");
    });

    await t.test("#25f СЕГМЕНТИ: поріг залежить від частоти, <3 оплат — НЕ вгадуємо", async () => {
      // 🔴 ГОЛОВНЕ, ЩО ТУТ ПЕРЕВІРЯЄТЬСЯ: правило сегментів доїжджає до рядка
      // екрана ЦІЛИМ — від оплат у `deals` до `segment`/`state` у видачі ядра.
      //
      // ⚠️ Спершу тут стояла звірка «SQL проти чистої функції»: умова жила двічі —
      // `CASE` у спільному SQL-фрагменті і `segmentOf`/`stateOf` у TS. Двом
      // редакціям правила потрібен сторож. Тепер редакція ОДНА (SQL віддає лише
      // факти: скільки оплат, медіанний інтервал, скільки днів мовчить), тож
      // звіряти нема чого — і замість вигаданого дзеркала перевіряємо, що стан
      // рядка узгоджений із його ж сегментом і давністю.
      const R2 = await import("./reactivationRules.js");
      // ВІП: 4 оплати з інтервалом 5 днів, остання 20 днів тому → сплячий (поріг 14).
      const mk = async (id: number, key: string, gaps: number[], lastAgo: number) => {
        let day = lastAgo;
        for (let i = 0; i < gaps.length + 1; i++) {
          await c.query(
            `INSERT INTO deals (kommo_id,name,manager_id,pipeline_id,status_id,price,client_key,client_key_raw,client_name,closed_at_kommo)
             VALUES ($1,'d',10,8921932,142,1000,$2,$2,$2,$3)`, [id + i, key, daysAgo(day)]);
          day += gaps[i] ?? 30;
        }
      };
      await mk(500, "віп", [5, 5, 5], 20);        // медіана 5 → vip, 20 дн. ≥ 14 → сплячий
      await mk(510, "регулярний", [20, 20, 20], 20); // медіана 20 → regular, 20 < 30 → активний
      await mk(520, "епізодичний", [90, 90, 90], 40);// медіана 90 → episodic, 40 < 60 → активний

      const rows = await R.clientStates({});
      const by = new Map(rows.map((r) => [r.clientKey, r]));

      assert.equal(by.get("віп")?.segment, "vip", "🔴 4 оплати кожні 5 днів — це ВІП");
      assert.equal(by.get("віп")?.state, "sleeping",
        "🔴 ВІП мовчить 20 днів і НЕ в реактивації — поріг сегмента не застосувався");
      assert.equal(by.get("регулярний")?.segment, "regular");
      assert.equal(by.get("регулярний")?.state, "active",
        "🔴 регулярний на 20-й день не має бути сплячим (його поріг 30)");
      assert.equal(by.get("епізодичний")?.segment, "episodic");
      assert.equal(by.get("епізодичний")?.state, "active",
        "🔴 епізодичний на 40-й день не має бути сплячим (його поріг 60)");

      // 🔴 <3 ОПЛАТ — СЕГМЕНТ НЕ ВГАДУЄМО. Саме тут при порозі «2+» дві оплати з
      // різницею 3 дні робили клієнта «ВІП» назавжди (на проді 488 таких).
      // Клієнт заводиться ТУТ, а не береться із сіду: сідові мають по три оплати,
      // щоб проходити кваліфікацію, тож випадку «рівно дві» в них більше немає.
      await mk(560, "дваблизько", [3], 5);   // 2 оплати з різницею 3 дні
      const two = (await R.clientStates({})).find((r) => r.clientKey === "дваблизько")!;
      assert.ok(two, "🔴 безнал… точніше клієнт із 2 оплатами за 3 дні мав кваліфікуватись");
      assert.equal(two.segment, "unknown",
        "🔴 сегмент поставлено по ОДНОМУ інтервалу — саме той артефакт, через який ВІП роздувався");

      // Стан КОЖНОГО рядка узгоджений із його сегментом і давністю — тобто ніхто
      // нижче по дорозі не переписав `state` чимось іншим (дзвінком, знімком).
      for (const r of rows) {
        assert.equal(r.state, R2.stateOf(r.daysSince, r.segment),
          `🔴 стан рядка «${r.clientKey}» не випливає з його сегмента (${r.segment}, ${r.daysSince} дн.)`);
      }
      // 🔴 І ДОКАЗ, ЩО ПЕРЕВІРКА ВИЩЕ НЕ ПОРОЖНЯ: сеґментний поріг мусить хоч
      // одного клієнта розводити зі старим єдиним порогом 60. Інакше цикл був би
      // зеленим і тоді, коли сегменти взагалі не застосовуються.
      assert.ok(rows.some((r) => R2.stateOf(r.daysSince, r.segment) !== R2.stateOf(r.daysSince)),
        "🔴 сегментний поріг не змінив стан ЖОДНОГО рядка — цикл вище нічого не доводить");
    });

    await t.test("#25g КВАЛІФІКАЦІЯ ≠ СЕГМЕНТ: 2 оплати підряд — постійний без сегмента", async () => {
      // 🔴 ДВА ВИПАДКИ, НАЗВАНІ ВЛАСНИКОМ ПОІМЕННО, і саме вони найлегше плутаються:
      //  (1) 2 оплати з інтервалом ≤30 дн. (безнал) — КВАЛІФІКУЄТЬСЯ, але сегмент
      //      `unknown`: медіана по ОДНОМУ інтервалу — це не частота. Поріг 60.
      //  (2) 6 оплат раз на 2 місяці — Епізодичний, поріг 60, і точно НЕ разовий.
      // Плюс дзеркало: 2 оплати ГОТІВКОЮ з тим самим інтервалом — разовий. Без нього
      // тест зеленів би й тоді, коли кваліфікуються геть усі.
      const R2 = await import("./reactivationRules.js");
      const mk = async (id: number, key: string, gaps: number[], lastAgo: number, pay: string) => {
        let day = lastAgo;
        for (let i = 0; i < gaps.length + 1; i++) {
          await c.query(
            `INSERT INTO deals (kommo_id,name,manager_id,pipeline_id,status_id,price,client_key,client_key_raw,client_name,closed_at_kommo,payment_type)
             VALUES ($1,'d',10,8921932,142,1000,$2,$2,$2,$3,$4)`, [id + i, key, daysAgo(day), pay]);
          day += gaps[i] ?? 30;
        }
      };
      await mk(600, "двабезнал", [20], 5, "Безнал с НДС");   // 2 оплати, інтервал 20 дн.
      await mk(610, "двабезналдалеко", [200], 5, "Безнал с НДС"); // 2 оплати, інтервал 200 дн.
      await mk(620, "дваготівка", [20], 5, "Наличные");       // 2 оплати готівкою
      // РІВНО дві оплати різними формами: 1 готівка + 1 безнал, інтервал 20 днів.
      // Якби їх було три, кваліфікація спрацювала б за «3+ за історію» — і правило
      // про змішані форми лишилось би неперевіреним.
      await c.query(
        `INSERT INTO deals (kommo_id,name,manager_id,pipeline_id,status_id,price,client_key,client_key_raw,client_name,closed_at_kommo,payment_type)
         VALUES (630,'d',10,8921932,142,1000,'змішаний','змішаний','змішаний',$1,'Наличные'),
                (631,'d',10,8921932,142,1000,'змішаний','змішаний','змішаний',$2,'Безнал без НДС')`,
        [daysAgo(25), daysAgo(5)]);
      await mk(640, "разнадва", [60, 60, 60, 60, 60], 10, "Безнал с НДС"); // 6 оплат раз на 2 міс.

      const by = new Map((await R.clientStates({})).map((r) => [r.clientKey, r]));

      const two = by.get("двабезнал");
      assert.ok(two, "🔴 безнал із 2 оплатами за 20 днів МАЄ кваліфікуватись — правило власника");
      assert.equal(two!.segment, "unknown",
        "🔴 сегмент вгадано по ОДНОМУ інтервалу — кваліфікація і сегмент це РІЗНІ питання");
      assert.equal(two!.state, "active", "🔴 поріг для `unknown` — 60 днів, а оплата 5 днів тому");

      const six = by.get("разнадва");
      assert.ok(six, "🔴 6 оплат раз на 2 місяці — це точно НЕ разовий");
      assert.equal(six!.segment, "episodic", "🔴 медіана 60 днів — це Епізодичний");
      assert.equal(R2.SEGMENT_SLEEPING_DAYS[six!.segment], 60, "🔴 поріг епізодичного має бути 60");

      // 🪞 ДЗЕРКАЛО: хто НЕ проходить — на екрані його немає.
      assert.equal(by.get("дваготівка"), undefined,
        "🔴 готівка з 2 оплатами кваліфікувалась — для готівки правило 3+, а не 2+");
      assert.equal(by.get("двабезналдалеко"), undefined,
        "🔴 безнал із 2 оплатами через 200 днів кваліфікувався — ритму 30 днів немає");
      assert.ok(by.get("змішаний"),
        "🔴 змішані форми мають рахуватись за БЕЗНАЛЬНИМ правилом: 1 готівка + 1 безнал "
        + "з інтервалом 20 днів — це постійний, а не разовий");
    });

    await t.test("#37 ДЕАКТИВАЦІЯ не змінює історичних сум (відділ · команда · менеджер · чек)", async () => {
      // 🔴 ЦЕ НЕ ГІПОТЕТИЧНИЙ ІНВАРІАНТ, А ІНЦИДЕНТ 05.08.2026. Менеджера
      // деактивували в Kommo, а його угоди перепризначили лише за пів години. У цю
      // щілину `Σ(менеджери)` стала на **16 567 ₴** менша за `Σ(команди)`: по
      // менеджерах фільтр `is_active` стояв, по командах — ні. Пів години звіт
      // показував гроші, яких «немає», хоча вони зароблені.
      // Рішення власника: `is_active` керує СПИСКАМИ Й ВИБОРОМ, не історичними сумами.
      //
      // ⚠️ Тест живе ТУТ, а не в окремому файлі, і це не лінощі: `db/pool.js` —
      // модульний синглтон, тож ДРУГИЙ `provisionScratch` в іншому файлі забирає
      // базу в усіх, хто вже підключився. Перевірено дією: окремий файл поклав 13
      // тестів. Один кластер на прогін — умова, а не стиль.
      const M = await import("./money.js");
      // Власний менеджер і власне вікно: беремо місяць, куди не потрапляє сід,
      // тож суми складаються ЛИШЕ з угод цього підтесту.
      await c.query(`INSERT INTO managers (id,name,team_id,is_active) VALUES (30,'Звільнять',1,true)
                     ON CONFLICT (id) DO UPDATE SET is_active = true`);
      const base = 1100;
      let kid = 700;
      // ⚠️ Ключ клієнта — ОКРЕМИМ параметром, не `'ф'||$1`: Postgres не може вивести
      // тип для $1, який одночасно є `bigint` (kommo_id) і операндом конкатенації.
      for (const price of [5000, 3000, 7000, 1500]) {
        const k = `ф${kid}`;
        await c.query(
          `INSERT INTO deals (kommo_id,name,manager_id,pipeline_id,status_id,price,client_key,client_key_raw,client_name,closed_at_kommo)
           VALUES ($1,'d',30,8921932,142,$2,$3,$3,'ТОВ Ф',$4)`, [kid++, price, k, daysAgo(base)]);
      }
      const d0 = daysAgo(base + 3).toISOString().slice(0, 10);
      const d1 = daysAgo(base - 3).toISOString().slice(0, 10);
      const S = { from: d0, to: d1 };

      const snap = async () => {
        const [tot, mgr, team, chk] = await Promise.all([
          M.successMoney(S), M.successByMgr(S), M.successByTeam(S), M.avgCheck("success", S)]);
        return { total: tot.revenue, mgr: mgr.reduce((a, x) => a + x.revenue, 0),
                 team: team.reduce((a, x) => a + x.revenue, 0), avg: chk.avgCheck,
                 rows: mgr.map((x) => `${x.managerId}:${x.revenue}`).sort().join(",") };
      };
      const before = await snap();
      assert.equal(before.total, 16500, "🔴 сід підтесту не дав очікуваних 16 500 ₴ — перевіряти нема чого");
      assert.equal(before.mgr, before.total, "🔴 ще ДО деактивації Σ(менеджери) ≠ відділу");
      assert.equal(before.team, before.total, "🔴 ще ДО деактивації Σ(команди) ≠ відділу");

      await c.query(`UPDATE managers SET is_active = false WHERE id = 30`);
      const after = await snap();
      assert.equal(after.total, before.total, "🔴 сума відділу змінилась від деактивації");
      assert.equal(after.mgr, before.mgr,
        `🔴 Σ(менеджери) впала з ${before.mgr} до ${after.mgr} — це і є розрив на 16 567 ₴`);
      assert.equal(after.team, before.team, "🔴 Σ(команди) змінилась від деактивації");
      assert.equal(after.avg, before.avg, "🔴 середній чек змінився від деактивації");
      assert.equal(after.rows, before.rows, "🔴 розріз по менеджерах змінився — звільнений зник із грошима");

      // 🪞 ДЗЕРКАЛО: ознака звільнення ДОЇХАЛА до рядка. Без неї цифри були б чесні,
      // але екран показував би звільненого як діючого.
      const rows = await M.successByMgr(S);
      const gone = rows.find((x) => x.managerId === 30);
      assert.ok(gone, "🔴 звільнений зник із розрізу — суми зійшлись би лише випадково");
      assert.equal(gone!.isActive, false, "🔴 у рядку немає ознаки звільнення — підписати нічим");
      await c.query(`DELETE FROM deals WHERE manager_id = 30`);
      await c.query(`DELETE FROM managers WHERE id = 30`);
    });

    await t.test("#25e «ПРИБРАТИ З ПОСТІЙНИХ» СПРАВДІ ПРИБИРАЄ (і повертає назад)", async () => {
      // 🔴 РЕГРЕС, ЗНАЙДЕНИЙ ДІЄЮ, А НЕ ЧИТАННЯМ. `LEFT JOIN … AND NOT lo.hidden`
      // разом із `WHERE COALESCE(lo.hidden,false)=false` — це порожня операція:
      // для прихованого клієнта join не дає рядка, `lo.hidden` = NULL,
      // COALESCE(NULL,false)=false → умова ІСТИННА. Дія писалась у базу й не
      // робила нічого; на екрані це виглядало як «кнопка не спрацювала».
      // Тест саме на ПОВЕДІНКУ (клієнта немає у видачі), а не на форму запиту.
      const before = (await R.clientStates({})).length;
      await c.query(`INSERT INTO loyalty_overrides (client_key, hidden) VALUES ('сплячий', true)
                     ON CONFLICT (client_key) DO UPDATE SET hidden = true`);
      const hidden = await R.clientStates({});
      assert.equal(hidden.length, before - 1,
        "🔴 прихований клієнт лишився у видачі — фільтр `hidden` не працює");
      assert.equal(hidden.find((r) => r.clientKey === "сплячий"), undefined,
        "🔴 саме той клієнт, якого прибрали, і лишився");

      // ДЗЕРКАЛО: без нього тест зеленів би й тоді, якби фільтр різав ВСІХ
      // підряд, — а це рівно та поломка, яку ми боїмось завести замість цієї.
      await c.query(`UPDATE loyalty_overrides SET hidden = false WHERE client_key = 'сплячий'`);
      const back = await R.clientStates({});
      assert.equal(back.length, before, "🔴 повернення до постійних не спрацювало");
      assert.ok(back.find((r) => r.clientKey === "сплячий"), "🔴 клієнт не повернувся у видачу");
      await c.query(`DELETE FROM loyalty_overrides WHERE client_key = 'сплячий'`);
    });
  } finally {
    await pool.end().catch(() => {});
    await c.end();
    scratch.dispose();
  }
});

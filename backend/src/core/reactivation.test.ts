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

    await t.test("#40 ⭐ ВРУЧНУ ПОСТІЙНИЙ: правило пускає, скидання повертає, БД вимагає примітку", async () => {
      // 🔴 ЩО ЦЕ СТЕРЕЖЕ. Прапорець `force_regular` існував у БД і впливав ЛИШЕ на
      // легасі-сегментацію старого `/loyalty` — нова кваліфікація його не бачила.
      // Дати кнопку в UI без цього — рівно «брехлива кнопка», яку ми щойно прибрали.
      // Тому перевіряємо НАСКРІЗЬ: БД → ядро → видача.
      const { qualifiesAsRepeat } = await import("./reactivationRules.js");
      const { loadClientSegments } = await import("./clientSegments.js");

      // ── 0 · беремо клієнта, якого правило НЕ пускає (разовий)
      const before = await loadClientSegments();
      const oneOff = [...before.values()].find((x) => !x.qualified);
      assert.ok(oneOff, "🔴 у сіді немає жодного разового — доводити нема на чому "
        + "(порожній результат це ПРОВАЛ, не успіх)");
      assert.equal(oneOff!.forcedRegular, false, "🔴 клієнт уже включений вручну — тест не з нуля");

      // ── 1 · 🔴 БД ВІДХИЛЯЄ ПРАПОРЕЦЬ БЕЗ ПРИМІТКИ. Валідацію в роуті обходить
      // будь-який скрипт; примітка має бути умовою існування рядка, а не звичкою.
      await assert.rejects(
        () => c.query(`INSERT INTO loyalty_overrides (client_key, force_regular)
                       VALUES ($1, true)
                       ON CONFLICT (client_key) DO UPDATE SET force_regular = true, note = NULL`,
                      [oneOff!.clientKey]),
        /force_regular|check/i,
        "🔴 БД пустила «вважати постійним» БЕЗ примітки — CHECK стоїть для вигляду");
      // порожній рядок — теж не примітка, інакше правило обходиться пробілом
      await assert.rejects(
        () => c.query(`INSERT INTO loyalty_overrides (client_key, force_regular, note)
                       VALUES ($1, true, '   ')
                       ON CONFLICT (client_key) DO UPDATE SET force_regular = true, note = '   '`,
                      [oneOff!.clientKey]),
        /force_regular|check/i,
        "🔴 пробіли зійшли за примітку — CHECK не тримає btrim");

      // ── 2 · З ПРИМІТКОЮ клієнт проходить, хоча правило його не пускає
      await c.query(`INSERT INTO loyalty_overrides (client_key, force_regular, note)
                     VALUES ($1, true, 'домовленість власника, возить щокварталу')
                     ON CONFLICT (client_key) DO UPDATE
                       SET force_regular = true, note = EXCLUDED.note`, [oneOff!.clientKey]);
      const forced = (await loadClientSegments()).get(oneOff!.clientKey)!;
      assert.equal(forced.forcedRegular, true, "🔴 ядро не побачило ручного винятку");
      assert.equal(forced.qualified, true,
        "🔴 клієнт із ручним винятком лишився разовим — кнопка була б мовчазною");
      assert.equal(forced.forceNote, "домовленість власника, возить щокварталу",
        "🔴 примітка не доїхала до екрана — позначка «вручну» без «чому» = майбутній пошук неіснуючого бага");
      // чиста функція теж мусить це знати сама, без БД
      assert.equal(qualifiesAsRepeat({ payments: 1, minGapDays: null, payMode: "cash", forcedRegular: true }), true,
        "🔴 правило не поважає виняток — виняток жив би лише в SQL");

      // ── 3 · 🪞 ДЗЕРКАЛО: скидання ПОВЕРТАЄ як було. Без цього пункт 2 зеленів би
      // й тоді, коли ми зробили постійними ВСІХ підряд.
      await c.query(`UPDATE loyalty_overrides SET force_regular = false WHERE client_key = $1`, [oneOff!.clientKey]);
      const back = (await loadClientSegments()).get(oneOff!.clientKey)!;
      assert.equal(back.forcedRegular, false, "🔴 скидання не спрацювало — дія незворотна");
      assert.equal(back.qualified, false,
        "🔴 після скидання клієнт лишився постійним — правило вже не керує, керує слід від правки");

      await c.query(`DELETE FROM loyalty_overrides WHERE client_key = $1`, [oneOff!.clientKey]);
    });

    await t.test("#38 АРХІВ: одна дія з ПРИЧИНОЮ прибирає, нова оплата повертає САМА", async () => {
      // 🔴 ЩО САМЕ ТУТ ПЕРЕВІРЯЄТЬСЯ І ЧОМУ ТАК. Раніше тут стояв тест на `hidden` —
      // булевий тумблер без причини й без дати. Він ловив реальний регрес (порожня
      // умова `LEFT JOIN … AND NOT lo.hidden` разом із `WHERE COALESCE(...)=false`),
      // але сам механізм власник замінив архівом: дата + причина + хто.
      // Перевіряємо ПОВЕДІНКУ, а не форму запиту.
      const before = (await R.clientStates({})).length;

      // ── 1 · Дія з причиною прибирає клієнта з видачі
      await c.query(
        `INSERT INTO loyalty_overrides (client_key, archived_at, archive_reason)
         VALUES ('сплячий', now(), 'closed_down')
         ON CONFLICT (client_key) DO UPDATE SET archived_at = now(), archive_reason = 'closed_down'`);
      const archived = await R.clientStates({});
      assert.equal(archived.length, before - 1, "🔴 заархівований клієнт лишився у видачі");
      assert.equal(archived.find((r) => r.clientKey === "сплячий"), undefined,
        "🔴 зник не той клієнт, якого архівували");

      // ── 2 · 🔴 ПРИЧИНА ОБОВʼЯЗКОВА НА РІВНІ БД, а не лише роуту: скрипт повз роут
      // не має вміти покласти клієнта в архів «без причини».
      await assert.rejects(
        () => c.query(`INSERT INTO loyalty_overrides (client_key, archived_at) VALUES ('межа60', now())
                       ON CONFLICT (client_key) DO UPDATE SET archived_at = now(), archive_reason = NULL`),
        /archive_reason|check/i,
        "🔴 БД пустила архівацію БЕЗ причини — CHECK не працює");

      // ── 3 · 🟢 АВТОПОВЕРНЕННЯ. Нова оплата ПІСЛЯ дати архівації повертає клієнта
      // САМА — без джоби й без другої дії. Збережений стан треба комусь оновлювати;
      // джоба, що тихо не відпрацювала, лишила б в архіві того, хто вчора замовив.
      await c.query(
        `INSERT INTO deals (kommo_id,name,manager_id,pipeline_id,status_id,price,client_key,client_key_raw,client_name,closed_at_kommo)
         VALUES (990,'d',10,8921932,142,4242,'сплячий','сплячий','ТОВ Сплячий', now() + interval '1 minute')`);
      const returned = await R.clientStates({});
      assert.ok(returned.find((r) => r.clientKey === "сплячий"),
        "🔴 клієнт НЕ повернувся після нової оплати — автоповернення не працює, "
        + "і хтось муситиме памʼятати, що його треба дістати руками");

      // ── 4 · 🪞 ДЗЕРКАЛО: фільтр ріже САМЕ архівних, а не всіх підряд. Без цього
      // пункт 1 зеленів би й тоді, коли з екрана зникли ВСІ.
      assert.equal(returned.length, before,
        "🔴 після повернення кількість не збіглася з початковою — фільтр зачепив зайвих");

      await c.query(`DELETE FROM deals WHERE kommo_id = 990`);
      await c.query(`DELETE FROM loyalty_overrides WHERE client_key IN ('сплячий','межа60')`);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 👤 ВІДПОВІДАЛЬНИЙ ЗА БОРГ — проти СПРАВЖНЬОЇ БД (#131, #132, #132b)
    //
    // 🔴 ЖИВУТЬ САМЕ ТУТ, а не окремим файлом, і це не зручність. `db/pool.js` —
    // модульний синглтон: другий `provisionScratch` у своєму файлі перевизначив би
    // `DATABASE_URL` ПІСЛЯ того, як пул уже вказує на чужу базу, а його `pool.end()`
    // закрив би пул усім. Заміряно раніше: один такий файл поклав 13 чужих тестів.
    // ─────────────────────────────────────────────────────────────────────────
    await t.test("#131 ПЕРЕПРИВʼЯЗКА НЕ РУХАЄ ГРОШІ, а override б'є авто", async () => {
      const store = await import("./receivablesOwnerStore.js");
      await c.query(`INSERT INTO teams (id, name) VALUES (77,'Команда 77') ON CONFLICT (id) DO NOTHING`);
      await c.query(`INSERT INTO managers (id, name, team_id, is_team_lead, is_active)
                     VALUES (901,'Мажоритар',77,false,true), (902,'Інший',77,false,true),
                            (903,'Тімлід 77',77,true,true) ON CONFLICT (id) DO NOTHING`);
      await c.query(`INSERT INTO receivables (client_key, client_name, amount, source)
                     VALUES ('овнерклієнт','ТОВ Овнер',300,'sheet')`);
      await c.query(`INSERT INTO receivable_invoices (client_key, client_name, manager_id, amount, invoice_date)
                     VALUES ('овнерклієнт','ТОВ Овнер',901,200,'2026-07-01'),
                            ('овнерклієнт','ТОВ Овнер',902,100,'2026-08-01')`);
      const sumBefore = (await c.query<{ s: string }>(`SELECT SUM(amount) s FROM receivables`)).rows[0].s;
      const read = async () => (await c.query<{ manager_id: number | null; owner_source: string; majority_manager_id: number | null }>(
        `SELECT manager_id, owner_source, majority_manager_id FROM receivables WHERE client_key='овнерклієнт'`)).rows[0];

      // 1 · авто: виграє більша СУМА (901), а не свіжіший рахунок (902).
      await store.recomputeOwners(c, ["овнерклієнт"]);
      let row = await read();
      assert.equal(row.manager_id, 901, "мажоритар за сумою");
      assert.equal(row.owner_source, "auto-majority", "🔴 source не доїхав у таблицю");

      // 2 · override б'є авто — і доїжджає до ТАБЛИЦІ, а не лишається в ядрі.
      await c.query(`INSERT INTO receivable_manager_override (client_key, manager_id, note, set_by)
                     VALUES ('овнерклієнт',902,'ручне призначення',NULL)`);
      await store.recomputeOwners(c, ["овнерклієнт"]);
      row = await read();
      assert.equal(row.manager_id, 902, "🔴 override НЕ переміг авто");
      assert.equal(row.owner_source, "override", "🔴 source не доїхав у таблицю");
      assert.equal(row.majority_manager_id, 901,
        "🔴 мажоритар не збережений — екран не зможе сказати, кого перекрили");

      // 3 · 🪞 «свідомо нікого» — це РІШЕННЯ, а не порожнеча.
      await c.query(`UPDATE receivable_manager_override SET manager_id = NULL WHERE client_key='овнерклієнт'`);
      await store.recomputeOwners(c, ["овнерклієнт"]);
      row = await read();
      assert.equal(row.manager_id, null);
      assert.equal(row.owner_source, "override",
        "🔴 NULL-рядок ≠ «ще не дивились»: source мусить лишитись override");

      // 4 · 🪞 зняли призначення — авто вмикається НАЗАД.
      await c.query(`DELETE FROM receivable_manager_override WHERE client_key='овнерклієнт'`);
      await store.recomputeOwners(c, ["овнерклієнт"]);
      row = await read();
      assert.equal(row.manager_id, 901, "🔴 авто не повернулось після зняття override");
      assert.equal(row.owner_source, "auto-majority");

      // 5 · 🔴 ГРОШІ НЕ ЗРУШИЛИСЬ ЖОДНОГО РАЗУ. Переприв'язка людини — це підпис,
      // а не переказ: якби перерахунок чіпав `amount`, Σ дебіторки поїхала б тихо.
      const sumAfter = (await c.query<{ s: string }>(`SELECT SUM(amount) s FROM receivables`)).rows[0].s;
      assert.equal(sumAfter, sumBefore, "🔴 Σ боргу змінилась від переприв'язки відповідального");
    });

    await t.test("#132 АУДИТ: хто і коли призначив — записано, і оновлення рухає час", async () => {
      await c.query(`INSERT INTO users (id, email, password_hash, role, is_active)
                     VALUES (9001,'own@test','x','admin',true) ON CONFLICT (id) DO NOTHING`);
      await c.query(`INSERT INTO receivable_manager_override (client_key, manager_id, note, set_by)
                     VALUES ('аудитклієнт',901,'перше призначення',9001)`);
      const first = (await c.query<{ set_by: number | null; set_at: Date; note: string }>(
        `SELECT set_by, set_at, note FROM receivable_manager_override WHERE client_key='аудитклієнт'`)).rows[0];
      assert.equal(first.set_by, 9001, "🔴 автор не записаний — «хто» невідомо");
      assert.equal(first.note, "перше призначення");

      // Повторне призначення — ТИМ САМИМ виразом, що в роуті (ON CONFLICT DO UPDATE).
      await new Promise((r) => setTimeout(r, 10));
      await c.query(`INSERT INTO receivable_manager_override (client_key, manager_id, note, set_by)
                     VALUES ('аудитклієнт',902,'перепризначено',9001)
                     ON CONFLICT (client_key) DO UPDATE SET manager_id=EXCLUDED.manager_id,
                       note=EXCLUDED.note, set_by=EXCLUDED.set_by, set_at=now()`);
      const second = (await c.query<{ set_at: Date; note: string }>(
        `SELECT set_at, note FROM receivable_manager_override WHERE client_key='аудитклієнт'`)).rows[0];
      assert.equal(second.note, "перепризначено");
      assert.ok(second.set_at > first.set_at,
        "🔴 час не зрушив — «коли» бреше про останню зміну");
      await c.query(`DELETE FROM receivable_manager_override WHERE client_key='аудитклієнт'`);
    });

    await t.test("#132b ПРИМІТКА ОБОВʼЯЗКОВА — і це стереже БД, а не роут", async () => {
      // 🔴 ТЕСТ НА ВІДХИЛЕННЯ, а не «очима». `CHECK` виглядає бездоганно й тоді,
      // коли не працює: на цьому ми вже спіймались двічі (NULL-пастка `#38`).
      await assert.rejects(
        () => c.query(`INSERT INTO receivable_manager_override (client_key, manager_id, note)
                       VALUES ('безпримітки',901,'')`),
        /check|note/i, "🔴 БД пустила призначення з ПОРОЖНЬОЮ приміткою");
      await assert.rejects(
        () => c.query(`INSERT INTO receivable_manager_override (client_key, manager_id, note)
                       VALUES ('безпримітки',901,'   ')`),
        /check|note/i, "🔴 БД пустила примітку з самих пробілів");
      // 🪞 ДЗЕРКАЛО: зі справжньою приміткою вставка ПРОХОДИТЬ — інакше CHECK міг би
      // забороняти все підряд, а гейт читався б як надійність.
      await c.query(`INSERT INTO receivable_manager_override (client_key, manager_id, note)
                     VALUES ('зпримiткою',901,'клієнт перейшов до іншого менеджера')`);
      assert.equal((await c.query(`SELECT 1 FROM receivable_manager_override WHERE client_key='зпримiткою'`)).rowCount, 1);
      await c.query(`DELETE FROM receivable_manager_override WHERE client_key='зпримiткою'`);
    });

    await t.test("#133 МЕЖА ПРАВА: merge_receivables — рівно {admin, ceo, opdir, kvp}", async () => {
      // 🔴 ПЕРЕВІРЯЄМО МІГРАЦІЮ, А НЕ ЖИВІ ТУМБЛЕРИ. `permissions` адмін крутить
      // щодня, тож строга звірка з продом стала б шумом; тут база піднята зі
      // `schema.sql` З НУЛЯ, і питання рівно одне: чи роздала міграція право саме
      // тим чотирьом. Це та сама пастка, на якій `merge_clients` двічі просочився
      // в ceo/financier — синки ролей копіюють `permissions` адміна ЦІЛКОМ.
      const got = (await c.query<{ key: string }>(
        `SELECT key FROM roles WHERE (permissions->>'merge_receivables')::bool IS TRUE ORDER BY key`
      )).rows.map((r) => r.key);
      assert.deepEqual(got, ["admin", "ceo", "kvp", "opdir"],
        `🔴 межа права поїхала: ${got.join(", ")}`);
      // 🪞 ДЗЕРКАЛО, і воно тут ГОЛОВНЕ: фінансист має `admin_scope`, тож будь-яка
      // спроба збудувати склейку на ньому мовчки дала б йому право. Перевіряємо
      // ОБИДВА факти одночасно — інакше «фінансиста немає» зеленіло б і тоді,
      // коли він просто не існує в базі.
      const fin = (await c.query<{ a: boolean | null; m: boolean | null }>(
        `SELECT (permissions->>'admin_scope')::bool AS a, (permissions->>'merge_receivables')::bool AS m
           FROM roles WHERE key = 'financier'`)).rows[0];
      assert.equal(fin?.a, true, "фінансист МАЄ admin_scope — інакше дзеркало нічого не доводить");
      assert.notEqual(fin?.m, true, "🔴 фінансист дістав склейку в дебіторці");
      const lead = (await c.query<{ m: boolean | null }>(
        `SELECT (permissions->>'merge_receivables')::bool AS m FROM roles WHERE key = 'team_lead'`)).rows[0];
      assert.notEqual(lead?.m, true, "🔴 тімлід дістав склейку в дебіторці");
      // 🔗 А на екрані «Клієнти» тімлід склейку ЗБЕРІГАЄ — рішення 04.08.2026
      // не скасовано. Без цього рядка коміт міг би тихо забрати її і там.
      const leadClients = (await c.query<{ m: boolean | null }>(
        `SELECT (permissions->>'merge_clients')::bool AS m FROM roles WHERE key = 'team_lead'`)).rows[0];
      assert.notEqual(leadClients?.m, true, "тімлід і не мав merge_clients — його гілка окрема (mergeScope)");
    });

    await t.test("#130 СКЛЕЙКА: два ключі → ОДИН рядок, у розкритті обидві юрособи", async () => {
      const { RECOMPUTE_RECEIVABLES_SQL } = await import("../jobs/clientKeySql.js");
      const store = await import("./receivablesOwnerStore.js");
      await c.query(`INSERT INTO receivable_invoices
          (client_key, client_key_raw, client_name, manager_id, invoice_no, invoice_date, amount)
        VALUES ('групакомпанійавтострада','групакомпанійавтострада','ГК АВТОСТРАДА ТОВ',901,'A1','2026-08-01',486400),
               ('автострадавк','автострадавк','АВТОСТРАДА ВК',902,'A2','2026-08-02',1034500)`);
      await c.query(`INSERT INTO receivables (client_key, client_name, amount, source) VALUES
               ('групакомпанійавтострада','ГК АВТОСТРАДА ТОВ',486400,'sheet'),
               ('автострадавк','АВТОСТРАДА ВК',1034500,'sheet')`);
      const sumBefore = (await c.query<{ s: string }>(`SELECT SUM(amount) s FROM receivables`)).rows[0].s;
      const rows = () => c.query<{ client_key: string }>(
        `SELECT client_key FROM receivables WHERE client_key IN ('автострадавк','групакомпанійавтострада')`);
      assert.equal((await rows()).rowCount, 2, "до склейки — два рядки");

      // ── СКЛЕЙКА через ТОЙ САМИЙ реєстр, що й екран «Клієнти».
      await c.query(`INSERT INTO client_key_alias (alias_key, canonical_key, reason)
                     VALUES ('групакомпанійавтострада','автострадавк','одна компанія')`);
      await c.query(RECOMPUTE_RECEIVABLES_SQL);
      await c.query(`DELETE FROM receivables WHERE client_key IN ('групакомпанійавтострада','автострадавк') AND source='sheet'`);
      await c.query(`INSERT INTO receivables (client_key, client_name, amount, source)
        SELECT ri.client_key,
               COALESCE(MIN(ri.client_name) FILTER (WHERE ri.client_key_raw = ri.client_key), MIN(ri.client_name)),
               SUM(ri.amount), 'sheet'
          FROM receivable_invoices ri WHERE ri.client_key = 'автострадавк' GROUP BY ri.client_key`);
      const after = await rows();
      assert.equal(after.rowCount, 1, "🔴 після склейки має лишитись ОДИН рядок");
      assert.equal(after.rows[0].client_key, "автострадавк");

      // 🔴 ЮРОСОБИ ВСЕРЕДИНІ ВИДНО. Без цього склейка читається як зникнення
      // другої компанії, а не як обʼєднання.
      const inside = await c.query<{ entity: string; raw: string }>(
        `SELECT DISTINCT client_name AS entity, client_key_raw AS raw
           FROM receivable_invoices WHERE client_key = 'автострадавк' ORDER BY 1`);
      assert.equal(inside.rowCount, 2, "🔴 у розкритті мусять бути ОБИДВІ юрособи");
      assert.deepEqual(inside.rows.map((x) => x.raw).sort(),
        ["автострадавк", "групакомпанійавтострада"], "сирі ключі збережені — інакше відкіт неможливий");

      // Σ не змінилась: склейка — це перегрупування, а не переказ грошей.
      assert.equal((await c.query<{ s: string }>(`SELECT SUM(amount) s FROM receivables`)).rows[0].s, sumBefore,
        "🔴 Σ боргу змінилась від склейки");

      // ── 🪞 ВІДКІТ повертає ДВА рядки. Спільний `revoke` знімає псевдонім, і той
      // САМИЙ вираз повертає `client_key` до `client_key_raw` — без бекапу.
      await c.query(`UPDATE client_key_alias SET revoked_at = now() WHERE alias_key='групакомпанійавтострада'`);
      await c.query(RECOMPUTE_RECEIVABLES_SQL);
      await c.query(`DELETE FROM receivables WHERE client_key IN ('групакомпанійавтострада','автострадавк') AND source='sheet'`);
      await c.query(`INSERT INTO receivables (client_key, client_name, amount, source)
        SELECT ri.client_key, MIN(ri.client_name), SUM(ri.amount), 'sheet'
          FROM receivable_invoices ri
         WHERE ri.client_key IN ('групакомпанійавтострада','автострадавк') GROUP BY ri.client_key`);
      assert.equal((await rows()).rowCount, 2, "🔴 відкіт не повернув два рядки — склейка НЕОБОРОТНА");
      assert.equal((await c.query<{ s: string }>(`SELECT SUM(amount) s FROM receivables`)).rows[0].s, sumBefore,
        "🔴 Σ поїхала після відкоту");
      await store.recomputeOwners(c, ["автострадавк", "групакомпанійавтострада"]);
      await c.query(`DELETE FROM client_key_alias WHERE alias_key='групакомпанійавтострада'`);
      await c.query(`DELETE FROM receivable_invoices WHERE invoice_no IN ('A1','A2')`);
      await c.query(`DELETE FROM receivables WHERE client_key IN ('групакомпанійавтострада','автострадавк')`);
    });

    await t.test("#129 OVERRIDE І СКЛЕЙКА ПЕРЕЖИВАЮТЬ СИНК (TRUNCATE обох таблиць)", async () => {
      const { RECOMPUTE_RECEIVABLES_SQL } = await import("../jobs/clientKeySql.js");
      const store = await import("./receivablesOwnerStore.js");
      await c.query(`INSERT INTO client_key_alias (alias_key, canonical_key, reason)
                     VALUES ('синкаліас','синкканон','перевірка виживання')`);
      await c.query(`INSERT INTO receivable_manager_override (client_key, manager_id, note)
                     VALUES ('синкканон',902,'закріплено вручну')`);

      // ── ІМІТАЦІЯ СИНКУ: обидві таблиці зносяться повністю, як щопівгодини в проді.
      await c.query(`TRUNCATE receivables`);
      await c.query(`TRUNCATE receivable_invoices`);
      await c.query(`INSERT INTO receivable_invoices
          (client_key, client_key_raw, client_name, manager_id, invoice_no, invoice_date, amount)
        VALUES ('синкаліас','синкаліас','Юрособа А',901,'S1','2026-08-01',900),
               ('синкканон','синкканон','Юрособа Б',901,'S2','2026-08-02',100)`);
      await c.query(RECOMPUTE_RECEIVABLES_SQL);
      await c.query(`INSERT INTO receivables (client_key, client_name, amount, source)
        SELECT ri.client_key, MIN(ri.client_name), SUM(ri.amount), 'sheet'
          FROM receivable_invoices ri GROUP BY ri.client_key`);
      await store.recomputeOwners(c);

      const row = (await c.query<{ client_key: string; manager_id: number | null; owner_source: string; amount: string }>(
        `SELECT client_key, manager_id, owner_source, amount FROM receivables`)).rows;
      assert.equal(row.length, 1, "🔴 склейка не пережила TRUNCATE — два рядки замість одного");
      assert.equal(row[0].client_key, "синкканон");
      assert.equal(Number(row[0].amount), 1000, "сума обох юросіб");
      // 🔴 Мажоритар тут — 901 (900 ₴ проти 100 ₴). Якщо override не пережив синк,
      // відповідальним стане саме він, і гейт назве це поіменно.
      assert.equal(row[0].manager_id, 902, "🔴 override не пережив TRUNCATE — авто перебило ручне призначення");
      assert.equal(row[0].owner_source, "override");
      await c.query(`DELETE FROM receivable_manager_override WHERE client_key='синкканон'`);
      await c.query(`DELETE FROM client_key_alias WHERE alias_key='синкаліас'`);
      await c.query(`TRUNCATE receivables`); await c.query(`TRUNCATE receivable_invoices`);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 🔌 НАМІР ВИКАТУ ЗАБИРАЄ РІВНО ОДИН СТАРТ (#135d) — проти СПРАВЖНЬОЇ БД.
    //
    // 🔴 Чисті гейти `#135`/`#135b`/`#135c` перевіряють РІШЕННЯ (`classifyBoot`),
    // але одноразовість живе не в них, а в атомарному `UPDATE … RETURNING`. Саме
    // вона закриває дірку «краш усередині вікна викату», заради якої власник і
    // обрав лічильник замість таймера. Перевіряти її без БД неможливо в принципі.
    // ─────────────────────────────────────────────────────────────────────────
    await t.test("#135d НАМІР ВИКАТУ ОДНОРАЗОВИЙ: перший старт викат, другий — аварія", async () => {
      const { recordBoot } = await import("../jobs/appBoot.js");
      const { buildVersion } = await import("../version.js");
      const { sha } = buildVersion();

      const reset = async () => {
        await c.query(`TRUNCATE app_boot`);
        await c.query(`TRUNCATE deploy_intent`);
        // Попередній старт із ТИМ САМИМ sha — саме та ситуація, що дає `crash`
        // без наміру. Інакше перевірка звелась би до тривіального `deploy`.
        await c.query(`INSERT INTO app_boot (sha, short_sha, kind, booted_at)
                       VALUES ($1, 'prev', 'crash', now() - interval '5 minutes')`, [sha]);
      };

      // ── 1. ЧИННИЙ НАМІР: перший старт мовчить, ДРУГИЙ у тому ж вікні — ні.
      await reset();
      await c.query(`INSERT INTO deploy_intent (expires_at, note, created_by)
                     VALUES (now() + interval '15 minutes', 'гейт #135d', 'test')`);

      const first = await recordBoot();
      assert.ok(first, "🔴 recordBoot нічого не повернув — журнал стартів не ведеться");
      assert.equal(first.kind, "deploy-intent",
        "🔴 заявлений викат прийшов як аварія — банер знову кричатиме на кожному деплої");

      const second = await recordBoot();
      assert.ok(second);
      assert.equal(second.kind, "crash",
        "🔴 ДРУГИЙ старт у вікні наміру теж визнано викатом — це і є дірка, "
        + "заради якої обрано лічильник замість таймера: петля всередині деплою стала б невидимою");

      // Намір справді забраний, і видно КИМ.
      const di = (await c.query<{ consumed_at: Date | null; consumed_boot_id: string | null }>(
        `SELECT consumed_at, consumed_boot_id FROM deploy_intent`)).rows;
      assert.equal(di.length, 1, "🔴 наміри розмножились");
      assert.ok(di[0].consumed_at, "🔴 намір не позначено забраним — наступний старт забрав би його вдруге");
      assert.equal(Number(di[0].consumed_boot_id), first.id,
        "🔴 намір не вказує на старт, що його забрав — аудит викату порожній");

      // 🔴 ДЗЕРКАЛО МІГРАЦІЇ: `deploy-intent` реально ДОЇХАВ у CHECK таблиці.
      // `CREATE TABLE IF NOT EXISTS` на живій базі не робить нічого, тож без
      // окремого ALTER цей INSERT падав би на обмеженні — мовчки, вже в проді.
      const kinds = (await c.query<{ kind: string }>(`SELECT kind FROM app_boot ORDER BY id`)).rows.map((x) => x.kind);
      assert.ok(kinds.includes("deploy-intent"),
        "🔴 у журналі немає жодного 'deploy-intent' — CHECK не розширено, міграція не доїхала");

      // ── 2. ПРОТЕРМІНОВАНИЙ НАМІР: забирається, але НЕ глушить.
      await reset();
      await c.query(`INSERT INTO deploy_intent (expires_at, note, created_by)
                     VALUES (now() - interval '1 minute', 'мертвий намір', 'test')`);
      const stale = await recordBoot();
      assert.ok(stale);
      assert.equal(stale.kind, "crash",
        "🔴 мертвий намір усе ще глушить аварію — прапорець без стелі, той самий клас, що «успіх за 0 мс»");
      const consumed = (await c.query<{ consumed_at: Date | null }>(
        `SELECT consumed_at FROM deploy_intent`)).rows[0];
      assert.ok(consumed.consumed_at,
        "🔴 протермінований намір лишився в черзі — він забрав би НАСТУПНИЙ, уже справжній старт");

      await c.query(`TRUNCATE app_boot`);
      await c.query(`TRUNCATE deploy_intent`);
    });
  } finally {
    await pool.end().catch(() => {});
    await c.end();
    scratch.dispose();
  }
});

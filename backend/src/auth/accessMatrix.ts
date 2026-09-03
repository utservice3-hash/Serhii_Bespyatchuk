/**
 * 🔒 ЗЛІПОК ДОСТУПУ — знято ЕМПІРИЧНО з прода 31.07.2026 (450 пар роль×ендпоінт).
 *
 * Це НЕ побажання, а фотографія «як є» ПЕРЕД рефакторингом хардкоду ролей. Її
 * призначення — зловити будь-яку зміну поведінки під час заміни `role === "admin"`
 * на `roleHasPerm`. Рефакторинг не має права змінити жодну клітинку; змінив —
 * це вже не рефакторинг, а зміна політики, і робиться вона окремо й свідомо.
 *
 * 🔵 ПОВНЕ ПОКРИТТЯ 01.08.2026 (крок B1). Було 65 роутів зі 177 — «зелена там, куди
 * ми подивились», і саме в непокритій частині сидів інцидент з HR. Тепер у зліпку ВСІ
 * 177 роутів: 92 GET · 17 DELETE-ghost · 68 deny-only.
 *
 * Шляхи беруться з РАНТАЙМ-обходу роутерів (`routeInventory.ts`), а не з регулярки:
 * статичний розбір уже підводив (kvp-report виглядав відкритим, а віддає 403).
 *
 * ⚠️ ЗНЯТО З ПРОДА, НЕ З ПІСОЧНИЦІ. Спроба взяти deny-набори мутацій із пісочниці дала
 * 158 розбіжностей із 310 пар: без даних поведінка інша. Пісочниця не еталон.
 *
 * ⏱ Повний прогін ≈ втричі довший — тому поділ: `npm test` (швидкий, без #11) і
 * `npm run test:matrix` (повний). Обидва названі в маніфесті.
 *
 * 🟢 ОНОВЛЕНО 02.08.2026 — ЗМІНА ПОЛІТИКИ (такт 2): 17 роутів дістали tab-межу.
 * Зрушило РІВНО 8 клітинок, і всі в один бік — 200 → 403:
 *   hr:      kvp-report/manager-detail · report-plan · report-plan/deals ·
 *            response-time · stuck-deals-grouped · deal-note · lead-recommendation
 *   manager: lead-recommendation
 * Це НЕ звуження чиїхось прав, а закриття того самого класу, що дав інцидент з HR:
 * єдиною межею цих роутів був scope-кламп, а в company-ролі клампа немає. Жодна з
 * восьми ролей не втратила екран, який у неї Є: HR не має ні «report», ні «plans»,
 * ні «kvp»; менеджер не має «plans». Перевірено перед застосуванням по всіх 8 ролях.
 * Решта 9 мапінгів зрушили НУЛЬ клітинок — там ті самі ролі й так отримували 403.
 * Мапінги взяті з ФРОНТУ (який екран кличе роут), не з форми шляху.
 *
 * 🟢 ПЕРЕЗНЯТО 31.07.2026 — ЗМІНА ПОЛІТИКИ, НЕ РЕГРЕСІЯ.
 * Рішення власника: ФІНАНСИСТ ПРАЦЮЄ НА РІВНІ АДМІНА. Попередній дефолт «немає
 * вкладки → закрити ендпоінт» скасовано: 15 продажних ендпоінтів не закривали, а
 * роль вирівняли до адмінської (правами й екранами в `roles`, не хардкодом у роутах).
 *
 * Зрушило РІВНО 50 рядків, і в кожному зміна одна й та сама: `+financier`. Жодна
 * інша роль не додана, жодна не знята — перевірено перезніманням усіх пар тим самим
 * пробником проти сервера з новим кодом.
 *
 * ДВА ВИНЯТКИ лишились і перевірені окремо (обидва financier=403):
 *   • GET  /settings/users              — керування користувачами;
 *   • POST /settings/users/:id/reset-password — скидання паролів.
 *
 * ⚠️ У 14 рядках класу `deny-only` financier ЗНИК З ОБОХ списків, а не переїхав у
 * `allow`. Причина не косметична: ці рядки реально ЗАПИСУЮТЬ, і тест пробує лише
 * ролі зі списку `deny`. Лишити фінансиста там, де він тепер проходить гейт, означало
 * б, що наступний прогін #11 виконає справжній POST проти прода. Спіймав це #11b —
 * інваріант «у deny-only рядку не буває дозволених ролей» саме для цього й існує.
 *
 * ⚠️ ЯКЩО ЧИТАЄШ ЦЕ ЧЕРЕЗ ПІВРОКУ: широкі права фінансиста — НЕ баг і не наслідок
 * недогляду в рефакторингу. Це узгоджене рішення. Не «виправляй» назад.
 *
 * ⚠️ Чому емпірично, а не з розбору коду: статичний маппер «гейт → ендпоінт»
 * помилився на /dashboard/data-quality (приписав гейт не тому роуту). Зліпок із
 * живого API такої помилки не має за побудовою.
 *
 * КЛАСИ ПРОБИ — визначають, що тест має право робити на живому API:
 *  • GET          читання, пробуємо всі ролі;
 *  • DELETE-ghost DELETE з НЕІСНУЮЧОЮ ціллю: збігів немає, отже й запису немає;
 *  • deny-only    POST/PUT, що апсертять або запускають дію (напр. POST /dashboard/sync
 *                 стартує синк). Пробуємо ЛИШЕ ролі, яким гейт відмовляє; дозволені
 *                 не чіпаємо — вони б записали. Для них гарантія інша: гейт стоїть
 *                 ПЕРШИМ значущим оператором (перевірено читанням усіх обробників).
 *
 * Доведено знімком 70 таблиць до і після проби: жодного рядка, жодного штампа часу.
 *
 * `allow` = «сервер НЕ віддав 403». Код 400 (бракує параметрів) — теж пройдений гейт:
 * питання матриці — доступ, а не валідність запиту.
 */
export interface AccessRow {
  method: string;
  path: string;
  cls: "GET" | "DELETE-ghost" | "deny-only";
  /** Ролі, яким сервер віддав НЕ 403. */
  allow: string[];
  /** Ролі, яким сервер віддав 403. */
  deny: string[];
}

export const ACCESS_ROLES = ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager"] as const;

export const ACCESS_MATRIX: AccessRow[] = [
  { method: "GET", path: "/api/ai-work", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier"], deny: ["hr", "team_lead", "manager"] },
  { method: "POST", path: "/api/ai-work", cls: "deny-only",
    allow: [], deny: ["hr", "team_lead", "manager"] },
  { method: "POST", path: "/api/auth/login", cls: "deny-only",
    allow: [], deny: [] },
  { method: "GET", path: "/api/bank/accounts", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "POST", path: "/api/bank/accounts", cls: "deny-only",
    allow: [], deny: ["hr", "team_lead", "manager"] },
  { method: "DELETE", path: "/api/bank/accounts/:id", cls: "DELETE-ghost",
    allow: ["admin", "ceo", "opdir", "kvp", "financier"], deny: ["hr", "team_lead", "manager"] },
  { method: "PATCH", path: "/api/bank/accounts/:id", cls: "deny-only",
    allow: [], deny: ["hr", "team_lead", "manager"] },
  { method: "GET", path: "/api/bank/balances", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier"], deny: ["hr", "team_lead", "manager"] },
  { method: "GET", path: "/api/bank/cashflow", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier"], deny: ["hr", "team_lead", "manager"] },
  { method: "GET", path: "/api/bank/hidden-payees", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier"], deny: ["hr", "team_lead", "manager"] },
  { method: "POST", path: "/api/bank/hidden-payees", cls: "deny-only",
    allow: [], deny: ["hr", "team_lead", "manager"] },
  { method: "DELETE", path: "/api/bank/hidden-payees/:id", cls: "DELETE-ghost",
    allow: ["admin", "ceo", "opdir", "kvp", "financier"], deny: ["hr", "team_lead", "manager"] },
  { method: "GET", path: "/api/bank/incoming", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "GET", path: "/api/bank/outgoing", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "GET", path: "/api/bank/receivables", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "GET", path: "/api/bank/requisites", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "GET", path: "/api/dashboard/conversion", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "GET", path: "/api/dashboard/conversion-timeseries", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager"], deny: [] },
  { method: "GET", path: "/api/dashboard/daily", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager"], deny: [] },
  { method: "GET", path: "/api/dashboard/data-quality", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead"], deny: ["hr", "manager"] },
  { method: "POST", path: "/api/dashboard/deal-note", cls: "deny-only",
    allow: [], deny: ["hr"] },
  { method: "GET", path: "/api/dashboard/expected-deals", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager"], deny: [] },
  { method: "GET", path: "/api/dashboard/funnel", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "GET", path: "/api/dashboard/funnel-plan", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead"], deny: ["hr", "manager"] },
  { method: "POST", path: "/api/dashboard/funnel-plan", cls: "deny-only",
    allow: [], deny: ["hr", "manager"] },
  { method: "GET", path: "/api/dashboard/funnel-report", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "GET", path: "/api/dashboard/funnel-weekly", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager"], deny: [] },
  { method: "GET", path: "/api/dashboard/kvp-extra", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier"], deny: ["hr", "team_lead", "manager"] },
  { method: "GET", path: "/api/dashboard/kvp-plan", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier"], deny: ["hr", "team_lead", "manager"] },
  { method: "POST", path: "/api/dashboard/kvp-plan", cls: "deny-only",
    allow: [], deny: ["hr", "team_lead", "manager"] },
  { method: "GET", path: "/api/dashboard/kvp-report", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier"], deny: ["hr", "team_lead", "manager"] },
  { method: "GET", path: "/api/dashboard/kvp-report/manager-detail", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "GET", path: "/api/dashboard/lead-quality", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead"], deny: ["hr", "manager"] },
  { method: "GET", path: "/api/dashboard/lead-recommendation", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead"], deny: ["manager", "hr"] },
  // 🟢 ЗМІНА ПОЛІТИКИ 04.08.2026 (рішення власника), ЗАДЕКЛАРОВАНА, А НЕ ДРЕЙФ.
  // «Лідогенерація» стала самостійним екраном на реєстрі бота: адмін/ОД/КВП — усе,
  // тімлід — передачі СВОЄЇ команди (кламп на сервері), МЕНЕДЖЕР — 403.
  // Менеджера прибрано СВІДОМО: екран показує розподіл заявок між менеджерами,
  // тобто дані про колег, а не власну роботу.
  { method: "GET", path: "/api/dashboard/leadgen", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead"], deny: ["hr", "manager"] },
  { method: "GET", path: "/api/dashboard/leadgen-regulars", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager"], deny: [] },
  // ФАЗА A · «Постійні клієнти · план місяця». Межа — вкладка `loyalty`, якої в
  // HR немає (перевірено в БД: ключа `loyalty` у screen_access ролі hr немає
  // взагалі). Менеджер вкладку МАЄ і бачить своїх клієнтів — звуження робить
  // скоуп усередині роута, а не відмова на вході.
  { method: "GET", path: "/api/dashboard/client-plans", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "GET", path: "/api/dashboard/client-comments?clientKey=zzz", cls: "GET",
    allow: [], deny: ["hr"] },
  // Картка клієнта (гістограма 12 міс + останні угоди). Межа — та сама вкладка
  // `loyalty` плюс `canSeeClient` усередині: на неіснуючому ключі менеджер і
  // тімлід дістають 403 за скоупом, і саме це фіксує рядок.
  { method: "GET", path: "/api/dashboard/client-card?clientKey=zzz", cls: "GET",
    allow: [], deny: ["hr"] },
  // 🟢 ЗМІНА ПОЛІТИКИ 04.08.2026 (рішення власника), ЗАДЕКЛАРОВАНА, А НЕ ДРЕЙФ.
  // Пошук клієнта відкрито ТІМЛІДУ — але звужено до ЙОГО команди КЛАМПОМ НА
  // СЕРВЕРІ (`mm.team_id`), не фільтром на фронті. Права `merge_clients` це не
  // дає: обʼєднання й передача лишились там, де були (нижче), тож «знайти» і
  // «змінити» тепер відповідають на різні запитання.
  // `financier`/`ceo` — ролі адмінського рівня, але власник їх не називав; для
  // них це справжня відмова по праву, і вона лишається. `manager` теж 403:
  // вкладку `loyalty` він має, тож tab-гейт його пропустив би — відмова явна.
  { method: "GET", path: "/api/dashboard/client-search?q=zz", cls: "GET",
    allow: ["admin", "kvp", "opdir", "team_lead"], deny: ["hr", "manager", "financier", "ceo"] },
  { method: "POST", path: "/api/dashboard/client-comments", cls: "deny-only",
    allow: [], deny: ["hr"] },
  { method: "POST", path: "/api/dashboard/client-plan", cls: "deny-only",
    allow: [], deny: ["hr"] },
  { method: "POST", path: "/api/dashboard/client-plan/return", cls: "deny-only",
    allow: [], deny: ["hr", "manager"] },
  { method: "POST", path: "/api/dashboard/client-plans/submit", cls: "deny-only",
    allow: [], deny: ["hr"] },
  { method: "POST", path: "/api/dashboard/client-plans/approve-all", cls: "deny-only",
    allow: [], deny: ["hr", "manager"] },
  // ФАЗА B · реактивація. Читання — уся вкладка `loyalty` (HR її не має);
  // злиття й призначення відповідального — за ПРАВОМ `merge_clients`
  // (КВП, ОД, admin — зміна політики 03.08.2026), тому там deny значно ширший.
  { method: "GET", path: "/api/dashboard/reactivation-list", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  // 🔴 СПІЛЬНИЙ ПУЛ НІЧИЙНИХ — СВІДОМЕ РОЗШИРЕННЯ, НЕ ДІРКА (рішення власника
  // 05.08.2026). Тімлід бачить ВЕСЬ пул, без клампу по своїй команді: клієнт
  // нічийний саме тому, що не належить нікому, і ділити його по командах немає
  // за чим. МЕНЕДЖЕР — 403: пул це інструмент розподілу, а не самообслуговування.
  // Виняток діє ТІЛЬКИ на ці два роути; будь-який інший кламиться як досі.
  { method: "GET", path: "/api/dashboard/orphan-clients", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead"], deny: ["hr", "manager"] },
  { method: "POST", path: "/api/dashboard/orphan-clients/claim", cls: "deny-only",
    allow: [], deny: ["hr", "manager"] },
  { method: "POST", path: "/api/dashboard/client-seasonal", cls: "deny-only",
    allow: [], deny: ["hr", "manager"] },
  { method: "POST", path: "/api/dashboard/reactivation-task", cls: "deny-only",
    allow: [], deny: ["hr"] },
  { method: "POST", path: "/api/dashboard/reactivation-task/close", cls: "deny-only",
    allow: [], deny: ["hr"] },
  // 🟢 ЗМІНА ПОЛІТИКИ 04.08.2026 (рішення власника): тімлід ОБʼЄДНУЄ клієнтів, але
  // лише коли ОБИДВА боки — його команди; міжкомандні випадки лишились за
  // `merge_clients` (КВП/ОД/адмін).
  //
  // 🔴 ЧОМУ `team_lead` ЛИШИВСЯ В `deny` ТАМ, ДЕ ПОЛІТИКА ЙОГО ДОЗВОЛЯЄ. Проба
  // ходить у НЕІСНУЮЧІ ключі (`zzz`), а для них команда не визначається — і кламп
  // чесно віддає 403. Клітинка каже правду про поведінку, і саме тому вона цінна:
  // приберуть кламп — тімлід дістане 400 замість 403, і #11 почервоніє. Тобто
  // матриця тут СТОРОЖУЄ кламп, а не описує намір. Намір доводять #30h/#30i
  // (реальна пара «свій+чужий» проти «свій+свій») і #31 (чистий предикат).
  { method: "GET", path: "/api/dashboard/client-merge/preview?alias=a&canonical=b", cls: "GET",
    allow: ["admin", "kvp", "opdir"], deny: ["hr", "manager", "team_lead", "financier", "ceo"] },
  // Журнал ключів не приймає, тож клітинка стабільна: тімлід читає (свої записи —
  // фільтр усередині роута), решта — 403.
  { method: "GET", path: "/api/dashboard/client-merge/journal", cls: "GET",
    allow: ["admin", "kvp", "opdir", "team_lead"], deny: ["hr", "manager", "financier", "ceo"] },
  { method: "POST", path: "/api/dashboard/client-merge", cls: "deny-only",
    allow: [], deny: ["hr", "manager", "team_lead", "financier", "ceo"] },
  { method: "POST", path: "/api/dashboard/client-merge/revoke", cls: "deny-only",
    allow: [], deny: ["hr", "manager", "team_lead", "financier", "ceo"] },
  { method: "POST", path: "/api/dashboard/client-manager", cls: "deny-only",
    allow: [], deny: ["hr", "manager", "team_lead", "financier", "ceo"] },
  { method: "GET", path: "/api/dashboard/client-manager/history?clientKey=zzz", cls: "GET",
    allow: [], deny: ["hr"] },
  { method: "GET", path: "/api/dashboard/loyalty", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "POST", path: "/api/dashboard/loyalty-override", cls: "deny-only",
    allow: [], deny: ["hr", "team_lead", "manager"] },
  // 🗄 Архів клієнта — КВП/ОД/адмін (рішення власника 05.08.2026). Тімлід і
  // менеджер НЕ архівують: прибрати клієнта з екранів усієї компанії — не їхнє
  // рішення (те саме правило, що для «прибрати з постійних»).
  { method: "POST", path: "/api/dashboard/client-archive", cls: "deny-only",
    allow: [], deny: ["hr", "team_lead", "manager"] },
  { method: "GET", path: "/api/dashboard/client-archive", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier"], deny: ["hr", "team_lead", "manager"] },
  { method: "DELETE", path: "/api/dashboard/loyalty-override/:clientKey", cls: "DELETE-ghost",
    allow: ["admin", "ceo", "opdir", "kvp", "financier"], deny: ["hr", "team_lead", "manager"] },
  { method: "GET", path: "/api/dashboard/loyalty-overrides", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier"], deny: ["hr", "team_lead", "manager"] },
  { method: "GET", path: "/api/dashboard/manager-report", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead"], deny: ["hr", "manager"] },
  { method: "GET", path: "/api/dashboard/managers", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead"], deny: ["hr", "manager"] },
  { method: "GET", path: "/api/dashboard/overview", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "GET", path: "/api/dashboard/personal", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "GET", path: "/api/dashboard/plans-grid", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead"], deny: ["hr", "manager"] },
  // 🪦 `GET /api/dashboard/reactivation` видалено 26.08.2026 — рядок знято РАЗОМ
  // із роутом. Зліпок доступу описує те, що існує; рядок про неіснуючий роут
  // роздуває матрицю пробами в нікуди й ховає справжню прогалину. Тримає `#19h`.
  { method: "POST", path: "/api/dashboard/reactivation", cls: "deny-only",
    allow: [], deny: ["hr", "manager"] },
  { method: "PUT", path: "/api/dashboard/reactivation", cls: "deny-only",
    allow: [], deny: ["hr"] },
  { method: "GET", path: "/api/dashboard/reactivation-candidates", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead"], deny: ["hr", "manager"] },
  { method: "DELETE", path: "/api/dashboard/reactivation/:clientKey", cls: "DELETE-ghost",
    allow: ["admin", "ceo", "opdir", "kvp", "financier"], deny: ["hr", "team_lead", "manager"] },
  { method: "GET", path: "/api/dashboard/receivables", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "PUT", path: "/api/dashboard/receivables/invoice-note", cls: "deny-only",
    allow: [], deny: ["hr"] },
  { method: "GET", path: "/api/dashboard/receivables/invoices", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "PUT", path: "/api/dashboard/receivables/note", cls: "deny-only",
    allow: [], deny: ["hr", "manager"] },
  // 👤 Ручне призначення відповідального за борг — `isAdminScope` (рішення власника
  // 22.08.2026). Тімлід і менеджер відмовляються: борг клієнта переприв'язує той,
  // хто бачить картину цілком.
  { method: "PUT", path: "/api/dashboard/receivables/owner", cls: "deny-only",
    allow: [], deny: ["hr", "manager", "team_lead"] },
  { method: "DELETE", path: "/api/dashboard/receivables/owner/:clientKey", cls: "deny-only",
    allow: [], deny: ["hr", "manager", "team_lead"] },
  // 🔗 Склейка в дебіторці — окреме право `merge_receivables` = {admin, ceo, opdir, kvp}.
  // ФІНАНСИСТ у deny СВІДОМО: він має `admin_scope` (рішення 31.07), але склейки
  // в дебіторці власник йому не давав. Тімлід — теж ні; на екрані «Клієнти» його
  // гілка (рішення 04.08) лишається недоторканою.
  { method: "POST", path: "/api/dashboard/receivables/merge", cls: "deny-only",
    allow: [], deny: ["hr", "manager", "team_lead", "financier"] },
  // 🔓 Превʼю РОЗʼЄДНАННЯ — межа та сама, що в самої дії. Воно показує склад
  // групи, суми й ТЕКСТИ нотаток; віддати це тому, хто розʼєднувати не може,
  // означало б відчинити читання там, де зачинено запис. Тімлід сюди не
  // потрапляє: у дебіторці його гілки немає (на відміну від екрана «Клієнти»).
  { method: "GET", path: "/api/dashboard/receivables/unmerge-preview?canonical=смартекс", cls: "deny-only",
    allow: [], deny: ["hr", "manager", "team_lead", "financier"] },
  // 🗑 Списання безнадійного боргу — право `write_off_debt` = {ceo, opdir}, і
  // АДМІН тут у deny СВІДОМО. Це не недогляд і не «забули додати»: рішення
  // власника 25.08.2026 назвало рівно дві ролі, а списання зменшує суму на
  // плитці, тобто це визнання втрати грошей, а не операційна дія. Розширення
  // складу має бути свідомим — тому й записане тут поіменно, а не виведене з
  // `admin_scope` (фінансист має його з 31.07 і права все одно не отримує).
  { method: "POST", path: "/api/dashboard/receivables/writeoff", cls: "deny-only",
    allow: [], deny: ["hr", "manager", "team_lead", "financier", "kvp", "admin"] },
  { method: "DELETE", path: "/api/dashboard/receivables/writeoff", cls: "deny-only",
    allow: [], deny: ["hr", "manager", "team_lead", "financier", "kvp", "admin"] },
  // 🧾 ЗАПИТ НА ПЕРЕГЛЯД ЛІМІТУ (рішення власника 26.08.2026: «Кнопка тільки в
  // тімліда»). Менеджер відмовляється НЕ вкладкою — дебіторку він бачить, — а
  // тим, що не може ставити задачу іншій людині (`canAssignTaskToOthers`).
  // HR відмовляється вкладкою, як і на решті дебіторки.
  // ⚠️ Тімлід тут ДОЗВОЛЕНИЙ на рівні матриці й звужується вже в роуті — до
  // клієнтів СВОЄЇ команди. Матриця перевіряє роль, а не конкретного клієнта.
  // ══════ ПʼЯТЬ РОУТІВ, ЯКИХ МАТРИЦЯ НЕ БАЧИЛА В ПРИНЦИПІ (26.08.2026) ══════
  //
  // 🔴 Заміряно, а не оцінено: роутів у коді **213**, рядків тут було **208**.
  // Ці пʼятеро не мали запису, тож зліпок `#11` не пробував їх ЖОДНОЮ роллю —
  // і саме тому «дебіторка звужується бездоганно» співіснувало з тим, що
  // `/writeoffs` віддавав менеджеру ті самі 8 списань на 68 178 ₴, що адміну.
  // Порожнє місце в реєстрі читається як «перевірено», а означає «не дивились».
  //
  // ⚠️ Дві поправки до діагнозу, обидві заміряні:
  // • роути ліміту НЕ були відкриті — `roleHasPerm("manage_credit_limits")`
  //   стояв першим значущим оператором; `#17` бачить його в тілі й вважав межею.
  //   Переїзд у `requirePerm` нічого не змінив у поведінці, лише зробив межу
  //   видимою й для матриці.
  // • `/report-plan/day-items` теж мав межу — `canDrillManager` + вкладку
  //   `report` через `pre(...)`. Бракувало саме РЯДКА тут, а не захисту.
  { method: "GET", path: "/api/dashboard/receivables/writeoffs", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  // ⚠️ Тімлід і менеджер ДОЗВОЛЕНІ на рівні ролі й звужуються вже в роуті — до
  // своїх клієнтів. Матриця перевіряє РОЛЬ, звуження ДАНИХ тримає `#229`.
  { method: "GET", path: "/api/dashboard/receivables/note-history?clientKey=zzz", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier"], deny: ["hr", "team_lead", "manager"] },
  // 🧾 Ліміт правлять пʼять ролей — те саме право `manage_credit_limits`, що
  // стереже `#186`. Тімлід має КНОПКУ ЗАПИТУ, а це інша дія (створює задачу).
  { method: "PUT", path: "/api/dashboard/receivables/limit", cls: "deny-only",
    allow: [], deny: ["hr", "team_lead", "manager"] },
  { method: "DELETE", path: "/api/dashboard/receivables/limit/:clientKey", cls: "DELETE-ghost",
    allow: ["admin", "ceo", "opdir", "kvp", "financier"], deny: ["hr", "team_lead", "manager"] },
  { method: "GET", path: "/api/dashboard/receivables/limit-request?clientKey=zzz", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead"], deny: ["hr", "manager"] },
  { method: "POST", path: "/api/dashboard/receivables/limit-task", cls: "deny-only",
    allow: [], deny: ["hr", "manager"] },
  { method: "GET", path: "/api/dashboard/regular-clients", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead"], deny: ["hr", "manager"] },
  { method: "GET", path: "/api/dashboard/repeat-client-history", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager"], deny: [] },
  { method: "POST", path: "/api/dashboard/repeat-client-plan", cls: "deny-only",
    allow: [], deny: ["hr", "manager"] },
  { method: "POST", path: "/api/dashboard/repeat-client-plan/approve", cls: "deny-only",
    allow: [], deny: ["hr", "manager"] },
  { method: "POST", path: "/api/dashboard/repeat-client-plan/approve-all", cls: "deny-only",
    allow: [], deny: ["hr", "manager"] },
  { method: "GET", path: "/api/dashboard/repeat-client-plan/history", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead"], deny: ["hr", "manager"] },
  { method: "GET", path: "/api/dashboard/repeat-plans-grid", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead"], deny: ["hr", "manager"] },
  { method: "GET", path: "/api/dashboard/report", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  // 🔍 Розкриття дня у Звіті. Проба несе параметри, інакше роут віддає 400 ще
  // до перевірки прав — і зліпок міряв би валідацію, а не межу.
  { method: "GET", path: "/api/dashboard/report-plan/day-items?managerId=1&date=2026-01-01&kind=created", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier"], deny: ["hr", "manager"] },
  { method: "GET", path: "/api/dashboard/report-plan", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "GET", path: "/api/dashboard/report-plan/deals", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  // Розкриття рядка таблиці Звіту: ті самі ролі, що й решта тіла Звіту, межа —
  // вкладка `report` (успадковується префіксом `report-plan`).
  { method: "GET", path: "/api/dashboard/report-plan/manager-weeks", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "GET", path: "/api/dashboard/response-time", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "GET", path: "/api/dashboard/response-time/by-manager", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "GET", path: "/api/dashboard/stuck-deals", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead"], deny: ["hr", "manager"] },
  { method: "GET", path: "/api/dashboard/stuck-deals-grouped", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "POST", path: "/api/dashboard/sync", cls: "deny-only",
    allow: [], deny: ["hr", "manager"] },
  { method: "POST", path: "/api/dashboard/sync-receivables", cls: "deny-only",
    allow: [], deny: ["hr", "manager"] },
  { method: "GET", path: "/api/dashboard/sync-status", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager"], deny: [] },
  { method: "GET", path: "/api/dashboard/teams", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead"], deny: ["hr", "manager"] },
  { method: "GET", path: "/api/dashboard/timeseries", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "POST", path: "/api/documents/file", cls: "deny-only",
    allow: [], deny: ["hr", "team_lead", "manager"] },
  { method: "DELETE", path: "/api/documents/file/:id", cls: "DELETE-ghost",
    allow: ["admin", "ceo", "opdir", "kvp", "financier"], deny: ["hr", "team_lead", "manager"] },
  { method: "PATCH", path: "/api/documents/file/:id", cls: "deny-only",
    allow: [], deny: ["hr", "team_lead", "manager"] },
  { method: "GET", path: "/api/documents/file/:id/download", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager"], deny: [] },
  { method: "POST", path: "/api/documents/folder", cls: "deny-only",
    allow: [], deny: ["hr", "team_lead", "manager"] },
  { method: "DELETE", path: "/api/documents/folder/:id", cls: "DELETE-ghost",
    allow: ["admin", "ceo", "opdir", "kvp", "financier"], deny: ["hr", "team_lead", "manager"] },
  { method: "PATCH", path: "/api/documents/folder/:id", cls: "deny-only",
    allow: [], deny: ["hr", "team_lead", "manager"] },
  { method: "GET", path: "/api/documents/tree", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager"], deny: [] },
  { method: "GET", path: "/api/duty", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager"], deny: [] },
  { method: "POST", path: "/api/duty", cls: "deny-only",
    allow: [], deny: ["hr", "manager"] },
  { method: "DELETE", path: "/api/duty/:id", cls: "DELETE-ghost",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead"], deny: ["hr", "manager"] },
  { method: "POST", path: "/api/duty/absences", cls: "deny-only",
    allow: [], deny: [] },
  { method: "DELETE", path: "/api/duty/absences/:id", cls: "DELETE-ghost",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager"], deny: [] },
  { method: "POST", path: "/api/duty/absences/:id/approve", cls: "deny-only",
    allow: [], deny: ["hr", "manager"] },
  { method: "POST", path: "/api/duty/absences/:id/reject", cls: "deny-only",
    allow: [], deny: ["hr", "manager"] },
  { method: "POST", path: "/api/duty/holidays", cls: "deny-only",
    allow: [], deny: ["hr", "team_lead", "manager"] },
  { method: "DELETE", path: "/api/duty/holidays/:id", cls: "DELETE-ghost",
    allow: ["admin", "ceo", "opdir", "kvp", "financier"], deny: ["hr", "team_lead", "manager"] },
  { method: "GET", path: "/api/duty/presence", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager"], deny: [] },
  { method: "GET", path: "/api/feedback", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager"], deny: [] },
  { method: "POST", path: "/api/feedback", cls: "deny-only",
    allow: [], deny: [] },
  { method: "PATCH", path: "/api/feedback/:id", cls: "deny-only",
    allow: [], deny: ["hr", "team_lead", "manager"] },
  { method: "GET", path: "/api/goals", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead"], deny: ["hr", "manager"] },
  { method: "POST", path: "/api/goals", cls: "deny-only",
    allow: [], deny: ["hr", "manager"] },
  { method: "DELETE", path: "/api/goals/:id", cls: "DELETE-ghost",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead"], deny: ["hr", "manager"] },
  { method: "PATCH", path: "/api/goals/:id", cls: "deny-only",
    allow: [], deny: ["hr", "manager"] },
  // ── ТРИ РОУТИ /api/health ДОДАНО 02.09.2026. Їх знайшов #280 після того, як навчився
  // читати index.ts: вони оголошені прямо на `app`, тобто не належать жодному модулю з
  // MOUNTS, і тому не потрапляли у зліпок ЖОДНОГО разу з моменту його створення.
  //
  // 🔴 ЦЕ ЗЛІПОК «ЯК Є», А НЕ «ЯК МАЄ БУТИ» — три рядки нижче описують ПОТОЧНУ
  // поведінку прода, знову ж таки за призначенням цього файла (див. шапку). Політику
  // вони не змінюють і не мають права: зміна політики робиться окремо й свідомо.
  //
  // 🔴 /api/health БЕЗ СУФІКСА ВІДКРИТИЙ, І ЦЕ СВІДОМИЙ ВИНЯТОК (рішення власника
  // 02.09.2026), а не недогляд. Його читає НАШ ВЛАСНИЙ ланцюг деплою, щоб дізнатись sha
  // прода: крок `base` бере версію саме звідси і ходить БЕЗ заголовка Authorization
  // (заміряно: у tools/deploy.ts жодного Bearer/Authorization немає). Закрити його =
  // зламати викат усім чотирьом чатам одночасно.
  // ⚠️ ЯКЩО ЧИТАЄШ ЦЕ ЧЕРЕЗ ПІВРОКУ: не «лагодь» відкритість цього роута з найкращих
  // намірів. Спершу перенеси ланцюг деплою на інше джерело sha, і лише потім.
  { method: "GET", path: "/api/health", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager"], deny: [] },
  // Тривоги: у коді стоїть явний список ["admin","ceo","opdir","kvp"], і він уже
  // закріплений з ОБОХ боків — #10.4 (ці четверо → 200) і #10.5 (manager, team_lead,
  // hr, financier → 403). Рядок лише переносить це у зліпок.
  { method: "GET", path: "/api/health/alerts", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp"], deny: ["financier", "hr", "team_lead", "manager"] },
  // 🔴 ЗВІРКА ВІДДАЄТЬСЯ БЕЗ АВТОРИЗАЦІЇ ВЗАГАЛІ — у неї немає навіть requireAuth
  // (index.ts: `app.get("/api/health/reconciliation", async (_req, res)`). Тобто це не
  // «бачить будь-хто авторизований», а «бачить будь-хто». Віддає операційні нутрощі:
  // rows_over_threshold, max_delta_pct, integrity_orphans, worst_json, healed_count.
  // Рядок описує це «як є»; ВІДКРИТЕ ПИТАННЯ про закриття винесено власнику окремо.
  { method: "GET", path: "/api/health/reconciliation", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager"], deny: [] },
  { method: "GET", path: "/api/messages/:userId", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager"], deny: [] },
  { method: "POST", path: "/api/messages/:userId", cls: "deny-only",
    allow: [], deny: [] },
  { method: "POST", path: "/api/messages/heartbeat", cls: "deny-only",
    allow: [], deny: [] },
  { method: "GET", path: "/api/messages/unread", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager"], deny: [] },
  { method: "GET", path: "/api/messages/users", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager"], deny: [] },
  { method: "GET", path: "/api/news", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager"], deny: [] },
  { method: "POST", path: "/api/news", cls: "deny-only",
    allow: [], deny: ["hr", "team_lead", "manager"] },
  { method: "DELETE", path: "/api/news/:id", cls: "DELETE-ghost",
    allow: ["admin", "ceo", "opdir", "kvp", "financier"], deny: ["hr", "team_lead", "manager"] },
  { method: "GET", path: "/api/news/km-prices", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager"], deny: [] },
  { method: "PUT", path: "/api/news/km-prices", cls: "deny-only",
    allow: [], deny: ["hr", "team_lead", "manager"] },
  { method: "GET", path: "/api/one-on-ones/conduct-types", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead"], deny: ["manager"] },
  { method: "GET", path: "/api/one-on-ones/enps", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead"], deny: ["manager"] },
  { method: "GET", path: "/api/one-on-ones/forms/:type", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead"], deny: ["manager"] },
  // 🔴 КВП вийшов із deny 27.08.2026: власник дав йому `edit_1x1_forms` разом із
  // наскрізним переглядом. АДМІН лишається в deny — рішення відкрило адміну ЛИШЕ
  // перегляд (`view_all_1x1`), форми йому як не давали, так і не даємо.
  //
  // ⚠️ КВП саме ВИЙШОВ зі списку, а НЕ переїхав у `allow` — і це не дрібниця.
  // Клас `deny-only` означає роут на ЗАПИС: проба дозволеної ролі створила б нову
  // версію форми в бойовій базі. Тому дозволені ролі тут не перелічуються взагалі —
  // так само, як ceo/opdir/hr, які право мають давно. Спіймав `#11b`, а не я.
  { method: "PUT", path: "/api/one-on-ones/forms/:type", cls: "deny-only",
    allow: [], deny: ["admin", "financier", "team_lead", "manager"] },
  { method: "GET", path: "/api/one-on-ones/forms/:type/versions", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead"], deny: ["manager"] },
  { method: "GET", path: "/api/one-on-ones/meetings/:type/:managerId", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead"], deny: ["manager"] },
  { method: "GET", path: "/api/one-on-ones/open-tasks/:type/:managerId", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead"], deny: ["manager"] },
  { method: "POST", path: "/api/one-on-ones/record", cls: "deny-only",
    allow: [], deny: ["manager"] },
  { method: "GET", path: "/api/one-on-ones/record/:type/:managerId", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead"], deny: ["manager"] },
  { method: "GET", path: "/api/one-on-ones/stats/scores", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead"], deny: ["manager"] },
  { method: "GET", path: "/api/one-on-ones/subjects", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead"], deny: ["manager"] },
  { method: "POST", path: "/api/one-on-ones/task", cls: "deny-only",
    allow: [], deny: ["manager"] },
  { method: "POST", path: "/api/one-on-ones/task/:id/review", cls: "deny-only",
    allow: [], deny: ["manager"] },
  { method: "GET", path: "/api/plans", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead"], deny: ["hr", "manager"] },
  { method: "POST", path: "/api/plans", cls: "deny-only",
    allow: [], deny: ["hr", "team_lead", "manager"] },
  { method: "GET", path: "/api/plans/formation", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead"], deny: ["hr", "manager"] },
  { method: "POST", path: "/api/plans/formation/approve", cls: "deny-only",
    allow: [], deny: ["hr", "team_lead", "manager"] },
  { method: "GET", path: "/api/plans/formation/repeat-clients", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead"], deny: ["hr", "manager"] },
  { method: "POST", path: "/api/plans/formation/return", cls: "deny-only",
    allow: [], deny: ["hr", "team_lead", "manager"] },
  { method: "POST", path: "/api/plans/formation/submit", cls: "deny-only",
    allow: [], deny: ["hr", "manager"] },
  { method: "POST", path: "/api/rates/analyze", cls: "deny-only",
    allow: [], deny: ["hr"] },
  { method: "GET", path: "/api/rates/bodytypes", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "GET", path: "/api/rates/carriers", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "GET", path: "/api/rates/city-info", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "POST", path: "/api/rates/city-info", cls: "deny-only",
    allow: [], deny: ["hr"] },
  { method: "DELETE", path: "/api/rates/city-info/:id", cls: "DELETE-ghost",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "GET", path: "/api/rates/health", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "GET", path: "/api/rates/stats", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier"], deny: ["hr", "team_lead", "manager"] },
  { method: "GET", path: "/api/rates/towns", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "GET", path: "/api/reports", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "DELETE", path: "/api/reports/:id", cls: "DELETE-ghost",
    allow: ["admin", "ceo", "opdir", "kvp", "financier"], deny: ["hr", "team_lead", "manager"] },
  { method: "GET", path: "/api/settings", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier"], deny: ["hr", "team_lead", "manager"] },
  { method: "PUT", path: "/api/settings", cls: "deny-only",
    allow: [], deny: ["hr", "team_lead", "manager"] },
  { method: "GET", path: "/api/settings/audit", cls: "GET",
    allow: ["admin", "ceo", "opdir"], deny: ["kvp", "financier", "hr", "team_lead", "manager"] },
  { method: "GET", path: "/api/settings/roles", cls: "GET",
    allow: ["admin", "ceo", "opdir"], deny: ["kvp", "financier", "hr", "team_lead", "manager"] },
  { method: "POST", path: "/api/settings/roles", cls: "deny-only",
    allow: [], deny: ["kvp", "financier", "hr", "team_lead", "manager"] },
  { method: "DELETE", path: "/api/settings/roles/:key", cls: "DELETE-ghost",
    allow: ["admin", "ceo", "opdir"], deny: ["kvp", "financier", "hr", "team_lead", "manager"] },
  { method: "PUT", path: "/api/settings/roles/:key", cls: "deny-only",
    allow: [], deny: ["kvp", "financier", "hr", "team_lead", "manager"] },
  { method: "GET", path: "/api/settings/users", cls: "GET",
    allow: ["admin", "ceo", "opdir"], deny: ["kvp", "financier", "hr", "team_lead", "manager"] },
  { method: "POST", path: "/api/settings/users", cls: "deny-only",
    allow: [], deny: ["kvp", "financier", "hr", "team_lead", "manager"] },
  { method: "PATCH", path: "/api/settings/users/:id", cls: "deny-only",
    allow: [], deny: ["kvp", "financier", "hr", "team_lead", "manager"] },
  // 👤 Стан менеджера (активний / завершує / звільнений) — та сама межа, що й решта
  //    керування людьми: ставить лише той, хто керує користувачами.
  { method: "PATCH", path: "/api/settings/managers/:id/work-state", cls: "deny-only",
    allow: [], deny: ["kvp", "financier", "hr", "team_lead", "manager"] },
  { method: "POST", path: "/api/settings/users/:id/reactivate", cls: "deny-only",
    allow: [], deny: ["kvp", "financier", "hr", "team_lead", "manager"] },
  { method: "POST", path: "/api/settings/users/:id/reset-password", cls: "deny-only",
    allow: [], deny: ["kvp", "financier", "hr", "team_lead", "manager"] },
  { method: "POST", path: "/api/settings/users/provision", cls: "deny-only",
    allow: [], deny: ["kvp", "financier", "hr", "team_lead", "manager"] },
  { method: "GET", path: "/api/statistics", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "GET", path: "/api/statistics/catalog", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "PUT", path: "/api/statistics/manual", cls: "deny-only",
    allow: [], deny: ["hr", "team_lead", "manager"] },
  { method: "GET", path: "/api/statistics/series", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "POST", path: "/api/statistics/series/manual", cls: "deny-only",
    allow: [], deny: ["hr", "team_lead", "manager"] },
  { method: "GET", path: "/api/tasks", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager"], deny: [] },
  { method: "POST", path: "/api/tasks", cls: "deny-only",
    allow: [], deny: [] },
  { method: "DELETE", path: "/api/tasks/:id", cls: "DELETE-ghost",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager"], deny: [] },
  { method: "PATCH", path: "/api/tasks/:id", cls: "deny-only",
    allow: [], deny: [] },
  { method: "POST", path: "/api/tasks/plan", cls: "deny-only",
    allow: [], deny: [] },
  { method: "POST", path: "/api/tasks/reactivation", cls: "deny-only",
    allow: [], deny: ["hr", "manager"] },
  { method: "GET", path: "/api/teams", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead"], deny: ["hr", "manager"] },
  { method: "GET", path: "/api/teams/managers", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead"], deny: ["hr", "manager"] },
  // 🔴 ТРИ РОУТИ SSO ТРЕКЕРА ДОДАНО 02.09.2026 — ЇХ ТУТ НЕ БУЛО ВЗАГАЛІ.
  // Знайдено заміром під `#280`: із 217 оголошених роутів у зліпку бракувало рівно цих
  // трьох, і вони вже ЖИЛИ В ПРОДІ з першого PR трекера. `#17` їх не бачив, бо дивиться
  // в інший реєстр (`ROUTE_BOUNDARY_EXEMPTIONS`), а `#11` — лише в режимі test:matrix.
  // Обліковка в усіх трьох не рольова (ключ `X-Dashboard-Sso-Key` або посвідчення), тож
  // списки порожні — та сама форма, що в `/api/tracker/*` нижче.
  // Четвертий роут тієї ж родини (PR #tracker-user-sync): список людей для синхронізації.
  // Той самий ключ, та сама порожня обліковка — деталі в ROUTE_BOUNDARY_EXEMPTIONS.
  { method: "GET", path: "/api/auth/tracker-users", cls: "deny-only",
    allow: [], deny: [] },
  { method: "GET", path: "/api/auth/tracker-sso", cls: "deny-only",
    allow: [], deny: [] },
  { method: "POST", path: "/api/auth/tracker-assertion", cls: "deny-only",
    allow: [], deny: [] },
  { method: "POST", path: "/api/auth/tracker-identity", cls: "deny-only",
    allow: [], deny: [] },
  { method: "POST", path: "/api/tracker/auth", cls: "deny-only",
    allow: [], deny: [] },
  { method: "POST", path: "/api/tracker/heartbeat", cls: "deny-only",
    allow: [], deny: [] },
  { method: "POST", path: "/api/tracker/logout", cls: "deny-only",
    allow: [], deny: [] },
  { method: "POST", path: "/api/training/folder", cls: "deny-only",
    allow: [], deny: ["hr", "team_lead", "manager"] },
  { method: "DELETE", path: "/api/training/folder/:id", cls: "DELETE-ghost",
    allow: ["admin", "ceo", "opdir", "kvp", "financier"], deny: ["hr", "team_lead", "manager"] },
  { method: "PATCH", path: "/api/training/folder/:id", cls: "deny-only",
    allow: [], deny: ["hr", "team_lead", "manager"] },
  { method: "POST", path: "/api/training/material", cls: "deny-only",
    allow: [], deny: ["hr", "team_lead", "manager"] },
  { method: "DELETE", path: "/api/training/material/:id", cls: "DELETE-ghost",
    allow: ["admin", "ceo", "opdir", "kvp", "financier"], deny: ["hr", "team_lead", "manager"] },
  { method: "PATCH", path: "/api/training/material/:id", cls: "deny-only",
    allow: [], deny: ["hr", "team_lead", "manager"] },
  { method: "GET", path: "/api/training/material/:id/file", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager"], deny: [] },
  { method: "POST", path: "/api/training/materials/:id/publish", cls: "deny-only",
    allow: [], deny: ["hr", "team_lead", "manager"] },
  { method: "GET", path: "/api/training/tree", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager"], deny: [] },
  { method: "POST", path: "/api/uploads", cls: "deny-only",
    allow: [], deny: [] },
];

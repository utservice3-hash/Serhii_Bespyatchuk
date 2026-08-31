import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.join(__dirname, "..", ".env") });

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  // Node.js-режим adm.tools інжектить PORT (3000 у IP-режимі) і HOST (127.X.X.X).
  // Fallback 4000 + host=undefined → у СТАРОМУ режимі (Supervisor+Apache proxy) слухаємо
  // 0.0.0.0:4000 як раніше; тому цей код безпечний і ДО, і ПІСЛЯ перемикання панелі.
  port: Number(process.env.PORT ?? 4000),
  // ⚠️ adm.tools інжектить HOST як ПОВНИЙ URL, напр. "http://127.1.9.113:3000" — не голий
  // IP. app.listen(port, hostname) хоче саме hostname → парсимо URL і беремо .hostname
  // (127.1.9.113). Голий IP/hostname лишаємо як є. Порожньо (старий режим/дев) → undefined.
  host: (() => {
    const raw = process.env.HOST;
    if (!raw) return undefined;
    try {
      return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? new URL(raw).hostname : raw;
    } catch {
      return raw;
    }
  })(),
  databaseUrl: required("DATABASE_URL"),
  jwtSecret: required("JWT_SECRET"),
  kommo: {
    baseUrl: required("KOMMO_BASE_URL"),
    token: required("KOMMO_API_TOKEN"),
  },
  lardi: {
    // Lardi-Trans Extended API token (RAW, no Bearer). Optional — the rates
    // calculator returns a clear error until it is set in .env on the server.
    token: process.env.LARDI_API_TOKEN ?? "",
    lang: process.env.LARDIWEB_LANG ?? "ru",
  },
  // Трекер часу — ОКРЕМА наша система: свій репозиторій (timeTrackerManager), свій сервер, своя
  // база користувачів. Дашборд для нього постачальник особи, не власник прав.
  //
  // Обидві змінні опційні й типово порожні: без них пункт меню не рендериться, а ендпоінти
  // віддають 503. Це навмисно не required() — дашборд мусить підніматися без трекера, бо трекер
  // викочується окремим конвеєром і може бути недоступним у момент нашого деплою.
  tracker: {
    // Одна адреса, а не дві. З неї будується і зворотний виклик на `/api/v1/sso/ticket`, і
    // адреса для браузера з `#ticket=...`. Спільне походження — це те, на чому тримається обмін
    // квитка на куку, і одна змінна робить структурно неможливим зламати його нарізно.
    url: (process.env.TRACKER_URL ?? "").replace(/\/+$/, ""),
    // СЕКРЕТ — лише з env, у репо не тримати. Генерується на хості: openssl rand -hex 32.
    ssoKey: process.env.TRACKER_SSO_KEY ?? "",
  },
  ringostat: {
    // Auth-key з Ringostat («Налаштування» → «Інтеграції» → «Ringostat API»).
    // СЕКРЕТ — лише з env, у репо не тримати. Порожньо → джоба дзвінків спить.
    // Фільтр по department Ringostat ВИДАЛЕНО (словник, техборг): він ненадійний,
    // мапимо тільки employee_fio → наша команда.
    authKey: process.env.RINGOSTAT_AUTH_KEY ?? "",
  },
  // 🔴 РАХУНКИ ДЕБІТОРКИ — ПРЯМО З 1С, без гугл-таблиці-посередника.
  // Таблиця була МІРОРОМ цього ж ендпоінта (її колонка «Сервис» містила цей URL),
  // і мірор губив: 296 рахунків у 1С проти 277 у таблиці, 0 зайвих (замір 21.08.2026).
  receivables1cUrl:
    process.env.RECEIVABLES_1C_URL ??
    "http://193.200.173.188:8010/rest-bk/hs/service/debit-balance-account-361",
  // ⚠️ Ключа `receivablesSheetUrl` (аркуш «выгрузка») БІЛЬШЕ НЕМАЄ — його ніхто не
  // читає, а мертвий ключ у конфізі читається як живий (урок `expected` у /teams).
  // Аркуш ЛІМІТІВ нижче — читається далі, він з 1С не приходить.
  receivablesLimitsSheetUrl:
    process.env.RECEIVABLES_LIMITS_SHEET_URL ??
    "https://docs.google.com/spreadsheets/d/1FTHbWRYFa_rWNsF4GvwZrf_fL5Vj5zf4ihBRv3LZw2s/export?format=csv&gid=1649291567",
  adBudgetSheetUrl:
    process.env.AD_BUDGET_SHEET_URL ??
    "https://docs.google.com/spreadsheets/d/1krromIuWfmyCR5BAup6kuVnCGaYdK3sA2AJt5Ksn3V0/export?format=csv&gid=0",
  // «Реєстр» лідоген-бота: кожен рядок = вхід ліда в «Нова заявка від
  // лідогенератора» (status 69716164). Джерело правди для «переданих заявок».
  leadgenRegistrySheetUrl:
    process.env.LEADGEN_REGISTRY_SHEET_URL ??
    "https://docs.google.com/spreadsheets/d/1l8qC5J9ELvvWIQIjZgBeE40ziOE_sD0QXRGAk3gMP6w/export?format=csv&gid=1481567112",
  // «Перший дотик»: результат AI-транскрибації дзвінка (Groq Whisper) + аналіз
  // ішим LLM. Кожен рядок = перший контакт менеджера з лідом реклами. Колонка
  // «Ціну озвучено» (так/ні) — джерело правди для показника «озвучення ціни в
  // перший дотик». Пише його uts-bot (гілка uts-bot-logic-review) у той самий
  // файл, що й реєстр лідогену, але в лист «Перший дотик».
  firstTouchSheetUrl:
    process.env.FIRST_TOUCH_SHEET_URL ??
    "https://docs.google.com/spreadsheets/d/1l8qC5J9ELvvWIQIjZgBeE40ziOE_sD0QXRGAk3gMP6w/gviz/tq?tqx=out:csv&sheet=%D0%9F%D0%B5%D1%80%D1%88%D0%B8%D0%B9%20%D0%B4%D0%BE%D1%82%D0%B8%D0%BA",
};

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
  port: Number(process.env.PORT ?? 4000),
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
  ringostat: {
    // Auth-key з Ringostat («Налаштування» → «Інтеграції» → «Ringostat API»).
    // СЕКРЕТ — лише з env, у репо не тримати. Порожньо → джоба дзвінків спить.
    authKey: process.env.RINGOSTAT_AUTH_KEY ?? "",
    // Назва відділу в Ringostat, що відповідає нашому `sales` (звірено з API).
    salesDepartment: process.env.RINGOSTAT_SALES_DEPT ?? "Менеджери з продажу",
  },
  receivablesSheetUrl:
    process.env.RECEIVABLES_SHEET_URL ??
    "https://docs.google.com/spreadsheets/d/1FTHbWRYFa_rWNsF4GvwZrf_fL5Vj5zf4ihBRv3LZw2s/export?format=csv&gid=0",
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

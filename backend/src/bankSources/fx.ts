// Курс валют → UAH. Пріоритет: курс із самої банк-транзакції (fxRate), інакше — курс НБУ
// на ДАТУ ПРОВОДКИ (кешується в fx_rates_daily). Джерело фолбеку: офіційний НБУ
// https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?date=YYYYMMDD&json (UAH за 1 од.).
import { pool } from "../db/pool.js";

const NBU_URL = "https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange";

interface NbuRow { cc: string; rate: number; exchangedate: string }

/** Чистий парсер відповіді НБУ → мапа currency→rate. Тестується без мережі. */
export function parseNbu(payload: unknown): Map<string, number> {
  const m = new Map<string, number>();
  if (Array.isArray(payload)) {
    for (const r of payload as NbuRow[]) {
      if (r && typeof r.cc === "string" && typeof r.rate === "number") m.set(r.cc.toUpperCase(), r.rate);
    }
  }
  return m;
}

function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

/** UAH за 1 одиницю валюти на дату. UAH→1. Кеш у fx_rates_daily; міс → тягнемо НБУ раз. */
export async function getRate(currency: string, date: Date): Promise<number> {
  const ccy = (currency || "UAH").toUpperCase();
  if (ccy === "UAH" || ccy === "980") return 1;
  const dateStr = date.toISOString().slice(0, 10);
  const cached = await pool.query<{ rate: string }>(
    `SELECT rate FROM fx_rates_daily WHERE rate_date=$1 AND currency=$2`, [dateStr, ccy]);
  if (cached.rows[0]) return Number(cached.rows[0].rate);

  const res = await fetch(`${NBU_URL}?date=${ymd(date)}&json`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`НБУ ${res.status}`);
  const rates = parseNbu(await res.json());
  // кешуємо всі валюти дня одним махом (наступні tx того ж дня — без мережі)
  for (const [cc, rate] of rates) {
    await pool.query(
      `INSERT INTO fx_rates_daily(rate_date,currency,rate,source) VALUES($1,$2,$3,'nbu')
       ON CONFLICT (rate_date,currency) DO NOTHING`, [dateStr, cc, rate]);
  }
  const r = rates.get(ccy);
  if (r == null) throw new Error(`НБУ: нема курсу ${ccy} на ${dateStr}`);
  return r;
}

/** Сума в UAH: банк-курс якщо є, інакше НБУ на дату проводки. UAH → як є. */
export async function toUah(amount: number, currency: string, fxRate: number | null, when: Date): Promise<{ amountUah: number; rate: number }> {
  const rate = fxRate ?? (await getRate(currency, when));
  return { amountUah: Math.round(amount * rate * 100) / 100, rate };
}

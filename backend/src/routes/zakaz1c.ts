/**
 * 🧾 «ТЕСТ ЗАКАЗ 1С» (/api/zakaz1c) — заміна віджета Genesis «Заказ 1С»: рахунок у 1С з вкладки угоди Kommo.
 * Уся логіка — у теці `zakaz1c/` (опис — `zakaz1c/README.md`); тут лише точка підключення, як `routes/counterparty.ts`.
 * Межа — підпис Kommo (`zakaz1c/kommoAuth.ts`), а не сесія дашборда; перемикач `ZAKAZ1C_MODE` (типово off).
 */
import { buildZakaz1cRouter } from "../zakaz1c/mount.js";

export const zakaz1cRouter = buildZakaz1cRouter();

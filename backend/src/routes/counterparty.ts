/**
 * 🤝 «Узгодження роботи з новим контрагентом» + «Перевірка контрагента» (/api/counterparty) і «Ліміти клієнтів»
 * (/api/client-limits) — пакет Сергія 23–24.10.2026. Логіка — код пакета без змін (`counterparty/server`); стик з дашбордом
 * (вхід, вкладка, роль, команда, ключ YouScore, файли, дебіторка) — `counterparty/mount.ts`. Роутери будуються ОДИН раз на
 * імпорті — Express знає всі роути одразу (як `routes/minusRegistry.ts`).
 */
import { buildClientLimitsRouter, buildCounterpartyRouter } from "../counterparty/mount.js";

export const counterpartyRouter = buildCounterpartyRouter();
export const clientLimitsRouter = buildClientLimitsRouter();

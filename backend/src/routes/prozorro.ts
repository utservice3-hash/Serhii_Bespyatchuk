import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { MAX_PUSH_ATTEMPTS } from "../core/prozorroPush.js";
import { canEditSettings, loadSettingsView, parseConfig, saveConfig } from "../core/prozorroSettings.js";
import { parsePeriod, prozorroStats } from "../core/prozorroStats.js";
import { cachedKommoCheck, loadReadiness } from "../core/prozorroReadiness.js";
import { kommoGet } from "../kommo/client.js";
import { commercialManagerSql, LEADGEN_DASH_TEAM_ID } from "../core/metrics.js";
import { rotationScopeSql } from "../core/prozorroAssign.js";

/**
 * 🏛 «ТЕНДЕРИ PROZORRO» — екран у групі «Клієнти» (задача #5299). Межа — вкладка `prozorro` (`ROUTE_TAB`, `requireAuth`):
 * її видано адміну, СЕО, ОД і КВП (`schema.sql`). Налаштування всередині — адмін і ОД (`SETTINGS_ROLES`; у Сергія роль `opdir`).
 * Логіка й SQL — у ядрі (`core/prozorroSettings.ts`, `core/prozorroStats.ts`), тут лише вхід і межі.
 */
export const prozorroRouter = Router();
/** Перевірка Kommo (етап і джерело на місці) — лише читання, не частіше ніж раз на 10 хв (`cachedKommoCheck`). */
const kommoCheck = cachedKommoCheck(kommoGet);
/** Хто може бути в черзі: комерційні менеджери (правило ядра) + «Лідогенерація», без КВП-відділу (задача 8731). */
const PEOPLE_SCOPE = rotationScopeSql(commercialManagerSql("m"), LEADGEN_DASH_TEAM_ID);
const settingsView = async () => ({ ...(await loadSettingsView(pool, MAX_PUSH_ATTEMPTS, PEOPLE_SCOPE)), readiness: await loadReadiness(pool, kommoCheck) });
prozorroRouter.use(requireAuth);

prozorroRouter.get("/stats", async (req, res) => {
  const p = parsePeriod(req.query.from, req.query.to);
  if (!p.ok) { res.status(400).json({ error: p.error }); return; }
  res.json(await prozorroStats(pool, p.from, p.to));
});

prozorroRouter.get("/settings", async (req, res) => {
  if (!canEditSettings(req.auth!.roleKey)) { res.status(403).json({ error: "Налаштування Prozorro-лідів — лише для адміністратора й операційного директора" }); return; }
  res.json(await settingsView());
});

prozorroRouter.put("/settings", async (req, res) => {
  if (!canEditSettings(req.auth!.roleKey)) { res.status(403).json({ error: "Налаштування Prozorro-лідів — лише для адміністратора й операційного директора" }); return; }
  const parsed = parseConfig(req.body);
  if (!parsed.ok) { res.status(400).json({ error: parsed.error }); return; }
  const who = (await pool.query<{ name: string | null }>("SELECT full_name AS name FROM users WHERE id = $1", [req.auth!.userId])).rows[0]?.name ?? req.auth!.email ?? null;
  const r = await saveConfig(pool, parsed.value, { userId: req.auth!.userId ?? null, name: who }, PEOPLE_SCOPE);
  if (!r.ok) { res.status(400).json({ error: r.error }); return; }
  res.json(await settingsView());
});

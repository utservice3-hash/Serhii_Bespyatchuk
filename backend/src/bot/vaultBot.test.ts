import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { vaultBotUsernameQuick } from "./vaultBot.js";

/**
 * 🔐 03.11.2026: Telegram перестав відповідати на `getMe` бота «UTS Сейф» (на будь-який інший токен — 0,1 с), і
 * `/secrets/status` чекав вічно — «Співробітники», «Плинність», «Exit» у «Наймі» впали в «скоро» всім, у кого право є.
 */
const SRC = (rel: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "src", rel), "utf8");
const FRONT = (rel: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", rel), "utf8");

/**
 * #3390 — СТАТУС СЕЙФА НЕ ЧЕКАЄ TELEGRAM: імʼя бота — щонайбільше N мс, далі `null` (дзеркало: швидка відповідь
 * доходить); обидва статуси (`/secrets/status`, `/team-vault/status`) беруть саме цю версію; кожен запит до Telegram —
 * з тайм-аутом. 🧨 Червоніє, якщо статус знову чекає `vaultBotUsername()` або прибрати тайм-аут запиту.
 * `timeout` тесту — щоб зависання статусу червоніло, а не вішало прогін.
 */
test("#3390 СТАТУС СЕЙФА НЕ ЧЕКАЄ TELEGRAM: імʼя бота — з межею часу, обидва статуси; запит до Telegram — з тайм-аутом", { timeout: 3000 }, async () => {
  const t0 = Date.now();
  const hung = await vaultBotUsernameQuick(60, () => new Promise<string | null>(() => undefined));
  assert.equal(hung, null, "🔴 зависле імʼя бота не замінилось на null");
  assert.ok(Date.now() - t0 < 1000, `🔴 статус чекав ${Date.now() - t0} мс — Telegram знову тримає вкладки`);
  assert.equal(await vaultBotUsernameQuick(1000, async () => "uts_safe_bot"), "uts_safe_bot", "🔴 швидка відповідь не дійшла (дзеркало)");
  assert.equal(await vaultBotUsernameQuick(1000, async () => { throw new Error("x"); }), null, "🔴 помилка Telegram зламала статус");
  for (const f of ["routes/secrets.ts", "routes/teamVault.ts"]) {
    assert.match(SRC(f), /botUsername: vaultBotConfigured\(\) \? await vaultBotUsernameQuick\(\) : null,/, `🔴 ${f}: статус чекає Telegram без межі`);
  }
  const bot = SRC("bot/vaultBot.ts");
  assert.match(bot, /host: "api\.telegram\.org", path, method: "POST", family: 4, timeout: timeoutMs,/, "🔴 запит до Telegram без тайм-ауту");
  assert.match(bot, /req\.on\("timeout", \(\) => req\.destroy\(/, "🔴 тайм-аут не обриває запит");
});

/**
 * #3390b — «СКОРО» ЛИШЕ ПРИ СПРАВЖНІЙ ВІДМОВІ: вкладки «Найму» ховаються, лише коли сервер відповів 401/403; тайм-аут
 * чи збій ≠ «немає права» (дані вкладок однаково гейтить сервер). 🧨 Червоніє, якщо повернути `.catch(() => false)`.
 */
test("#3390b «НАЙМ»: «скоро» лише коли сервер відмовив (401/403), а не при тайм-ауті чи збої", () => {
  const s = FRONT("pages/dashboard/sections/HiringSection.tsx");
  assert.match(s, /fetchSecretsStatus\(\)\.then\(\(\) => setCanSecrets\(true\)\)\.catch\(\(e\) => setCanSecrets\(!denied\(e\)\)\)/, "🔴 «Співробітники/Плинність/Exit» падають у «скоро» від будь-якої помилки");
  assert.match(s, /fetchTeamVaultStatus\(\)\.then\(\(\) => setCanTeam\(true\)\)\.catch\(\(e\) => setCanTeam\(!denied\(e\)\)\)/, "🔴 тімлідові «Співробітники» падають у «скоро» від будь-якої помилки");
  assert.match(s, /return st === 401 \|\| st === 403;/, "🔴 «відмова» — не 401/403");
});

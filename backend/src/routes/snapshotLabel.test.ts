import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { needsApi, API_BASE } from "../testMode.js";
import { kyivMonthBounds } from "../core/dates.js";

/**
 * #64 — ЗНІМКОВІ ПОКАЗНИКИ ПРИ НЕПОТОЧНОМУ ПЕРІОДІ ПІДПИСАНІ.
 *
 * 🔴 ПРИВІД — ДІАГНОЗ 07.08.2026, підтверджений числами. Дебіторка, перехідні й
 * очікування показують стан «зараз» і від періоду НЕ залежать: `receivablesTotal`
 * = 9 446 853 ₴ однаковий за липень, за тиждень 21–27.07 і за один день 15.07.
 * Числа при цьому ПРАВИЛЬНІ — бреше подача, бо людина читає їх як «за липень».
 * Саме це давало відчуття «навігація по періодах бреше».
 *
 * 🟢 Рішення власника — ПІДПИСУВАТИ, не ховати: сховане число шукають і питають,
 * чи не зламалось.
 *
 * ⚠️ ЧОМУ ГЕЙТ ДВОСКЛАДОВИЙ. Підпис малює ФРОНТ, а прапорець дає API. Перевіряти
 * лише API — значить зеленіти, коли підпису на екрані немає; лише фронт — зеленіти,
 * коли прапорець завжди `true` і підпис не зʼявиться ніколи. Тому обидва.
 */
const FE = fileURLToPath(new URL(
  "../../../frontend/src/pages/dashboard/sections/OverviewSection.tsx", import.meta.url));

const strip = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

test("#64 API розрізняє поточний і непоточний період", needsApi(), async () => {
  const { signToken } = await import("../auth/auth.js");
  const token = signToken({ userId: 0, role: "admin", roleKey: "admin", managerId: null, teamId: null });
  const H = { Authorization: `Bearer ${token}` };
  const ym = kyivMonthBounds().ym;
  const to = kyivMonthBounds().to;

  const cur = await (await fetch(`${API_BASE}/api/dashboard/overview?from=${ym}-01&to=${to}`, { headers: H })).json() as
    { scope?: { isCurrent: boolean }; receivablesTotal: number };
  const past = await (await fetch(`${API_BASE}/api/dashboard/overview?from=2026-07-01&to=2026-07-31`, { headers: H })).json() as
    { scope?: { isCurrent: boolean }; receivablesTotal: number };

  assert.ok(cur.scope && past.scope, "🔴 у відповіді нема `scope` — фронту нема за чим підписувати");
  assert.equal(cur.scope!.isCurrent, true, "🔴 поточний місяць позначено як НЕпоточний");
  assert.equal(past.scope!.isCurrent, false, "🔴 липень позначено як поточний — підпис не зʼявиться там, де потрібен");

  // ⚠️ Порожній результат = ПРОВАЛ: доводимо, що показник СПРАВДІ знімковий,
  // інакше підписувати нема чого й гейт охороняє порожнечу.
  assert.equal(cur.receivablesTotal, past.receivablesTotal,
    `🔴 дебіторка за поточний (${cur.receivablesTotal}) і за липень (${past.receivablesTotal}) РІЗНІ — `
    + "показник перестав бути знімковим, і підпис «станом на сьогодні» тепер бреше");
});

test("#64b фронт малює підпис, і лише при непоточному періоді", async () => {
  const src = strip(await readFile(FE, "utf8"));
  assert.ok(src.includes("станом на сьогодні · не за обраний період"),
    "🔴 підпис зник із Огляду — знімкові числа знову читаються як «за обраний період»");

  // Дзеркало: підпис УМОВНИЙ. Постійний підпис перестає читатись і стає шумом.
  assert.ok(/if \(isCurrent\) return null;/.test(src),
    "🔴 підпис більше не умовний — при поточному періоді він стане шумом і його перестануть бачити");

  // Усі ЧОТИРИ знімкові плитки підписані: дебіторка, перехідні, і двоє «очікувань».
  const n = (src.match(/<SnapshotNote/g) ?? []).length;
  assert.ok(n >= 3,
    `🔴 підписано лише ${n} знімкових плиток — решта лишились без пояснення, а це саме ті числа, `
    + "через які й виникало питання до навігації");
});

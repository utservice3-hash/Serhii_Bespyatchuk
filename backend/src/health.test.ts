import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { buildVersion } from "./version.js";
import { needsApi, API_BASE } from "./testMode.js";

/**
 * ТЕСТ #1 — ВЕРСІЯ КОДУ В HEALTH.
 *
 * Питання, на яке він відповідає: «чи прод крутить САМЕ те, що ми щойно викотили».
 * Досі health відповідав лише «чи живий процес» — і одного разу 11 годин віддавав
 * 200, поки прод крутив старий код (рестарт убив не той PID). Прогін цього тесту
 * ОДРАЗУ після викату — приймання деплою самим собою.
 *
 *   npm run test:prod                       # проти локального API
 *   TEST_SCOPE=prod API_BASE=http://127.1.9.113:3000 npm test   # проти прод-рантайму
 */

test("version.json зібрано і має реальний sha (а не вигаданий)", () => {
  const v = buildVersion();
  if (v.sha === "unknown") {
    // Так буває при запуску через tsx без збірки. Це не привід «пройти» мовчки.
    assert.fail("dist/version.json відсутній — прожени npm run build перед тестом");
  }
  assert.match(v.sha, /^[0-9a-f]{40}$/, "sha має бути повним git-хешем");
  assert.equal(v.shortSha, v.sha.slice(0, 7));
  assert.ok(v.builtAt && !Number.isNaN(Date.parse(v.builtAt)), "builtAt має бути валідною датою");
});

test("ТЕСТ #1: /api/health віддає версію, і вона == зібраній", needsApi(), async () => {
  const res = await fetch(`${API_BASE}/api/health`);
  assert.equal(res.status, 200, "health має відповідати 200");
  const body = (await res.json()) as { ok?: boolean; version?: { sha?: string; shortSha?: string } };
  assert.equal(body.ok, true);
  assert.ok(body.version, "у health немає поля version — приймання деплою неможливе");
  assert.equal(
    body.version.sha,
    buildVersion().sha,
    `рантайм крутить ${body.version.shortSha}, а зібрано ${buildVersion().shortSha} — ` +
      "процес НЕ перезапустився на новий код (саме цей випадок коштував нам 11 годин)"
  );
});

test("ТЕСТ #1b: рантайм == HEAD робочої копії", needsApi(), async () => {
  let head: string;
  try {
    head = execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return; // не git-каталог — попередній тест уже перевірив зібране↔рантайм
  }
  const res = await fetch(`${API_BASE}/api/health`);
  const body = (await res.json()) as { version?: { sha?: string; shortSha?: string } };
  assert.equal(
    body.version?.sha,
    head,
    `рантайм ${body.version?.shortSha} ≠ HEAD ${head.slice(0, 7)} — викотили не те, ` +
      "або збірка не перезібралась після pull"
  );
});

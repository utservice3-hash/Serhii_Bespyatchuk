import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 🚚 ПЛАШКА «ПЕРЕВІЗНИК У КОМЕНТАРІ» (05.10.2026, зворотний звʼязок #104/#69).
 * Імпорт ядра — лінивий: `clientArchive` тягне модулі, що можуть читати конфіг на імпорті.
 */
const ROOT = path.join(import.meta.dirname, "..", "..", "..");

test("#1380 «ПЕРЕВІЗНИК» У КОМЕНТАРІ: кирилична й латинська і, будь-який регістр — так; «перевозка», «перевезення», «перевірити» — ні", async () => {
  const { carrierCommentHit } = await import("./clientArchive.js");
  for (const t of ["перевізник", "Перевізник ОЛХ", "ПЕРЕВІЗНИК", "Перевiзник (латинська i)", "Марина, перевізник", "перевізники"]) {
    assert.equal(carrierCommentHit(t), true, `🔴 не впізнано: «${t}»`);
  }
  for (const t of ["перевозка зерна", "перевезення по Києву", "треба перевірити", "клієнт", "", null]) {
    assert.equal(carrierCommentHit(t as string | null), false, `🔴 хибно впізнано: «${t}»`);
  }
});

test("#1380b РОУТИ ПЛАШКИ: межа першою дією; масова дія архівує ЛИШЕ поточних кандидатів у скоупі й з причиною «Перевізник»", () => {
  const src = readFileSync(path.join(ROOT, "backend/src/routes/dashboard.ts"), "utf8");
  for (const r of ['dashboardRouter.get("/client-archive/carrier-candidates"', 'dashboardRouter.post("/client-archive/carriers"']) {
    const at = src.indexOf(r);
    assert.ok(at > 0, `🔴 роут ${r} не знайдено`);
    assert.match(src.slice(at, at + 220), /const auth = req\.auth!;\s*if \(!isAdminOrLead\(auth\)\) return res\.status\(403\)/,
      `🔴 ${r}: межа доступу не першою дією — менеджер дістався б до списку чи запису`);
  }
  const post = src.slice(src.indexOf('dashboardRouter.post("/client-archive/carriers"'));
  const body = post.slice(0, post.indexOf("\n});") + 4);
  assert.match(body, /carrierCandidatesSql\(clamp, `\$\$\{params\.length\}`\)/, "🔴 масова дія не звіряє ключі з кандидатами — архівувала б будь-кого");
  assert.match(body, /ownerTeamClamp\(leadTeamId/, "🔴 масова дія без клампу команди — тімлід заархівував би чужих");
  assert.match(body, /archive_reason = 'carrier'/, "🔴 причина архівації не «Перевізник»");
  assert.match(body, /logClientAdmin\("archive"/, "🔴 масова архівація без сліду в журналі дій над клієнтом");
});

test("#1380c ФРОНТ: плашка лише керівникам, галочки увімкнені за замовчуванням, після дії список клієнтів перечитується", () => {
  const sec = readFileSync(path.join(ROOT, "frontend/src/pages/dashboard/sections/ClientPlansSection.tsx"), "utf8");
  assert.match(sec, /\{auth\.role !== "manager" && <CarrierCommentBanner onArchived=\{load\} \/>\}/, "🔴 плашки немає або її бачить менеджер");
  const ban = readFileSync(path.join(ROOT, "frontend/src/pages/dashboard/sections/CarrierCommentBanner.tsx"), "utf8");
  assert.match(ban, /setPicked\(new Set\(d\.clients\.map\(\(c\) => c\.clientKey\)\)\)/, "🔴 галочки вже не увімкнені за замовчуванням (рішення Романа 05.10)");
  // Підтвердження — діалогом дашборда з 09.10.2026 (прохід B, `#1510`); твердження те саме: без «так» не архівуємо.
  assert.match(ban, /if \(!\(await dlg\.confirm\(/, "🔴 масова архівація без підтвердження");
});

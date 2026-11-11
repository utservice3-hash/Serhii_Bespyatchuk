import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { forEachLeadAttachmentPage, kommoDriveFile, KommoFileError } from "../kommo/client.js";
import { isKommoPaused } from "../kommo/pause.js";
import { processInChunks } from "./chunkWindow.js";
import { createRunGuard, type GuardSkip } from "./runGuard.js";
import { jobSkip, type JobSkip } from "./jobRuns.js";
import { geminiGenerate, GEMINI_MODEL } from "../core/callAiProviders.js";
import { LLM_POLICY, LLM_PROVIDER } from "../core/callAiPilot.js";
import { monthSpend } from "../core/callAiPipeline.js";
import { VendorError, RETRYABLE } from "../core/callAiHttp.js";
import {
  screenVerdict, insertScreens, queuedScreens, screenAttemptFailed, markScreensCapped, recordScreenResult,
  buildScreenRequest, interpretScreen, SCREENS_FROM_UNIX, SCREEN_MAX_BYTES, SCREEN_INPUT_TOKENS_BOUND,
  SCREEN_MAX_OUTPUT_TOKENS, type ScreenRow, type SkipReason,
} from "../core/kommoScreens.js";

/**
 * 📎 СКРІНИ З УГОД KOMMO → КОНТАКТИ КЛІЄНТА + AI-КОМЕНТАР (задача 8347). Двічі на годину (:20 і :50 за Києвом).
 *
 * Крок 1 — синк: нотатки-вкладення угод від вотермарка (`sync_state.kommo_screens_note_at`, перший прохід — від
 * 11.11.2026), порціями ≤24 год; картинка від людини → рядок `client_contacts` з каналом `kommo` і статусом AI `queued`.
 * Крок 2 — AI: черга порціями, доки не вийде бюджет часу; кожен виклик пишеться в `ai_spend_ledger` і рахується в
 * спільну стелю Gemini. Без ключа чи цін — крок 2 не йде (рядки чекають у черзі), джоба зелена й каже це словами.
 *
 * Лог — обсяг, а не «відпрацювала»: скільки вкладень побачили, скільки взяли, скільки відкинули й чому.
 */
const guard = createRunGuard("syncKommoScreens");

const AI_BUDGET_MS = 4 * 60_000;
const AI_PORTION = 10;

export interface ScreensReport {
  seen: number; taken: number; inserted: number; noClient: number; skipped: Partial<Record<SkipReason, number>>;
  ai: { done: number; chat: number; failed: number; capped: number; stoppedBy: string | null };
}

async function syncStep(report: ScreensReport): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const r = await pool.query<{ at: Date | null }>(`SELECT kommo_screens_note_at AS at FROM sync_state WHERE id = 1`);
  const last = r.rows[0]?.at;
  // Перекриття 5 хв: нотатка, оновлена на межі вікна, не губиться; повтор — не новий рядок (унікальний `kommo_note_id`).
  const since = Math.max(SCREENS_FROM_UNIX, last ? Math.floor(last.getTime() / 1000) - 300 : SCREENS_FROM_UNIX);
  await processInChunks(since, now, async (from, to) => forEachLeadAttachmentPage(from, to, async (notes) => {
    report.seen += notes.length;
    const rows: ScreenRow[] = [];
    for (const n of notes) {
      const v = screenVerdict(n);
      if (!v.take) { report.skipped[v.why] = (report.skipped[v.why] ?? 0) + 1; continue; }
      rows.push({ noteId: n.id, dealId: n.entityId, fileUuid: n.fileUuid!, fileName: n.originalName, mime: v.mime,
        authorKommoId: n.createdBy, createdAtUnix: n.createdAt });
    }
    report.taken += rows.length;
    const ins = await insertScreens(pool, rows);
    report.inserted += ins.inserted;
    report.noClient += ins.noClient;
  }), (chunkUntil) => pool.query(`UPDATE sync_state SET kommo_screens_note_at = $1 WHERE id = 1`, [new Date(chunkUntil * 1000)]).then(() => {}));
}

async function aiStep(report: ScreensReport): Promise<void> {
  const key = config.callAi.geminiApiKey;
  const { llmUsdPerMtokIn, llmUsdPerMtokOut, llmMonthCapUsd } = config.callAi.prices;
  if (!key) { report.ai.stoppedBy = "ключ Gemini не задано — скріни чекають у черзі"; return; }
  if (llmUsdPerMtokIn == null || llmUsdPerMtokOut == null || llmMonthCapUsd == null) {
    report.ai.stoppedBy = "ціни чи стелю Gemini не задано — скріни чекають у черзі"; return;
  }
  const inPrice = llmUsdPerMtokIn / 1e6, outPrice = llmUsdPerMtokOut / 1e6;
  const estimate = SCREEN_INPUT_TOKENS_BOUND * inPrice + SCREEN_MAX_OUTPUT_TOKENS * outPrice;
  const http = { fetch, sleep: (ms: number) => new Promise<void>((res) => setTimeout(res, ms)), nowMs: () => Date.now() };
  const t0 = Date.now();
  while (Date.now() - t0 < AI_BUDGET_MS) {
    const rows = await queuedScreens(pool, AI_PORTION);
    if (!rows.length) return;
    const spend = await monthSpend(pool, LLM_PROVIDER, new Date());
    let spent = spend.usd;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (spend.unpriced > 0 || spent + estimate > llmMonthCapUsd) {
        const rest = rows.slice(i).map((x) => x.id);
        await markScreensCapped(pool, rest);
        report.ai.capped += rest.length;
        report.ai.stoppedBy = spend.unpriced > 0
          ? "у журналі витрат є рядки без ціни — стеля закрита"
          : `стеля Gemini місяця: ${spent.toFixed(2)} із ${llmMonthCapUsd.toFixed(2)} USD`;
        return;
      }
      let file: { bytes: Uint8Array };
      try {
        file = await kommoDriveFile(row.fileUuid, SCREEN_MAX_BYTES);
      } catch (e) {
        const final = e instanceof KommoFileError && e.final;
        await screenAttemptFailed(pool, row.id, (e as Error).message, final);
        report.ai.failed++;
        continue;
      }
      const body = buildScreenRequest(file.bytes, row.mime);
      let out;
      try {
        out = await geminiGenerate(http, key, GEMINI_MODEL, body, LLM_POLICY);
      } catch (e) {
        if (e instanceof VendorError && !RETRYABLE.has(e.kind)) {
          // Ключ / оплата / доступ — повтор цієї ж хвилини нічого не дасть; рядок лишається в черзі, тік червоний.
          throw new Error(`Gemini: ${e.message}`);
        }
        await screenAttemptFailed(pool, row.id, (e as Error).message, false);
        report.ai.failed++;
        continue;
      }
      const v = interpretScreen(out.text, out.blockReason);
      const inUnits = out.usage ? out.usage.input : SCREEN_INPUT_TOKENS_BOUND;
      const outUnits = out.usage ? out.usage.output : SCREEN_MAX_OUTPUT_TOKENS;
      await recordScreenResult(pool, {
        id: row.id, noteId: row.noteId, at: new Date(), provider: LLM_PROVIDER,
        inputTokens: inUnits, outputTokens: outUnits, unitSuffix: out.usage ? "" : "_bound",
        usdPerInputToken: inPrice, usdPerOutputToken: outPrice, verdict: v,
      });
      spent += inUnits * inPrice + outUnits * outPrice;
      if (v.ok) { report.ai.done++; if (v.kind === "chat") report.ai.chat++; } else report.ai.failed++;
    }
  }
}

export async function syncKommoScreens(): Promise<ScreensReport | GuardSkip | JobSkip> {
  if (isKommoPaused()) return jobSkip("Kommo на паузі (KOMMO_PAUSED)");
  return guard(async () => {
    const report: ScreensReport = { seen: 0, taken: 0, inserted: 0, noClient: 0, skipped: {},
      ai: { done: 0, chat: 0, failed: 0, capped: 0, stoppedBy: null } };
    await syncStep(report);
    await aiStep(report);
    const sk = Object.entries(report.skipped).map(([k, n]) => `${k} ${String(n)}`).join(", ") || "0";
    const q = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM client_contacts WHERE channel = 'kommo' AND ai_status IN ('queued', 'capped')`);
    console.log(`syncKommoScreens: вкладень ${String(report.seen)} → скрінів ${String(report.taken)} (відкинуто: ${sk}), `
      + `нових контактів ${String(report.inserted)}, без клієнта ${String(report.noClient)} · `
      + `AI прочитав ${String(report.ai.done)} (переписка ${String(report.ai.chat)}), невдало ${String(report.ai.failed)}, `
      + `у черзі ${String(q.rows[0]?.n ?? 0)}` + (report.ai.stoppedBy ? ` · ${report.ai.stoppedBy}` : ""));
    return report;
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncKommoScreens()
    .then((r) => { console.log(JSON.stringify(r)); return pool.end(); })
    .catch((err) => { console.error(err); process.exit(1); });
}

import type { Db } from "./adCallFacts.js";
import type { HttpDeps } from "./callAiHttp.js";
import { downloadRecording, RECORDING_UNAVAILABLE_UA } from "./ringostatRecording.js";
import { RECORDING_MAX_BYTES, RINGOSTAT_POLICY } from "./callAiPilot.js";

/**
 * 🎧 ЗАПИС РОЗМОВИ ДЛЯ ПРОСЛУХОВУВАННЯ У ВКЛАДЦІ «Перевізники за розмовою».
 *
 * Посилання Ringostat на запис відкривається БЕЗ логіну, тож у браузер воно не йде ніколи: сервер сам бере
 * запис і віддає байти тим, кому дозволено (рішення Романа 29.09.2026, варіант А — лише адмін і КВП, як повний
 * текст у «Першому дотику»). Лише дзвінки цієї вкладки: чужий дзвінок — «не знайдено», а не запис.
 */
export async function carrierRecording(db: Db, uniqueid: string, http: HttpDeps):
  Promise<{ ok: true; bytes: Uint8Array } | { ok: false; code: 404 | 502; why: string }> {
  const r = (await db.query<{ recording: string | null }>(`
    SELECT rc.recording FROM ringostat_calls rc
     WHERE rc.uniqueid = $1
       AND EXISTS (SELECT 1 FROM carrier_call_deals d WHERE d.uniqueid = rc.uniqueid OR d.first_uniqueid = rc.uniqueid)`,
  [uniqueid])).rows[0];
  if (!r) return { ok: false, code: 404, why: "дзвінка немає серед дзвінків на мобільні" };
  const got = await downloadRecording(http, r.recording, { ...RINGOSTAT_POLICY, maxBytes: RECORDING_MAX_BYTES });
  if (!got.ok) return { ok: false, code: got.unavailable === "not_found" || got.unavailable === "no_url" ? 404 : 502, why: RECORDING_UNAVAILABLE_UA[got.unavailable] };
  return { ok: true, bytes: got.bytes };
}

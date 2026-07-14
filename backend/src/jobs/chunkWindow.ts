/**
 * Спільне ядро для інкрементних Kommo-джоб на events API (`syncStageEvents`,
 * `syncDealActivity`, `syncTransfers`): обробити [sinceUnix, untilUnix] ПОРЦІЯМИ
 * ≤`chunkSeconds` і рухати вотермарк ПІСЛЯ КОЖНОЇ завершеної порції.
 *
 * Виправляє пастку «все або нічого»: раніше вотермарк рухався лише ПІСЛЯ повного
 * проходу всього вікна — один збій за десятки сторінок втрачав увесь прогрес; вікно
 * росло щодня → само-підсилювана стагнація (усі три вотермарки замерзли на IP-бані
 * 08.07: гроші/активність/передачі тихо відставали, а звірка цього не бачила).
 * Тепер збій втрачає лише поточну порцію; велика діра затягується за кілька порцій.
 * 24-год порція ще й обходить пагінаційний кап Kommo events (~20к/прохід).
 *
 * `onChunkDone` викликається ПІСЛЯ кожної успішної порції (рух вотермарка). Для
 * бекфілу передають null — вотермарк не чіпаємо.
 */
export const DEFAULT_CHUNK_SECONDS = 24 * 60 * 60;

export async function processInChunks(
  sinceUnix: number,
  untilUnix: number,
  processChunk: (fromUnix: number, toUnix: number) => Promise<number>,
  onChunkDone: ((chunkUntil: number) => Promise<void>) | null,
  chunkSeconds = DEFAULT_CHUNK_SECONDS
): Promise<number> {
  let cursor = sinceUnix;
  let total = 0;
  while (cursor < untilUnix) {
    const chunkUntil = Math.min(cursor + chunkSeconds, untilUnix);
    total += await processChunk(cursor, chunkUntil);
    if (onChunkDone) await onChunkDone(chunkUntil);
    cursor = chunkUntil;
  }
  return total;
}

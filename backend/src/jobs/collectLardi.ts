import { pool } from "../db/pool.js";
import { hasLardiToken } from "../lardi/client.js";
import { listRoutes, recordOffers } from "../lardi/history.js";
import { lardiSearch, parseOffers, haversineKm } from "../routes/rates.js";
import { runLardiCollect, type CollectTally } from "../core/lardiCollect.js";

const ROAD_FACTOR = 1.25;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
type Route = Awaited<ReturnType<typeof listRoutes>>[number];
const kmOf = (rt: Route): number | null => {
  const hav = haversineKm(rt.from_lat, rt.from_lon, rt.to_lat, rt.to_lon);
  return hav ? Math.round(hav * ROAD_FACTOR) : null;
};

/**
 * Збирач архіву цін (аналог lardiweb collect.py + systemd-таймер): переопитує
 * маршрути, які менеджери запитували за останні 14 днів, і докладає нові
 * пропозиції в історію (дедуп за ID заявки). Так база цін росте навіть між
 * заходами менеджерів. Запускається кроном кожні 3 години.
 *
 * 🔴 Логіка проходу й вирок — у `core/lardiCollect.ts`: відмова Lardi в доступі чи нуль відповідей за прохід —
 * це ПАДІННЯ джоби (а з ним тривога), а не «успіх із нулем», як було 17.09–12.10.
 */
export async function collectLardi(): Promise<CollectTally | null> {
  if (!hasLardiToken()) return null;
  const t = await runLardiCollect<Route>({
    listRoutes: () => listRoutes(14),
    search: (kind, rt) => lardiSearch(`/v2/proposals/search/${kind}`, { frm: { town_id: rt.from_id }, to: { town_id: rt.to_id } }, false),
    record: async (kind, rt, content) => recordOffers(rt.from_id, rt.to_id, kind, parseOffers(content as Parameters<typeof parseOffers>[0], kmOf(rt)).offers),
    sleep,
  });
  console.log(t.routes
    ? `collectLardi: done, new rows: ${String(t.newRows)} across ${String(t.routes)} routes (відповідей 200: ${String(t.ok)} з ${String(t.requests)}).`
    : "collectLardi: no routes to collect yet");
  return t;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  collectLardi()
    .then(() => pool.end())
    .catch((err) => { console.error(err); process.exit(1); });
}

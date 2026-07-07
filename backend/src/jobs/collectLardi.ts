import { pool } from "../db/pool.js";
import { hasLardiToken } from "../lardi/client.js";
import { listRoutes, recordOffers } from "../lardi/history.js";
import { lardiSearch, parseOffers, haversineKm } from "../routes/rates.js";

const ROAD_FACTOR = 1.25;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Збирач архіву цін (аналог lardiweb collect.py + systemd-таймер): переопитує
 * маршрути, які менеджери запитували за останні 14 днів, і докладає нові
 * пропозиції в історію (дедуп за ID заявки). Так база цін росте навіть між
 * заходами менеджерів. Запускається кроном кожні 3 години.
 */
export async function collectLardi(): Promise<void> {
  if (!hasLardiToken()) return;
  const routes = await listRoutes(14);
  if (!routes.length) { console.log("collectLardi: no routes to collect yet"); return; }
  let total = 0;
  for (const rt of routes) {
    const hav = haversineKm(rt.from_lat, rt.from_lon, rt.to_lat, rt.to_lon);
    const km = hav ? Math.round(hav * ROAD_FACTOR) : null;
    for (const kind of ["cargo", "lorry"] as const) {
      try {
        const r = await lardiSearch(`/v2/proposals/search/${kind}`, {
          frm: { town_id: rt.from_id }, to: { town_id: rt.to_id },
        }, false);
        if (r.code !== 200 || !r.content) continue;
        const offers = parseOffers(r.content, km).offers;
        total += await recordOffers(rt.from_id, rt.to_id, kind, offers);
      } catch { /* skip this side */ }
    }
    await sleep(1000); // бережемо Lardi від частих запитів
  }
  console.log(`collectLardi: done, new rows: ${total} across ${routes.length} routes.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  collectLardi()
    .then(() => pool.end())
    .catch((err) => { console.error(err); process.exit(1); });
}

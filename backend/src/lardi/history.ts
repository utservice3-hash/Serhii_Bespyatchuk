import { pool } from "../db/pool.js";

// Порт lardiweb history.py на Postgres: власний архів цін (Lardi не віддає
// історію), маршрути для збирача і статистика використання.

export interface HistOffer {
  cargo: string | null; mass: number | null; load_type: string | null;
  total: number | null; per_ton: number | null; per_km: number | null;
  is_uah: boolean; currency: string | null; negotiable: boolean;
  bodies: string[]; company: string | null; face: string | null;
  phones: { n: string; m: unknown[] }[];
  from: string | null; to: string | null; dist_km: number | null;
  date: string | null; id: number; ts: number; payform: string | null;
}

export interface RoutePoint { town_id: number; area_id?: number | null; lat?: number | null; lon?: number | null; label?: string }

export async function recordRoute(frm: RoutePoint, to: RoutePoint): Promise<void> {
  await pool.query(
    `INSERT INTO lardi_routes (from_id, to_id, from_name, to_name, from_area, to_area,
        from_lat, from_lon, to_lat, to_lon, last_query)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
     ON CONFLICT (from_id, to_id) DO UPDATE SET
       last_query = now(), from_lat = EXCLUDED.from_lat, from_lon = EXCLUDED.from_lon,
       to_lat = EXCLUDED.to_lat, to_lon = EXCLUDED.to_lon`,
    [frm.town_id, to.town_id, frm.label ?? null, to.label ?? null, frm.area_id ?? null,
     to.area_id ?? null, frm.lat ?? null, frm.lon ?? null, to.lat ?? null, to.lon ?? null]
  );
}

export async function recordOffers(
  fromId: number, toId: number, side: string,
  offers: { id?: unknown; cargo?: unknown; mass?: unknown; load_type?: unknown; total?: unknown;
    per_ton?: unknown; per_km?: unknown; is_uah?: unknown; currency?: unknown; negotiable?: unknown;
    bodies?: unknown; company?: unknown; face?: unknown; phones?: unknown; from?: unknown; to?: unknown;
    dist_km?: unknown; date?: unknown; payform?: unknown }[]
): Promise<number> {
  let added = 0;
  for (const o of offers) {
    if (!o.id) continue;
    const r = await pool.query(
      `INSERT INTO lardi_offers (side, offer_id, from_id, to_id, first_seen, cargo, mass,
          load_type, total, per_ton, per_km, is_uah, currency, negotiable, bodies, company,
          face, phones, frm, tox, dist_km, dt, payform)
       VALUES ($1,$2,$3,$4, now(), $5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       ON CONFLICT (side, offer_id, from_id, to_id) DO NOTHING`,
      [side, o.id, fromId, toId, o.cargo ?? null, o.mass ?? null, o.load_type ?? null,
       o.total ?? null, o.per_ton ?? null, o.per_km ?? null, Boolean(o.is_uah), o.currency ?? null,
       Boolean(o.negotiable), Array.isArray(o.bodies) ? o.bodies.join(",") : null,
       o.company ?? null, o.face ?? null, JSON.stringify(o.phones ?? []),
       o.from ?? null, o.to ?? null, o.dist_km ?? null, o.date ?? null, o.payform ?? null]
    );
    added += r.rowCount ?? 0;
  }
  return added;
}

/** Унікальні заявки за `days` днів з ts (unix) — фронт сам фільтрує вікно. */
export async function history(fromId: number, toId: number, side: string, days = 31, limit = 5000): Promise<HistOffer[]> {
  const r = await pool.query(
    `SELECT cargo, mass, load_type, total, per_ton, per_km, is_uah, currency, negotiable,
            bodies, company, face, phones, frm, tox, dist_km, dt, payform, offer_id,
            EXTRACT(EPOCH FROM first_seen)::bigint AS ts
       FROM lardi_offers
      WHERE from_id = $1 AND to_id = $2 AND side = $3 AND first_seen >= now() - ($4 || ' days')::interval
      ORDER BY first_seen DESC LIMIT $5`,
    [fromId, toId, side, days, limit]
  );
  return r.rows.map((x) => ({
    cargo: x.cargo, mass: x.mass != null ? Number(x.mass) : null, load_type: x.load_type,
    total: x.total != null ? Number(x.total) : null,
    per_ton: x.per_ton != null ? Number(x.per_ton) : null,
    per_km: x.per_km != null ? Number(x.per_km) : null,
    is_uah: Boolean(x.is_uah), currency: x.currency, negotiable: Boolean(x.negotiable),
    bodies: x.bodies ? String(x.bodies).split(",").filter(Boolean) : [],
    company: x.company, face: x.face,
    phones: Array.isArray(x.phones) ? x.phones : [],
    from: x.frm, to: x.tox,
    dist_km: x.dist_km != null ? Number(x.dist_km) : null,
    date: x.dt, id: Number(x.offer_id), ts: Number(x.ts), payform: x.payform,
  }));
}

/**
 * Самонавчання: агрегує НАКОПИЧЕНИЙ архів пропозицій по маршруту (from→to,
 * обидві сторони, лише UAH) за вікно `days` — медіана/квартилі грн/км і суми з
 * РЕАЛЬНИХ спостережених цін Ларді. Що більше історії, то надійніша оцінка.
 */
export async function learnedStats(fromId: number, toId: number, days = 120): Promise<{
  perKm: { n: number; median: number; p25: number; p75: number } | null;
  total: { n: number; median: number } | null;
  samples: number;
  since: string | null;
} | null> {
  const r = await pool.query<{
    n_perkm: string; med_perkm: string | null; p25_perkm: string | null; p75_perkm: string | null;
    n_total: string; med_total: string | null; n_all: string; since: string | null;
  }>(
    `SELECT
        COUNT(*) FILTER (WHERE is_uah AND per_km IS NOT NULL AND per_km > 0) AS n_perkm,
        percentile_cont(0.5)  WITHIN GROUP (ORDER BY per_km) FILTER (WHERE is_uah AND per_km IS NOT NULL AND per_km > 0) AS med_perkm,
        percentile_cont(0.25) WITHIN GROUP (ORDER BY per_km) FILTER (WHERE is_uah AND per_km IS NOT NULL AND per_km > 0) AS p25_perkm,
        percentile_cont(0.75) WITHIN GROUP (ORDER BY per_km) FILTER (WHERE is_uah AND per_km IS NOT NULL AND per_km > 0) AS p75_perkm,
        COUNT(*) FILTER (WHERE is_uah AND total IS NOT NULL AND total > 0) AS n_total,
        percentile_cont(0.5)  WITHIN GROUP (ORDER BY total) FILTER (WHERE is_uah AND total IS NOT NULL AND total > 0) AS med_total,
        COUNT(*) AS n_all,
        to_char(MIN(first_seen), 'YYYY-MM-DD') AS since
       FROM lardi_offers
      WHERE from_id = $1 AND to_id = $2 AND first_seen >= now() - ($3 || ' days')::interval`,
    [fromId, toId, days]
  );
  const x = r.rows[0];
  if (!x || Number(x.n_all) === 0) return null;
  const nPerKm = Number(x.n_perkm);
  const nTotal = Number(x.n_total);
  return {
    perKm: nPerKm > 0 ? {
      n: nPerKm,
      median: Math.round(Number(x.med_perkm)),
      p25: Math.round(Number(x.p25_perkm)),
      p75: Math.round(Number(x.p75_perkm)),
    } : null,
    total: nTotal > 0 ? { n: nTotal, median: Math.round(Number(x.med_total)) } : null,
    samples: Number(x.n_all),
    since: x.since,
  };
}

export async function listRoutes(maxAgeDays = 14): Promise<{ from_id: number; to_id: number; from_name: string | null; to_name: string | null; from_lat: number | null; from_lon: number | null; to_lat: number | null; to_lon: number | null }[]> {
  const r = await pool.query(
    `SELECT from_id, to_id, from_name, to_name, from_lat, from_lon, to_lat, to_lon
       FROM lardi_routes WHERE last_query >= now() - ($1 || ' days')::interval`,
    [maxAgeDays]
  );
  return r.rows.map((x) => ({
    from_id: Number(x.from_id), to_id: Number(x.to_id),
    from_name: x.from_name, to_name: x.to_name,
    from_lat: x.from_lat != null ? Number(x.from_lat) : null,
    from_lon: x.from_lon != null ? Number(x.from_lon) : null,
    to_lat: x.to_lat != null ? Number(x.to_lat) : null,
    to_lon: x.to_lon != null ? Number(x.to_lon) : null,
  }));
}

export async function recordUsage(userId: number | null, ip: string, frm: string, tox: string): Promise<void> {
  await pool.query(`INSERT INTO lardi_usage (user_id, ip, frm, tox) VALUES ($1,$2,$3,$4)`, [userId, ip, frm, tox]);
}

export async function usageStats(days = 14) {
  const byDay = await pool.query(
    `SELECT to_char((ts AT TIME ZONE 'Europe/Kyiv')::date, 'YYYY-MM-DD') d,
            COUNT(*) requests, COUNT(DISTINCT COALESCE(user_id::text, ip)) users
       FROM lardi_usage WHERE ts >= now() - ($1 || ' days')::interval
      GROUP BY d ORDER BY d DESC`,
    [days]
  );
  const top = await pool.query(
    `SELECT frm || ' → ' || tox AS route, COUNT(*) n FROM lardi_usage
      WHERE ts >= now() - ($1 || ' days')::interval
      GROUP BY frm, tox ORDER BY n DESC LIMIT 12`,
    [days]
  );
  const tot = await pool.query(
    `SELECT COUNT(*) r, COUNT(DISTINCT COALESCE(user_id::text, ip)) u
       FROM lardi_usage WHERE ts >= now() - ($1 || ' days')::interval`,
    [days]
  );
  const today = await pool.query(
    `SELECT COUNT(*) r, COUNT(DISTINCT COALESCE(user_id::text, ip)) u
       FROM lardi_usage WHERE (ts AT TIME ZONE 'Europe/Kyiv')::date = (now() AT TIME ZONE 'Europe/Kyiv')::date`
  );
  return {
    days,
    total_requests: Number(tot.rows[0]?.r ?? 0),
    total_users: Number(tot.rows[0]?.u ?? 0),
    today_requests: Number(today.rows[0]?.r ?? 0),
    today_users: Number(today.rows[0]?.u ?? 0),
    by_day: byDay.rows.map((x) => ({ date: x.d, requests: Number(x.requests), users: Number(x.users) })),
    top_routes: top.rows.map((x) => ({ route: x.route, count: Number(x.n) })),
  };
}

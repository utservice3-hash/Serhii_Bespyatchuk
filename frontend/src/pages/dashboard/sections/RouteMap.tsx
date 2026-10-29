import { useEffect, useRef } from "react";
import * as L from "../../../vendor/leaflet/leaflet-src.esm.js";
import "../../../vendor/leaflet/leaflet.css";

/**
 * 🗺 Мапа маршруту для «Розрахунку ставки» (29.10.2026): обраний варіант — червона лінія, інший варіант — сірий пунктир,
 * «приблизна» відстань (пряма × 1,25) — червоний пунктир; старт — темна точка, фініш — червона, «через» — біла.
 *
 * Leaflet лежить у vendor (не npm — ланцюг викату залежностей не ставить) і імпортується СТАТИЧНО: правило «один
 * JS-чанк» (#225) забороняє `lazy()`. Плитки — OpenStreetMap із підписом (рішення Романа 29.10.2026); якщо плитки
 * недоступні, мапа сіра, а ставка рахується далі — від мапи вона не залежить.
 */
type LatLng = [number, number];
export const TILES_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

export function RouteMap({ line, other, approx, via }: { line: LatLng[]; other: LatLng[] | null; approx: boolean; via: LatLng | null }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    if (!el.current || map.current) return;
    map.current = L.map(el.current, { zoomControl: true, scrollWheelZoom: false, attributionControl: true });
    L.tileLayer(TILES_URL, { maxZoom: 18, attribution: "© OpenStreetMap" }).addTo(map.current);
    layer.current = L.layerGroup().addTo(map.current);
    return () => { map.current?.remove(); map.current = null; layer.current = null; };
  }, []);

  useEffect(() => {
    const m = map.current, g = layer.current;
    if (!m || !g || line.length < 2) return;
    g.clearLayers();
    if (other) L.polyline(other, { color: "#64748b", weight: 3, opacity: 0.6, dashArray: "2 7" }).addTo(g);
    const main = L.polyline(line, { color: "#c8102e", weight: 5, opacity: 0.9, dashArray: approx ? "10 10" : undefined }).addTo(g);
    L.circleMarker(line[0], { radius: 7, color: "#fff", weight: 3, fillColor: "#111827", fillOpacity: 1 }).addTo(g);
    L.circleMarker(line[line.length - 1], { radius: 8, color: "#fff", weight: 3, fillColor: "#c8102e", fillOpacity: 1 }).addTo(g);
    if (via) L.circleMarker(via, { radius: 6, color: "#111827", weight: 2, fillColor: "#fff", fillOpacity: 1 }).addTo(g);
    const b = main.getBounds();
    if (other) b.extend(L.polyline(other).getBounds());
    m.invalidateSize();
    m.fitBounds(b, { padding: [28, 28] });
  }, [line, other, approx, via]);

  return <div ref={el} className="rs-map" role="img" aria-label="Мапа маршруту" />;
}

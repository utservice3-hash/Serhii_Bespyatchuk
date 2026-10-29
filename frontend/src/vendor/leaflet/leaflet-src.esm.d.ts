/**
 * Типи рівно тієї частини Leaflet 1.9.4, якою користується мапа маршруту (`RouteMap.tsx`). Бібліотека лежить у vendor,
 * а не в npm (див. README): ланцюг викату залежностей не ставить, тож і `@types/leaflet` на стенді не буде.
 */
export type LatLngTuple = [number, number];
export interface LatLngBounds { extend(b: LatLngBounds): LatLngBounds }
export interface Layer { addTo(target: Map | LayerGroup): this }
export interface Polyline extends Layer { getBounds(): LatLngBounds }
export interface LayerGroup extends Layer { clearLayers(): this }
export interface Map {
  remove(): this;
  invalidateSize(): this;
  fitBounds(b: LatLngBounds, opts?: { padding?: [number, number] }): this;
}
export function map(el: HTMLElement, opts?: { zoomControl?: boolean; scrollWheelZoom?: boolean; attributionControl?: boolean }): Map;
export function tileLayer(url: string, opts?: { maxZoom?: number; attribution?: string }): Layer;
export function layerGroup(): LayerGroup;
export function polyline(pts: LatLngTuple[], opts?: { color?: string; weight?: number; opacity?: number; dashArray?: string }): Polyline;
export function circleMarker(pt: LatLngTuple, opts?: { radius?: number; color?: string; weight?: number; fillColor?: string; fillOpacity?: number }): Layer;

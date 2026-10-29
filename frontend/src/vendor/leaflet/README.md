# Leaflet 1.9.4 (vendor)

Мапа маршруту в «Розрахунку ставки» (`pages/dashboard/sections/RouteMap.tsx`, 29.10.2026).

- Джерело: npm `leaflet@1.9.4`, файли `dist/leaflet-src.esm.js` (рядок `sourceMappingURL` прибрано — карти немає) і `dist/leaflet.css`.
- Ліцензія BSD-2-Clause — `LICENSE` поруч.
- **Чому vendor, а не npm:** ланцюг викату залежностей не ставить (`tools/deploy.ts → needDeps`), стенд збирає фронт на своїх
  `node_modules`; новий npm-пакет зламав би `buildFront`. Той самий шлях, що в pdf-lib і shevchenko (`backend/src/constructor/vendor`).
- Типи — лише використана частина API: `leaflet-src.esm.d.ts`.
- Оновлення: замінити обидва файли з нового релізу, звірити API в `RouteMap.tsx`.
- У `leaflet.css` три `url(images/*.png)` замінено на `none`: картинки (контрол шарів, стандартний маркер) не веземо й не вживаємо — маркери в мапі власні (`circleMarker`).

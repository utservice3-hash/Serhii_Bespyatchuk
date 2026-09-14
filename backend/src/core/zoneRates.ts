/**
 * 🗺 ЗОННІ ТАРИФИ КАЛЬКУЛЯТОРА СТАВОК, грн/км за тоннажем і зоною.
 *
 * Джерело — КВП. Поточна редакція: **Дарина Михальчевська, 04.09.2026** (через
 * «зворотний звʼязок»): «змінити ціни на актуальні». Попередня — карта КВП, липень 2026.
 * Зона «помаранчева» у повідомленні = `yellow` тут (Закарпаття/Прикарпаття/Буковина,
 * Одеса, Полтава, Миколаїв).
 *
 * 🔴 Числа живуть ТУТ і тільки тут; гейт `#397` звіряє їх із фікстурою, переписаною з
 * повідомлення дослівно, — зміна будь-якого числа без зміни фікстури червоніє. Так
 * наступна правка цін не пройде «тихо в коді», а лишить слід із датою й автором.
 */
export type Zone = "green" | "yellow" | "red";

export const ZONE_RATES: { maxMass: number; label: string; rates: Record<Zone, [number, number]> }[] = [
  { maxMass: 2.5, label: "до 2,5 т", rates: { green: [30, 30], yellow: [35, 35], red: [35, 40] } },
  { maxMass: 5, label: "до 5 т", rates: { green: [40, 45], yellow: [45, 50], red: [50, 55] } },
  { maxMass: 10, label: "до 10 т", rates: { green: [55, 60], yellow: [60, 65], red: [65, 70] } },
  { maxMass: Infinity, label: "20 т (фура)", rates: { green: [70, 75], yellow: [75, 85], red: [85, 90] } },
];

/**
 * 📦 ДОВАНТАЖ (часткове завантаження за довжиною вантажу), грн/км за зоною.
 *
 * Джерело — **Андрій Безпамʼятний, 11.09.2026** (через Юлю, зворотний звʼязок):
 * «Довантаж до 2х метрів 15-18-20 за км в залежності від зони; до 3х метрів 20-22-25».
 * Три числа = зелена / жовта (помаранчева) / червона зона. Тариф фіксований, не діапазон.
 *
 * Це ІНШИЙ вимір, ніж тоннаж: рядок довантажу ніколи не «обирається» за вагою і
 * показується поруч з авто завжди. Гейт `#397c` звіряє числа з повідомленням.
 */
export const PARTIAL_RATES: { maxMeters: number; label: string; rates: Record<Zone, [number, number]> }[] = [
  { maxMeters: 2, label: "Довантаж до 2 м", rates: { green: [15, 15], yellow: [18, 18], red: [20, 20] } },
  { maxMeters: 3, label: "Довантаж до 3 м", rates: { green: [20, 20], yellow: [22, 22], red: [25, 25] } },
];

export const ZONE_LABEL: Record<Zone, string> = { green: "🟢 зелена", yellow: "🟡 жовта", red: "🔴 червона" };

const AREA_ZONES: [RegExp, Zone][] = [
  [/волин/i, "green"], [/рівн|ровен/i, "green"], [/львів|львов/i, "green"],
  [/терноп/i, "green"], [/хмельни/i, "green"], [/вінни|винни/i, "green"],
  [/житомир/i, "green"], [/київ|киев/i, "green"],
  [/закарпат/i, "yellow"], [/франків|франков/i, "yellow"], [/чернівец|черновиц/i, "yellow"],
  [/одес/i, "yellow"], [/полтав/i, "yellow"], [/миколаїв|николаев/i, "yellow"],
  [/черніг|черниг/i, "red"], [/сумс|суми/i, "red"], [/харків|харьков/i, "red"],
  [/черкас/i, "red"], [/кіровоград|кировоград|кропивни/i, "red"],
  [/дніпр|днепр/i, "green"], // Дніпро — зелена (правка КВП 09.07.2026), довкола — червоні
  [/запор/i, "red"], [/херсон/i, "red"],
];
// Тарифи — у `core/zoneRates.ts` (редакція КВП 04.09.2026), тут лише зони областей.
function zoneOfArea(area: string | null | undefined): Zone | null {
  if (!area) return null;
  for (const [re, z] of AREA_ZONES) if (re.test(area)) return z;
  return null;
}
// Маржа UTS для орієнтовної ціни клієнту (карго-ціна + маржа за тоннажем).
const MARGIN_BY_MAX_MASS: { maxMass: number; margin: number }[] = [
  { maxMass: 2.5, margin: 2500 },
  { maxMass: 5, margin: 3000 },
  { maxMass: 10, margin: 4000 },
  { maxMass: Infinity, margin: 5000 },
];
export const marginFor = (maxMass: number) => MARGIN_BY_MAX_MASS.find((m) => maxMass <= m.maxMass)!.margin;

export function zoneRecommendation(frmArea: string | null, toArea: string | null, mass: number | null, routeKm: number | null) {
  const zoneFrom = zoneOfArea(frmArea);
  const zoneTo = zoneOfArea(toArea);
  // Правило КВП (09.07.2026): зона рахується за областю ПРИЗНАЧЕННЯ («куди веземо,
  // якщо в червону — ціна червоної»). Фолбек на відправлення, якщо призначення не
  // розпізнано (окуповані/невідомі області).
  const zone = zoneTo ?? zoneFrom;
  if (!zone) return null;
  const bySrc = zoneTo ? "за областю призначення" : "за областю відправлення (призначення не розпізнано)";
  const bracket = ZONE_RATES.find((b) => (mass ?? 20) <= b.maxMass)!;
  // Коротке плече: до 100 км тариф × 1.5 (подача/завантаження зʼїдають день —
  // грн/км на коротких рейсах завжди дорожчий).
  const shortHaul = routeKm != null && routeKm <= 100;
  const k = shortHaul ? 1.5 : 1;
  const [lo, hi] = bracket.rates[zone];
  // Пропозиція для ВСІХ типів авто (обраний за вагою тоннаж — selected).
  // carrier_* = скільки візьме перевізник (зонний тариф). client_* = орієнтовна
  // ціна КЛІЄНТУ = верх карго-діапазону + маржа UTS за тоннажем.
  const options = ZONE_RATES.map((b) => {
    const [l, h] = b.rates[zone];
    const carrierMin = routeKm ? Math.round(l * k * routeKm) : null;
    const carrierMax = routeKm ? Math.round(h * k * routeKm) : null;
    const margin = marginFor(b.maxMass);
    return {
      tonnage: b.label,
      margin,
      per_km_min: Math.round(l * k), per_km_max: Math.round(h * k),
      total_min: carrierMin, total_max: carrierMax,          // ціна перевізника
      client_min: carrierMin != null ? carrierMin + margin : null,
      client_max: carrierMax != null ? carrierMax + margin : null,
      selected: b === bracket,
    };
  });
  // 📦 Довантаж — окремою групою після авто. Маржі на довантаж КВП не називав
  // (11.09.2026), тому «Клієнту» тут null, а не вигадане число; коротке плече ×1.5
  // застосовується так само, як до авто.
  const partial = PARTIAL_RATES.map((b) => {
    const [l, h] = b.rates[zone];
    const carrierMin = routeKm ? Math.round(l * k * routeKm) : null;
    const carrierMax = routeKm ? Math.round(h * k * routeKm) : null;
    return {
      tonnage: b.label, kind: "partial" as const,
      margin: null as number | null,
      per_km_min: Math.round(l * k), per_km_max: Math.round(h * k),
      total_min: carrierMin, total_max: carrierMax,
      client_min: null as number | null, client_max: null as number | null,
      selected: false,
    };
  });
  const sel = options.find((o) => o.selected)!;
  return {
    zone,
    zone_label: ZONE_LABEL[zone],
    zone_src: bySrc,
    from_area: frmArea, to_area: toArea,
    tonnage: bracket.label,
    margin: sel.margin,
    per_km_min: Math.round(lo * k), per_km_max: Math.round(hi * k),
    total_min: sel.total_min, total_max: sel.total_max,
    client_min: sel.client_min, client_max: sel.client_max,
    distance_km: routeKm,
    short_haul: shortHaul,
    options: [...options.map((o) => ({ ...o, kind: "vehicle" as const })), ...partial],
  };
}

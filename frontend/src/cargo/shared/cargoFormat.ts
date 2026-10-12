/** Формат чисел і введення — як у макеті: метри з комою (7,20), тонни, м³. Усі розміри всередині — цілі мм. */

export const dec = (v: number, d: number): string => v.toFixed(d).replace('.', ',');
/** мм → «7,20» (метри, 2 знаки). */
export const fM = (mm: number): string => dec(Math.round(mm / 10) / 100, 2);
/** м³ → «12,0». */
export const fV = (m3: number): string => dec(m3, 1);
/** кг → «2», «2,5», «0,93» (тонни; знаків — скільки треба). */
export const fT = (kg: number): string => dec(kg / 1000, kg % 1000 === 0 ? 0 : (kg % 100 === 0 ? 1 : 2));
/** «7,2» / «7.2» / « 7 200 » → число; сміття → 0. */
export const num = (s: unknown): number => { const v = parseFloat(String(s).replace(/\s/g, '').replace(',', '.')); return isFinite(v) ? v : 0; };
/** метри з поля → мм. */
export const toMM = (s: unknown): number => Math.max(0, Math.round(num(s) * 1000));
export const esc = (s: unknown): string => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
export const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o)) as T;

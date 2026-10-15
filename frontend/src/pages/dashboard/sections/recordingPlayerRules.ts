/** 🎧 Чисті правила плеєра записів (`RecordingPlayer.tsx`) — окремо від React, щоб гейт бекенду їх виконав. */

export const PLAYER_RATES = [1, 1.5, 2] as const;
export type PlayerRate = typeof PLAYER_RATES[number];

/** −10 с / +10 с: не нижче початку й не далі кінця; тривалість ще невідома (0) — кінця немає, лише не нижче нуля. */
export function seekBy(pos: number, delta: number, dur: number): number {
  const t = Math.max(0, pos + delta);
  return dur > 0 ? Math.min(dur, t) : t;
}

/** Клік / перетягування по смузі: частка ширини → секунда запису, затиснута в межі смуги. */
export function seekAt(x: number, width: number, dur: number): number {
  if (!(width > 0) || !(dur > 0)) return 0;
  return Math.min(1, Math.max(0, x / width)) * dur;
}

/** Одна кнопка швидкості в компактному плеєрі: 1× → 1,5× → 2× → 1×. */
export function nextRate(r: PlayerRate): PlayerRate {
  const i = PLAYER_RATES.indexOf(r);
  return PLAYER_RATES[(i + 1) % PLAYER_RATES.length];
}

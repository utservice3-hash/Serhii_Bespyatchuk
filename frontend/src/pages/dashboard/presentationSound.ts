/**
 * 🎵 ЗВУК ПРЕЗЕНТАЦІЇ (задача «Додати музику в презентацію + фанфари», 09.11.2026). Жодного імпорту під час виконання:
 * гейт #3471 транспілює цей файл і ВИКОНУЄ `soundFor`.
 *
 *  · Музика — ЛИШЕ на титулі, поки люди збираються (рішення Романа: «на 1 слайді з можливістю вимкнути»); трек — Даші.
 *  · Фанфари — на вході на кожен слайд з номінантами («кожен новий слайд де є якісь номінанти»), один раз за показ:
 *    гортання назад-вперед їх не повторює. Звук синтезується в браузері — файла немає, прав на нього теж.
 *  · Одна кнопка 🔇 (і клавіша M) глушить усе.
 */

/** Слайди з номінантами. «Події тижня», «Пульс плану» й «Фокус» — без фанфар. */
export const FANFARE_SLIDES = ["money", "volume", "awards", "leadgen", "conv"] as const;

/** Що має звучати на слайді `key`. `played` — слайди, на яких фанфари вже були за цей показ. */
export function soundFor(key: string, s: { muted: boolean; hasMusic: boolean; played: ReadonlySet<string> }): { music: boolean; fanfare: boolean } {
  if (s.muted) return { music: false, fanfare: false };
  return {
    music: key === "title" && s.hasMusic,
    fanfare: (FANFARE_SLIDES as readonly string[]).includes(key) && !s.played.has(key),
  };
}

/**
 * Фанфари «та-та-та-даам» (~1.6 с): три короткі G4 і акорд до-мажор, мідний тембр — дві розстроєні пилки крізь фільтр.
 * Повертає час закінчення (с від початку контексту) — щоб не накладати наступні фанфари.
 */
export function playFanfare(ctx: AudioContext, volume = 0.22): number {
  const t0 = ctx.currentTime + 0.02;
  const out = ctx.createGain();
  out.gain.value = volume;
  out.connect(ctx.destination);
  const note = (freq: number, at: number, dur: number) => {
    const g = ctx.createGain();
    const f = ctx.createBiquadFilter();
    f.type = "lowpass"; f.frequency.value = 2400; f.Q.value = 1;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(1, at + 0.02);
    g.gain.setValueAtTime(1, at + Math.max(0.03, dur - 0.08));
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    for (const detune of [-7, 7]) {
      const o = ctx.createOscillator();
      o.type = "sawtooth"; o.frequency.value = freq; o.detune.value = detune;
      o.connect(f); o.start(at); o.stop(at + dur + 0.05);
    }
    f.connect(g); g.connect(out);
  };
  const G4 = 392, C5 = 523.25, E5 = 659.25, G5 = 783.99;
  [0, 0.14, 0.28].forEach((d) => note(G4, t0 + d, 0.11));
  for (const fq of [C5, E5, G5]) note(fq, t0 + 0.42, 1.15);
  return t0 + 1.6;
}

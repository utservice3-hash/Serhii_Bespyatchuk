/**
 * 🔊 ЗВУК СПОВІЩЕНЬ — один аудіоконтекст на сторінку (стандарт сповіщень, 07.10.2026).
 *
 * Доти `beep()` у Dashboard.tsx створював НОВИЙ `AudioContext` на кожен сигнал і не закривав його:
 * браузер тримає їх обмежену кількість, і після кількох десятків подій звук просто зникав.
 * Тепер контекст один і створюється при першому звуці. Звук увімкнений (рішення Романа 07.10.2026).
 * Кнопку-вимикач у меню Роман прибрав того ж дня («вона жахлива»); `setSoundEnabled` лишається
 * для майбутнього місця в налаштуваннях, а `soundEnabled()` без запису завжди дає «увімкнено».
 * Тримає `#1234`.
 */
const KEY = "uts.notifySound";
let ctx: AudioContext | null = null;

export function soundEnabled(): boolean {
  try { return localStorage.getItem(KEY) !== "off"; } catch { return true; }
}
export function setSoundEnabled(on: boolean): void {
  try { localStorage.setItem(KEY, on ? "on" : "off"); } catch { /* приватне вікно — лишається на цей сеанс увімкненим */ }
}

function audio(): AudioContext | null {
  if (ctx) return ctx;
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  ctx = new Ctx();
  return ctx;
}

/** Короткий сигнал: нейтральний — один тон 620 Гц, «добре» (виконано, чекає прийняття) — два 880→1180 Гц. */
export function playNotifySound(success: boolean): void {
  if (!soundEnabled()) return;
  try {
    const a = audio();
    if (!a) return;
    if (a.state === "suspended") void a.resume();
    const tone = (freq: number, at: number) => {
      const o = a.createOscillator();
      const g = a.createGain();
      o.connect(g); g.connect(a.destination);
      o.type = "sine";
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, a.currentTime + at);
      g.gain.exponentialRampToValueAtTime(0.2, a.currentTime + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + at + 0.32);
      o.start(a.currentTime + at);
      o.stop(a.currentTime + at + 0.34);
    };
    tone(success ? 880 : 620, 0);
    if (success) tone(1180, 0.18);
  } catch { /* звук недоступний — тост однаково на екрані */ }
}

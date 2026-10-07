/**
 * 🖥 СПОВІЩЕННЯ БРАУЗЕРА — лише коли вкладка прихована (стандарт сповіщень, 07.10.2026).
 *
 * Було: дозвіл просили одразу при відкритті сторінки, без жодної дії людини (браузери за таке
 * дедалі частіше блокують запит назавжди), а сповіщення летіло й на ВИДИМІЙ вкладці — поруч із
 * тостом, удруге про те саме, і без `tag`, тож однакові накопичувались у системі.
 * Тепер: дозвіл — після першого кліку на сторінці; сповіщення — лише на прихованій вкладці;
 * однаковий `tag` замінює попереднє. Тримає `#1234`.
 */
let armed = false;

/** Попросити дозвіл після першого кліку людини (один раз за сеанс). */
export function askNotifyPermissionOnFirstClick(): void {
  if (armed || typeof Notification === "undefined" || Notification.permission !== "default") return;
  armed = true;
  const ask = () => {
    document.removeEventListener("click", ask, true);
    Notification.requestPermission().catch(() => {});
  };
  document.addEventListener("click", ask, true);
}

/** Сповіщення в системі — лише якщо вкладку не видно і дозвіл є. */
export function notifyBrowser(body: string, tag: string): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (!document.hidden) return;
  try { new Notification("UTS Dashboard", { body, tag }); } catch { /* система відмовила — тост однаково чекає на сторінці */ }
}

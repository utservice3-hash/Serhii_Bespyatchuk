import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Kill-switch: наявність файла KOMMO_PAUSED у корені dashboard = усі Kommo-синки
// на паузі. Перемикається БЕЗ редеплою: `touch KOMMO_PAUSED` / `rm KOMMO_PAUSED`.
// dist/kommo/pause.js → ../../.. = корінь dashboard.
const PAUSE_FILE = path.join(__dirname, "..", "..", "..", "KOMMO_PAUSED");

export function isKommoPaused(): boolean {
  try {
    return existsSync(PAUSE_FILE);
  } catch {
    return false;
  }
}

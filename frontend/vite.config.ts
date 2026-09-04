import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'
import { requireApiBase } from './buildEnvGuard'

/**
 * 🖥 SHA ЗБІРКИ ВШИВАЄТЬСЯ В БАНДЛ — щоб вкладка могла спитати сервер, чи вона
 * не застаріла. Той самий спосіб, що в `backend/scripts/writeVersion.mjs`: git
 * питаємо НА ЗБІРЦІ, а не в рантаймі.
 *
 * 🔴 Git недоступний → `"unknown"`, і це не відмовка, а значення: бекенд читає
 * його як «не знаю» і плашку не показує. Вигадати сюди щось правдоподібне
 * означало б навчити вкладку брехати про власну версію.
 *
 * ⚠️ Без цього `define` фронт шле порожнечу, правило чесно віддає `null`, і фіча
 * тихо мертва при зелених гейтах на самому правилі. Саме тому її втрату стереже
 * окремий гейт по АРТЕФАКТУ (`bundleBuildSha.test.ts`), а не лише юніт-тест.
 */
function buildSha(): string {
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return 'unknown'
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Fail-closed: у продакшн-режимі відсутній VITE_API_URL валить збірку, а не
  // підставляє тихо localhost-фолбек. Причина й заміри — у buildEnvGuard.ts.
  requireApiBase(mode, loadEnv(mode, process.cwd(), ''))
  return {
    plugins: [react()],
    define: { __BUILD_SHA__: JSON.stringify(buildSha()) },
  }
})

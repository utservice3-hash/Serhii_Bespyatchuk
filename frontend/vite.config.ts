import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { requireApiBase } from './buildEnvGuard'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Fail-closed: у продакшн-режимі відсутній VITE_API_URL валить збірку, а не
  // підставляє тихо localhost-фолбек. Причина й заміри — у buildEnvGuard.ts.
  requireApiBase(mode, loadEnv(mode, process.cwd(), ''))
  return {
    plugins: [react()],
  }
})

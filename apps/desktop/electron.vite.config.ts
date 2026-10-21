import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// @organizer/core ships as TypeScript source, so it must be bundled rather than externalized.
const bundleCore = { exclude: ['@organizer/core'] }

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin(bundleCore)] },
  preload: { plugins: [externalizeDepsPlugin(bundleCore)] },
  renderer: { plugins: [react()] },
})

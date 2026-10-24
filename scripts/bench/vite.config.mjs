import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
const here = (p) => fileURLToPath(new URL(p, import.meta.url))
export default defineConfig({
  root: here('.'),
  build: { ssr: here('./bench.ts'), outDir: here('./out'), emptyOutDir: true, target: 'node22', rollupOptions: { external: ['better-sqlite3', 'electron'], output: { format: 'cjs', entryFileNames: 'bench.cjs' } } },
  ssr: { noExternal: true },
})

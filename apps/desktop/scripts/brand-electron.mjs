// macOS takes the menu bar and Dock name from the app bundle, which app.setName() can't change, and caches it by
// bundle path. So rename the development copy of Electron to Sweep.app, retitle it, and point the electron launcher
// at it. Runs after every install, since installs restore the original.
import { execFileSync } from 'node:child_process'
import { existsSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

if (process.platform === 'darwin') {
  const root = dirname(createRequire(import.meta.url).resolve('electron'))
  const original = join(root, 'dist/Electron.app')
  const branded = join(root, 'dist/Sweep.app')
  if (existsSync(original)) renameSync(original, branded)
  if (existsSync(branded)) {
    const plist = join(branded, 'Contents/Info.plist')
    for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
      execFileSync('plutil', ['-replace', key, '-string', 'Sweep', plist])
    }
    writeFileSync(join(root, 'path.txt'), 'Sweep.app/Contents/MacOS/Electron')
    execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', branded])
  }
}

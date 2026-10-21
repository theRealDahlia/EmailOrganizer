import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import type { Rule } from '@organizer/core'
import { AccountManager } from './accounts'
import { Store } from './db'
import { SecretStore } from './secrets'
import { OrganizerService } from './service'

let store: Store

function registerIpc(service: OrganizerService, accounts: AccountManager) {
  ipcMain.handle('overview', (_e, refresh?: boolean) => service.overview(refresh))
  ipcMain.handle('accountStatus', () => accounts.status())
  ipcMain.handle('saveGoogleCredentials', (_e, id: string, secret: string) => accounts.saveCredentials(id, secret))
  ipcMain.handle('connectGmail', async () => { await accounts.connect(); service.invalidate() })
  ipcMain.handle('disconnect', async () => { await accounts.disconnect(); service.invalidate() })
  ipcMain.handle('listRules', () => store.listRules())
  ipcMain.handle('saveRule', (_e, rule: Rule) => store.saveRule(rule))
  ipcMain.handle('deleteRule', (_e, id: string) => store.deleteRule(id))
  ipcMain.handle('preview', (_e, id: string) => service.preview(id))
  ipcMain.handle('apply', (_e, id: string) => service.apply(id))
  ipcMain.handle('activity', () => store.listActivity())
  ipcMain.handle('undo', (_e, id: number) => service.undo(id))
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: 'Email Organizer',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  // Never navigate the app window away, and open external links in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  store = new Store(join(app.getPath('userData'), 'organizer.sqlite'))
  const accounts = new AccountManager(new SecretStore(join(app.getPath('userData'), 'secrets.json')))
  registerIpc(new OrganizerService(() => accounts.provider(), store), accounts)
  createWindow()
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow())
})

app.on('window-all-closed', () => {
  store?.close()
  if (process.platform !== 'darwin') app.quit()
})

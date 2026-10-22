import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import type { CleanupRule, Rule } from '@organizer/core'
import type { ScanProgress, UnsubscribeMethod } from '../shared'
import { AccountManager } from './accounts'
import { Store } from './db'
import { SecretStore } from './secrets'
import { OrganizerService } from './service'

let store: Store

function registerIpc(service: OrganizerService, accounts: AccountManager) {
  ipcMain.handle('overview', (_e, refresh?: boolean) => service.overview(refresh))
  ipcMain.handle('accountStatus', () => accounts.status())
  ipcMain.handle('storage', () => service.storage())
  ipcMain.handle('saveGoogleCredentials', (_e, id: string, secret: string) => accounts.saveCredentials(id, secret))
  ipcMain.handle('connectGmail', async () => { await accounts.connect(); service.invalidate(true) })
  ipcMain.handle('cancelScan', () => service.cancelScan())
  ipcMain.handle('disconnect', async () => {
    const email = accounts.status().email
    await accounts.disconnect()
    if (email) store.clearMessages(email) // the local copy of this account's mail metadata goes with the sign-in
    service.invalidate(true)
  })
  ipcMain.handle('listRules', () => store.listRules())
  ipcMain.handle('saveRule', (_e, rule: Rule) => service.saveRule(rule))
  ipcMain.handle('cleanupRules', () => service.cleanupRules())
  ipcMain.handle('saveCleanupRule', (_e, rule: CleanupRule) => service.saveCleanupRule(rule))
  ipcMain.handle('deleteCleanupRule', (_e, id: string) => service.deleteCleanupRule(id))
  ipcMain.handle('previewCleanup', (_e, id: string) => service.previewCleanup(id))
  ipcMain.handle('applyCleanup', (_e, id: string, expected: number, confirmation?: string) => service.applyCleanup(id, expected, confirmation))
  ipcMain.handle('subscriptions', () => service.subscriptions())
  ipcMain.handle('createArchiveRule', (_e, email: string) => service.createArchiveRule(email))
  ipcMain.handle('unsubscribe', async (_e, email: string, method: UnsubscribeMethod) => {
    if (method === 'oneClick') return service.oneClickUnsubscribe(email)
    const t = await service.unsubscribeTargets(email)
    const target = method === 'openLink' ? t.https : t.mailto
    if (!target) throw new Error('That unsubscribe method is not available for this sender.')
    await shell.openExternal(target) // https URLs were checked by parseListUnsubscribe; mailto opens the user's mail app
  })
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
  const sendProgress = (p: ScanProgress) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('scan-progress', p))
  registerIpc(new OrganizerService(() => accounts.provider(), store, sendProgress), accounts)
  createWindow()
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow())
})

app.on('window-all-closed', () => {
  store?.close()
  if (process.platform !== 'darwin') app.quit()
})

import { app, BrowserWindow, ipcMain, nativeTheme, shell } from 'electron'
import { join } from 'node:path'
import type { CleanupRule, Rule } from '@organizer/core'
import type { AutomationStatus, ScanProgress, SenderAction, ThemePref, UnsubscribeMethod } from '../shared'
import { AccountManager } from './accounts'
import { Store } from './db'
import { SecretStore } from './secrets'
import { Settings } from './settings'
import { AUTO_INTERVAL_MS, OrganizerService } from './service'

let store: Store

function registerIpc(service: OrganizerService, accounts: AccountManager, settings: Settings) {
  ipcMain.handle('getTheme', () => settings.theme())
  ipcMain.handle('setTheme', (_e, theme: ThemePref) => {
    settings.setTheme(theme)
    nativeTheme.themeSource = settings.theme() // the page's prefers-color-scheme (and the window frame) follows this
    return settings.theme()
  })
  ipcMain.handle('overview', (_e, refresh?: boolean) => service.overview(refresh))
  ipcMain.handle('accountStatus', () => accounts.status())
  ipcMain.handle('storage', () => service.storage())
  ipcMain.handle('saveGoogleCredentials', (_e, id: string, secret: string) => accounts.saveCredentials(id, secret))
  ipcMain.handle('connectGmail', async () => { await accounts.connect(); service.invalidate(true) })
  ipcMain.handle('cancelScan', () => service.cancelScan())
  ipcMain.handle('scanFullInbox', () => service.scanFullInbox())
  ipcMain.handle('inboxCounts', () => service.inboxCounts())
  ipcMain.handle('tabCounts', () => service.tabCounts())
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
  ipcMain.handle('cleanupCount', (_e, id: string) => service.cleanupCount(id))
  ipcMain.handle('automation', () => service.automation())
  ipcMain.handle('runAutomaticNow', () => service.runAutomatic())
  ipcMain.handle('senders', () => service.senders())
  ipcMain.handle('senderSummary', (_e, email: string) => service.senderSummary(email))
  ipcMain.handle('cleanSender', (_e, email: string, action: SenderAction, expected: number) => service.cleanSender(email, action, expected))
  ipcMain.handle('openInGmail', async (_e, email: string) => {
    if (!/^[^\s<>"(){}\\]+@[^\s<>"(){}\\]+$/.test(email)) throw new Error('That isn’t a valid sender address.')
    const account = accounts.status().email
    const search = encodeURIComponent(`in:inbox from:${email}`)
    await shell.openExternal(`https://mail.google.com/mail/${account ? `?authuser=${encodeURIComponent(account)}` : ''}#search/${search}`)
  })
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
  const sendAutomatic = (status: AutomationStatus) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('automatic-run', status))
  const service = new OrganizerService(() => accounts.provider(), store, sendProgress, { onAutomatic: sendAutomatic })
  const settings = new Settings(join(app.getPath('userData'), 'settings.json'))
  nativeTheme.themeSource = settings.theme() // before the window opens, so it never flashes the wrong theme
  registerIpc(service, accounts, settings)
  // Automatic rules and cleanups: shortly after launch, then every half hour while the app is open.
  const runAutomatic = () => { service.runAutomatic().catch(() => {}) }
  setTimeout(runAutomatic, 20_000)
  setInterval(runAutomatic, AUTO_INTERVAL_MS)
  createWindow()
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow())
})

app.on('window-all-closed', () => {
  store?.close()
  if (process.platform !== 'darwin') app.quit()
})

import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CleanupRule, Rule } from '@organizer/core'
import type { AutomationStatus, BackgroundPrefs, ScanProgress, SenderAction, ThemePref, UnsubscribeMethod } from '../shared'
import { AccountManager } from './accounts'
import { Store } from './db'
import { SecretStore } from './secrets'
import { Settings } from './settings'
import { AiRules } from './ai'
import { Background } from './background'
import { AUTO_INTERVAL_MS, OrganizerService } from './service'

let store: Store
let settings: Settings

const AI_KEY = 'anthropic.apiKey'

function registerIpc(service: OrganizerService, accounts: AccountManager, settings: Settings, secrets: SecretStore, background: Background) {
  ipcMain.handle('getBackground', () => background.state())
  ipcMain.handle('setBackground', (_e, change: Partial<BackgroundPrefs>) => { settings.setBackground(change ?? {}); background.apply(); return background.state() })
  const ai = new AiRules(() => secrets.get(AI_KEY))
  ipcMain.handle('duplicates', () => service.duplicates())
  ipcMain.handle('trashDuplicates', (_e, expected: number) => service.trashDuplicates(expected))
  ipcMain.handle('exportRules', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? undefined
    const options = { title: 'Export rules', defaultPath: 'email-organizer-rules.json', filters: [{ name: 'Rules', extensions: ['json'] }] }
    const { canceled, filePath } = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (canceled || !filePath) return null
    const data = service.exportRules()
    writeFileSync(filePath, JSON.stringify(data, null, 2))
    return { path: filePath, count: data.cleanupRules.length + data.rules.length }
  })
  ipcMain.handle('importRules', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? undefined
    const options = { title: 'Import rules', properties: ['openFile' as const], filters: [{ name: 'Rules', extensions: ['json'] }] }
    const { canceled, filePaths } = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (canceled || !filePaths[0]) return null
    if (statSync(filePaths[0]).size > 2_000_000) throw new Error('That file is too large to be a rules file.')
    let data: unknown
    try { data = JSON.parse(readFileSync(filePaths[0], 'utf8')) } catch { throw new Error('That file isn’t valid JSON, so it can’t be a rules file.') }
    return service.importRules(data)
  })
  ipcMain.handle('aiStatus', () => ({ configured: !!secrets.get(AI_KEY) }))
  ipcMain.handle('saveAiKey', (_e, key: string) => {
    const trimmed = String(key ?? '').trim()
    if (!/^sk-ant-[A-Za-z0-9_-]{16,}$/.test(trimmed)) throw new Error('That doesn’t look like an Anthropic API key. It starts with sk-ant-.')
    secrets.set(AI_KEY, trimmed)
  })
  ipcMain.handle('removeAiKey', () => secrets.delete(AI_KEY))
  ipcMain.handle('draftRule', (_e, sentence: string) => ai.draft(String(sentence ?? '')))
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
  ipcMain.handle('suggestions', () => service.suggestions())
  ipcMain.handle('dismissSuggestion', (_e, id: string) => service.dismissSuggestion(id))
  ipcMain.handle('autoArchiveSender', (_e, email: string) => service.autoArchiveSender(email))
  ipcMain.handle('spaceGuide', () => service.spaceGuide())
  ipcMain.handle('cleanSpace', (_e, id: string, expected: number) => service.cleanSpace(id, expected))
  ipcMain.handle('impact', () => service.impact())
  ipcMain.handle('unsubscribeStatus', () => service.unsubscribeStatus())
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
    if (method === 'oneClick') await service.oneClickUnsubscribe(email)
    else {
      const t = await service.unsubscribeTargets(email)
      const target = method === 'openLink' ? t.https : t.mailto
      if (!target) throw new Error('That unsubscribe method is not available for this sender.')
      await shell.openExternal(target) // https URLs were checked by parseListUnsubscribe; mailto opens the user's mail app
    }
    await service.recordUnsubscribe(email, method) // so the app can check later that they really stopped
  })
  ipcMain.handle('deleteRule', (_e, id: string) => store.deleteRule(id))
  ipcMain.handle('preview', (_e, id: string) => service.preview(id))
  ipcMain.handle('apply', (_e, id: string) => service.apply(id))
  ipcMain.handle('activity', () => store.listActivity())
  ipcMain.handle('undo', (_e, id: number) => service.undo(id))
}

function createWindow(show = true) {
  const win = new BrowserWindow({
    show,
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

// One copy only: starting it again (from the Dock, a login item or a shortcut) brings the running one forward.
if (!app.requestSingleInstanceLock()) app.quit()

const showWindow = () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}
app.on('second-instance', showWindow)

app.whenReady().then(() => {
  store = new Store(join(app.getPath('userData'), 'organizer.sqlite'))
  settings = new Settings(join(app.getPath('userData'), 'settings.json'))
  const secrets = new SecretStore(join(app.getPath('userData'), 'secrets.json'))
  const accounts = new AccountManager(secrets)
  let service!: OrganizerService
  const background = new Background(settings, { showWindow, runNow: () => { service.runAutomatic().catch(() => {}) } })
  const sendProgress = (p: ScanProgress) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('scan-progress', p))
  const sendAutomatic = (status: AutomationStatus) => {
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('automatic-run', status))
    background.onAutomaticRun(status)
  }
  service = new OrganizerService(() => accounts.provider(), store, sendProgress, { onAutomatic: sendAutomatic })
  nativeTheme.themeSource = settings.theme() // before the window opens, so it never flashes the wrong theme
  registerIpc(service, accounts, settings, secrets, background)
  background.apply()
  // Automatic rules and cleanups: shortly after launch, then every half hour while the app is running.
  const runAutomatic = () => { service.runAutomatic().catch(() => {}) }
  setTimeout(runAutomatic, 20_000)
  setInterval(runAutomatic, AUTO_INTERVAL_MS)
  createWindow(!background.startedHidden) // started by the system at login with "keep running" on: stay in the tray until asked
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow())
})

// With "keep running" on, closing the window leaves the app in the menu bar or tray so automatic rules carry on.
app.on('window-all-closed', () => {
  if (settings?.background().keepRunning) return
  if (process.platform !== 'darwin') app.quit()
})

// The database stays open for as long as the app is alive, which on macOS outlasts its last window.
app.on('will-quit', () => store?.close())

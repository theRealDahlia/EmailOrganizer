import { BrowserWindow, Menu, Notification, Tray, app, nativeImage } from 'electron'
import type { AutomationStatus, BackgroundState } from '../shared'
import type { Settings } from './settings'

/** A 32px envelope, drawn black on transparent so macOS can tint it as a template image for light and dark menu bars. */
const ICON = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA0ElEQVR42mNgGAWjYBQMQiAAxA40wgLEWP4eiP/TCL8n5AgHGloOww6kOqCBgiBvoIYDYI4gFTRQGgIFQHweib+emEQEVbMeSd95qFkkOwCWaucjid0HYgM8+g2gamDq5yPlKrIcAAMFaCk5AYveBLQcVECEuUQ7AOa791h8hx5K77GEElUcAIvf/Wjxi5xO9uNIJ1RzAL4U3kAFc4lXCAQB0OB+D2Uz0NsBDEhpgGGgHEAscCC3IKJWLVhAaVFMt8powKvjAW+QjIJRMAroDgDy0ufbu5WTGAAAAABJRU5ErkJggg=='

/** The operating system can start an app at login on macOS and Windows; Linux desktops differ too much to promise it. */
const LOGIN_ITEM_SUPPORTED = process.platform === 'darwin' || process.platform === 'win32'

/**
 * What the app does after its window is closed: stay in the menu bar or tray so automatic rules keep running, start
 * when the user signs in, and say so when an automatic run changed mail. Each part is off until the user turns it on.
 */
export class Background {
  private tray: Tray | null = null
  private lastLine = 'No automatic runs yet.'

  constructor(
    private settings: Settings,
    private actions: { showWindow: () => void; runNow: () => void },
  ) {}

  state(): BackgroundState {
    return { prefs: this.settings.background(), loginItemSupported: LOGIN_ITEM_SUPPORTED }
  }

  /** Brings the system in line with the saved choices. Called at startup and after every change. */
  apply(): void {
    const prefs = this.settings.background()
    if (LOGIN_ITEM_SUPPORTED) app.setLoginItemSettings({ openAtLogin: prefs.openAtLogin, args: ['--hidden'] }) // args are for Windows; macOS reports wasOpenedAtLogin instead
    if (prefs.keepRunning) this.showTray()
    else this.hideTray()
  }

  /** True when the app was started by the system at login and should stay out of the way until asked for. */
  get startedHidden(): boolean {
    return this.settings.background().keepRunning && LOGIN_ITEM_SUPPORTED && (process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAtLogin)
  }

  /** After an automatic run: update the tray, and tell the user if they aren't looking at the app. */
  onAutomaticRun(status: AutomationStatus): void {
    if (status.lastChanged > 0) {
      const time = status.lastRunAt ? new Date(status.lastRunAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''
      this.lastLine = `${status.lastSummary}${time ? ` at ${time}` : ''}.`
      this.refreshMenu()
    }
    const watching = BrowserWindow.getAllWindows().some((w) => w.isVisible() && w.isFocused())
    if (this.settings.background().notify && status.lastChanged > 0 && !watching && Notification.isSupported()) {
      const n = new Notification({ title: 'Email Organizer', body: `${status.lastSummary}.`, silent: true })
      n.on('click', () => this.actions.showWindow())
      n.show()
    }
  }

  private showTray(): void {
    if (this.tray) return
    const image = nativeImage.createFromBuffer(Buffer.from(ICON, 'base64'), { scaleFactor: 2 })
    if (process.platform === 'darwin') image.setTemplateImage(true)
    this.tray = new Tray(image)
    this.tray.setToolTip('Email Organizer')
    this.tray.on('click', () => this.actions.showWindow())
    this.refreshMenu()
  }

  private hideTray(): void {
    this.tray?.destroy()
    this.tray = null
  }

  private refreshMenu(): void {
    this.tray?.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Email Organizer', click: () => this.actions.showWindow() },
      { type: 'separator' },
      { label: this.lastLine, enabled: false },
      { label: 'Run automatic rules now', click: () => this.actions.runNow() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]))
    this.tray?.setToolTip(`Email Organizer\n${this.lastLine}`)
  }
}

import { contextBridge, ipcRenderer } from 'electron'
import type { OrganizerApi, ScanProgress } from '../shared'

const call = (channel: string) => (...args: unknown[]) => ipcRenderer.invoke(channel, ...args)

const api: OrganizerApi = {
  overview: call('overview') as OrganizerApi['overview'],
  onScanProgress: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, p: ScanProgress) => cb(p)
    ipcRenderer.on('scan-progress', handler)
    return () => ipcRenderer.removeListener('scan-progress', handler)
  },
  cancelScan: call('cancelScan') as OrganizerApi['cancelScan'],
  scanFullInbox: call('scanFullInbox') as OrganizerApi['scanFullInbox'],
  inboxCounts: call('inboxCounts') as OrganizerApi['inboxCounts'],
  tabCounts: call('tabCounts') as OrganizerApi['tabCounts'],
  accountStatus: call('accountStatus') as OrganizerApi['accountStatus'],
  storage: call('storage') as OrganizerApi['storage'],
  saveGoogleCredentials: call('saveGoogleCredentials') as OrganizerApi['saveGoogleCredentials'],
  connectGmail: call('connectGmail') as OrganizerApi['connectGmail'],
  disconnect: call('disconnect') as OrganizerApi['disconnect'],
  listRules: call('listRules') as OrganizerApi['listRules'],
  cleanupRules: call('cleanupRules') as OrganizerApi['cleanupRules'],
  saveCleanupRule: call('saveCleanupRule') as OrganizerApi['saveCleanupRule'],
  deleteCleanupRule: call('deleteCleanupRule') as OrganizerApi['deleteCleanupRule'],
  previewCleanup: call('previewCleanup') as OrganizerApi['previewCleanup'],
  applyCleanup: call('applyCleanup') as OrganizerApi['applyCleanup'],
  senderSummary: call('senderSummary') as OrganizerApi['senderSummary'],
  cleanSender: call('cleanSender') as OrganizerApi['cleanSender'],
  openInGmail: call('openInGmail') as OrganizerApi['openInGmail'],
  subscriptions: call('subscriptions') as OrganizerApi['subscriptions'],
  unsubscribe: call('unsubscribe') as OrganizerApi['unsubscribe'],
  createArchiveRule: call('createArchiveRule') as OrganizerApi['createArchiveRule'],
  saveRule: call('saveRule') as OrganizerApi['saveRule'],
  deleteRule: call('deleteRule') as OrganizerApi['deleteRule'],
  preview: call('preview') as OrganizerApi['preview'],
  apply: call('apply') as OrganizerApi['apply'],
  activity: call('activity') as OrganizerApi['activity'],
  undo: call('undo') as OrganizerApi['undo'],
}

contextBridge.exposeInMainWorld('organizer', api)

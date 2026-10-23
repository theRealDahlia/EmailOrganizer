import { contextBridge, ipcRenderer } from 'electron'
import type { AutomationStatus, OrganizerApi, ScanProgress } from '../shared'

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
  getBackground: call('getBackground') as OrganizerApi['getBackground'],
  setBackground: call('setBackground') as OrganizerApi['setBackground'],
  duplicates: call('duplicates') as OrganizerApi['duplicates'],
  trashDuplicates: call('trashDuplicates') as OrganizerApi['trashDuplicates'],
  exportRules: call('exportRules') as OrganizerApi['exportRules'],
  importRules: call('importRules') as OrganizerApi['importRules'],
  aiStatus: call('aiStatus') as OrganizerApi['aiStatus'],
  saveAiKey: call('saveAiKey') as OrganizerApi['saveAiKey'],
  removeAiKey: call('removeAiKey') as OrganizerApi['removeAiKey'],
  draftRule: call('draftRule') as OrganizerApi['draftRule'],
  suggestions: call('suggestions') as OrganizerApi['suggestions'],
  dismissSuggestion: call('dismissSuggestion') as OrganizerApi['dismissSuggestion'],
  autoArchiveSender: call('autoArchiveSender') as OrganizerApi['autoArchiveSender'],
  spaceGuide: call('spaceGuide') as OrganizerApi['spaceGuide'],
  spaceList: call('spaceList') as OrganizerApi['spaceList'],
  trashSelected: call('trashSelected') as OrganizerApi['trashSelected'],
  cleanSpace: call('cleanSpace') as OrganizerApi['cleanSpace'],
  impact: call('impact') as OrganizerApi['impact'],
  unsubscribeStatus: call('unsubscribeStatus') as OrganizerApi['unsubscribeStatus'],
  getTheme: call('getTheme') as OrganizerApi['getTheme'],
  setTheme: call('setTheme') as OrganizerApi['setTheme'],
  cleanupCount: call('cleanupCount') as OrganizerApi['cleanupCount'],
  automation: call('automation') as OrganizerApi['automation'],
  runAutomaticNow: call('runAutomaticNow') as OrganizerApi['runAutomaticNow'],
  onAutomaticRun: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, s: AutomationStatus) => cb(s)
    ipcRenderer.on('automatic-run', handler)
    return () => ipcRenderer.removeListener('automatic-run', handler)
  },
  senders: call('senders') as OrganizerApi['senders'],
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

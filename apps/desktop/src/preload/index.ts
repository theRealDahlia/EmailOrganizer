import { contextBridge, ipcRenderer } from 'electron'
import type { OrganizerApi } from '../shared'

const call = (channel: string) => (...args: unknown[]) => ipcRenderer.invoke(channel, ...args)

const api: OrganizerApi = {
  overview: call('overview') as OrganizerApi['overview'],
  accountStatus: call('accountStatus') as OrganizerApi['accountStatus'],
  saveGoogleCredentials: call('saveGoogleCredentials') as OrganizerApi['saveGoogleCredentials'],
  connectGmail: call('connectGmail') as OrganizerApi['connectGmail'],
  disconnect: call('disconnect') as OrganizerApi['disconnect'],
  listRules: call('listRules') as OrganizerApi['listRules'],
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

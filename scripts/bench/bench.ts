// Benchmark of the real service and SQLite store on a large, realistic inbox. See docs/PERFORMANCE.md.
import { DemoProvider } from '../../packages/core/src/index'
import { OrganizerService } from '../../apps/desktop/src/main/service'
import { Store } from '../../apps/desktop/src/main/db'
import type { MailMessage } from '../../packages/core/src/index'

const N = Number(process.env.N ?? 100000)
const mb = (n: number) => Math.round(n / 1048576)
const mem = () => { global.gc?.(); const m = process.memoryUsage(); return { rss: mb(m.rss), heap: mb(m.heapUsed) } }
const time = async <T>(label: string, fn: () => Promise<T> | T) => { const t = performance.now(); const r = await fn(); console.log(label.padEnd(46), Math.round(performance.now() - t) + ' ms'); return r }

const WORDS = ['order','receipt','sale','your','account','weekly','digest','update','invoice','shipped','alert','new','offer','statement','reminder','welcome','security','confirm','thanks','deal']
function makeMail(n: number, senders: number): MailMessage[] {
  let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296
  return Array.from({ length: n }, (_, i) => {
    const sender = Math.floor(senders * rnd() ** 3) // long tail: a few senders send most of it
    const subject = Array.from({ length: 3 }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(' ')
    return { id: 'b' + i, accountId: 'bench@x.com', from: { name: 'Sender ' + sender, email: 's' + sender + '@brand' + (sender % 900) + '.example' }, subject, date: new Date(Date.now() - i * 60000).toISOString(),
      labels: ['INBOX'], isUnread: rnd() < 0.7, sizeBytes: 5000 + Math.floor(rnd() * 90000), ...(sender % 3 === 0 && { listUnsubscribe: '<https://x.example/u>' }) }
  })
}

class Big extends DemoProvider {
  override readonly accountId: string = 'bench@x.com'
  mail: MailMessage[] = makeMail(N, 15000)
  override async listMessages() { return { messages: this.mail } }
  override async listInboxIds(unreadOnly: boolean) { return this.mail.filter((m) => !unreadOnly || m.isUnread).map((m) => m.id) }
  override async getMessages(ids: string[]) { const want = new Set(ids); return this.mail.filter((m) => want.has(m.id)) }
  version = 1
  async getHistoryId() { return String(this.version) }
  async listChanges(since: string) { return { historyId: String(this.version), inbox: new Map<string, boolean>(), unread: new Map<string, boolean>() } }
}

;(async () => {
  console.log('messages:', N, ' start', JSON.stringify(mem()))
  const provider = new Big(N)
  const store = new Store(process.env.DB!)
  // a finished full scan: everything already saved, as after "Scan whole inbox"
  const all = (await provider.listMessages()).messages as MailMessage[]
  await time('seed the database with ' + N + ' messages', () => { for (let i = 0; i < all.length; i += 5000) store.upsertMessages('bench@x.com', all.slice(i, i + 5000)) })
  store.saveScanState('bench@x.com', { historyId: '1', listedAt: Date.now(), ids: all.map((m) => m.id) })
  console.log('after seeding', JSON.stringify(mem()))

  const service = new OrganizerService(() => provider, store, () => {}, { sampleSize: 2000 })
  service.scanFullInbox()
  await time('first overview (loads all from the database)', () => service.overview())
  console.log('after first overview', JSON.stringify(mem()))
  const rows: string[] = []
  for (let i = 1; i <= Number(process.env.CHECKS ?? 3); i++) {
    const t = performance.now(); await service.checkNewMail(); const m = mem()
    rows.push(`#${i}: ${Math.round(performance.now() - t)}ms rss=${m.rss}MB heap=${m.heap}MB`)
  }
  console.log(rows.filter((_, i) => i < 3 || i % 5 === 4).join('\n'))
  await time('overview() when nothing changed', () => service.overview())
  const senders = await time('senders() (all senders)', () => service.senders())
  console.log('   senders:', senders.senders.length, ' JSON bytes to the window:', JSON.stringify(senders).length)
  await time('suggestions()', () => service.suggestions())
  await time('duplicates()', () => service.duplicates())
  console.log('end', JSON.stringify(mem()))
  store.close()
})()

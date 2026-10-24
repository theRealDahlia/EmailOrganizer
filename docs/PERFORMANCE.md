# Performance

Measured on an Apple-silicon Mac with the real service and the real SQLite store (`scripts/bench`). The inbox is
synthetic but realistic: about 15,000 senders on a long-tail distribution, a third of them offering unsubscribe, and a
completed full scan already saved to the database.

| Inbox size | First load from disk | One-minute new-mail check | Memory (whole app's main process) | All-senders list sent to the window |
|---|---|---|---|---|
| 100,000 messages | 150 ms | about 130 ms | about 350 MB, flat over 30 checks | 2.2 MB, 14,000 senders |
| 300,000 messages | 500 ms | about 420 ms | about 700 MB | 2.3 MB |

Cost grows in a straight line with the number of saved messages. A check at 100,000 messages uses well under 1% of one
core. Searching 15,000 senders in the window takes 25 to 45 ms per keystroke.

## What actually limits large inboxes

Gmail, not the app. Downloading a message's headers costs 20 of the 6,000 quota units Google allows each minute, so
about 300 messages a minute:

- the first scan of the newest 2,000 messages takes about 7 minutes (the default);
- a full download of 100,000 messages takes about 5.5 hours, which is why "Scan whole inbox" is optional and shows an
  estimate first, and why scans resume where they stopped;
- after that, each minute asks Gmail's history what changed and downloads only new mail.

## Re-running it

```bash
npm exec -w @organizer/desktop vite build -- --config ../../scripts/bench/vite.config.mjs
cd scripts/bench
NODE_PATH=../../node_modules DB=/tmp/bench.sqlite N=100000 CHECKS=30 ELECTRON_RUN_AS_NODE=1 \
  ../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --expose-gc out/bench.cjs
```

It runs under Electron's Node because the database module is built for Electron. On Windows or Linux, use the
Electron binary for that platform. `N` is the number of messages and `CHECKS` the number of one-minute checks to time.

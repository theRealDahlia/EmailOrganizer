# Email Organizer

A local-first desktop app that organizes your mailbox. Mail is processed on your computer; there is no Email Organizer server. See [PLAN.md](PLAN.md).

## Layout

- `apps/desktop` — Electron + React app (main process, preload bridge, renderer)
- `packages/core` — mail provider interface, categorizer, rules engine, stats (no UI or Electron dependencies)

## Develop

```bash
npm install
node node_modules/electron/install.js            # downloads the Electron binary if npm skipped it
npm exec -w @organizer/desktop electron-rebuild -- -f -w better-sqlite3
npm run dev        # launch the app with hot reload
npm test           # core unit tests
npm run typecheck
```

The app starts on a built-in demo mailbox. To use Gmail, create a Google OAuth client ([docs/GOOGLE_SETUP.md](docs/GOOGLE_SETUP.md)) and connect from the **Accounts** tab. Credentials and tokens are encrypted with the OS keychain. Outlook is next.

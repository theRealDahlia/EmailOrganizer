# Email Organizer — Plan & Features

A tool where users connect their mailbox and get it organized: sorted, cleaned up, and kept that way, with the user always in control.

## Guiding principles

1. **Never destructive by default.** Archive/label/move, never permanently delete. Every bulk action is previewed first and can be undone.
2. **Least privilege.** Request the narrowest OAuth scopes needed; start read-only, ask for modify access only when the user enables an action.
3. **Minimal data retention.** Store metadata (sender, subject, labels, dates, IDs) by default. Message bodies are processed transiently unless the user opts in.
4. **Explainable.** Every automated decision shows *why* ("matched rule X" / "looks like a newsletter because…").

## Features

### MVP (v1)
- **Connect accounts**: Gmail (Google OAuth) and Outlook/Microsoft 365 (Microsoft Graph OAuth). Multiple accounts per user. Disconnect + delete all data in one click.
- **Mailbox scan & overview**: counts by sender, age, size, category, unread; "top 20 senders", "oldest unread", "biggest attachments".
- **Auto-categorization**: newsletters, promotions, receipts/orders, travel, social notifications, finance/bills, personal, work.
- **Rules engine**: if sender/domain/subject/category/age matches → label, move, archive, mark read, star. Rules are visible, editable, orderable, and can be tested against existing mail.
- **Bulk cleanup with preview**: select by sender/category/age, see exactly what will change, confirm, apply, **undo** (action log).
- **Unsubscribe helper**: detects `List-Unsubscribe`, lists subscriptions ranked by volume and read-rate, one-click unsubscribe or "auto-archive instead".
- **Suggested rules**: "You archive every email from X within a minute — create a rule?"
- **Activity log**: what changed, when, by which rule, with undo.

### v2
- **Smart summaries / digests**: group low-priority mail into a daily or weekly digest.
- **Duplicate and large-attachment finder**.
- **Follow-up tracking**: flag sent mail with no reply after N days; snooze-until reminders.
- **Receipts/bills extraction**: pull vendor, amount, date into a searchable list/CSV export.
- **Scheduled cleanups**: e.g. archive promotions older than 30 days, weekly.
- **Natural-language rules**: "Move anything from my landlord to a Housing label" → generates a reviewable rule.
- **Generic IMAP support** (Yahoo, iCloud, Fastmail, custom) via app passwords.

### Later
- Shared/team inbox rules, mobile app, browser extension, calendar-aware priority, import/export of rules.

## Product shape (decided)

Two deliverables in one repo:

1. **The local app** — a desktop app that runs entirely on the user's machine. Mail is fetched directly from Gmail/Outlook to the device; there is no Email Organizer server holding mail, tokens, or rules.
2. **A landing page website** — a static marketing site that explains the product, states the privacy promise, and hosts download links, docs, and the privacy policy. It never touches user mail.

## Architecture

```
/apps/desktop   Tauri (or Electron) shell + React UI
/apps/site      Static landing page (Astro or Next.js static export)
/packages/core  Provider interface, categorizer, rules engine (shared, UI-free)
```

| Layer | Choice | Notes |
|---|---|---|
| Desktop shell | **Electron** (decided: shares the TypeScript core, easy IMAP later) | macOS first, then Windows/Linux |
| UI | React + TypeScript + Tailwind | Dashboard, rule builder, preview/undo flows |
| Mail connectors | `MailProvider` interface with `GmailProvider`, `GraphProvider`, `ImapProvider` | Runs in the app process; keeps categorizer/rules provider-agnostic |
| Local storage | SQLite | Message metadata, rules, action log, all on-device |
| Secrets | OS keychain (macOS Keychain, Windows Credential Manager) | Refresh tokens never written to disk in plain text |
| OAuth | Desktop PKCE flow with loopback redirect | No client secret held on a server |
| Sync | In-app background jobs | Gmail history API / Graph delta; resumable, rate-limit aware |
| Classification | Local heuristics first (headers, known senders, `List-Unsubscribe`); optional LLM for ambiguous cases, off by default and clearly disclosed | Local-only mode works fully without it |
| Updates | Auto-update via signed releases | Code signing/notarization required on macOS/Windows |

### Landing page

- **Sections:** hero ("Organize your inbox. Your mail never leaves your computer."), how it works (connect → scan → preview → clean up), feature grid, privacy explainer, FAQ, download buttons, footer with privacy policy/terms/contact.
- **Required pages:** Privacy Policy and homepage must be on a verified domain — Google OAuth verification demands both.
- **Stack:** static site (Astro or Next export), hosted on Cloudflare Pages / Netlify / GitHub Pages; optional email waitlist signup.
- **Download flow:** OS detection → links to GitHub Releases (or a CDN) for signed installers.

**Core data model:** `User`, `MailAccount`, `Message(meta)`, `Sender`, `Category`, `Rule`, `Action` (reversible log entry with before/after state), `Subscription`.

## Phases

0. **Landing page** *(first version built in apps/site; needs domain, real contact email, and download links)* — scaffold `/apps/site`, write copy, deploy a placeholder with waitlist and privacy policy (also unblocks Google OAuth verification).
1. **Foundation** *(in progress: shell, SQLite, core, demo mailbox done; Gmail provider, PKCE OAuth, keychain storage written; awaiting first real-account test)* — monorepo setup, desktop shell, SQLite schema, Gmail desktop OAuth + read-only metadata sync, overview dashboard.
2. **Organize** — categorizer, rules engine with dry-run, apply actions via Gmail API, action log + undo.
3. **Cleanup** — bulk cleanup UI, unsubscribe helper, suggested rules.
4. **Second provider** — Outlook via Graph behind the same interface; validate the abstraction.
5. **Hardening** — Google OAuth app verification (restricted scopes require a security assessment, so start early), rate-limit handling, privacy policy, data deletion, error monitoring, load testing on 100k+ message mailboxes.
6. **v2 features**, prioritized by user feedback.

## Risks & open questions

- **Gmail restricted scopes** need Google verification and a third-party security assessment before public launch — long lead time. Dev/testing mode (100 users) works until then.
- **Large mailboxes**: initial sync must be incremental, resumable, and rate-limit aware.
- **Trust**: users are granting access to very sensitive data; clear permissions UI, open privacy stance, and easy revoke are product features, not afterthoughts.
- **Distribution**: unsigned desktop apps trigger OS warnings; budget for an Apple Developer account ($99/yr) and a Windows signing cert.
- **Open decisions**: macOS-only first or cross-platform; whether the optional LLM classification ships in v1; domain name for the site.

# Creating a Google Cloud OAuth client for Sweep

Sweep talks to Gmail directly from your computer, so it needs an OAuth **client ID** that identifies the app to Google. You create one in your own Google Cloud project. It's free and takes about 10 minutes.

## 1. Create a project
1. Go to <https://console.cloud.google.com/> and sign in.
2. Click the project picker (top bar) → **New project** → name it `Sweep` → **Create**, then select it.

## 2. Enable the Gmail API
1. Open <https://console.cloud.google.com/apis/library/gmail.googleapis.com> (with your project selected).
2. Click **Enable**.

## 2b. Enable the Google Drive API (for the storage meter)
Gmail's own API doesn't report storage. The "72% of 15 GB used" figure comes from the Drive API, because Gmail, Drive and Photos share one quota.
1. Open <https://console.cloud.google.com/apis/library/drive.googleapis.com> and click **Enable**.

## 3. Configure the consent screen (Google Auth Platform)
1. Open <https://console.cloud.google.com/auth/overview> and click **Get started**.
2. **App name:** `Sweep`. **User support email:** your email. → Next.
3. **Audience:** choose **External**. → Next.
4. **Contact information:** your email → Next → agree to the policy → **Create**.
5. Left menu → **Audience**. Leave **Publishing status: Testing**, then under **Test users** click **Add users** and add the Gmail address(es) you'll connect (e.g. your own). Save.
6. Left menu → **Data Access** → **Add or remove scopes** → find and tick
   `https://www.googleapis.com/auth/gmail.modify` **and** `https://www.googleapis.com/auth/drive.appdata` (if they aren't listed, paste them into "Manually add scopes") → **Update** → **Save**. `drive.appdata` is used only to read the storage quota; it gives no access to your Drive files. Google labels each scope's sensitivity on this page, so check it there.

## 4. Create the OAuth client
1. Left menu → **Clients** → **Create client**.
2. **Application type: Desktop app.** Name: `Sweep Desktop` → **Create**.
3. Copy the **Client ID** and **Client secret**.
   (For installed desktop apps Google does not treat the secret as confidential, but don't commit it to git anyway.)

## 5. Connect in the app
1. Run `npm run dev`, open the **Accounts** tab.
2. Paste the client ID and secret → **Save**, then **Connect Gmail**.
3. Your browser opens Google's sign-in page. You'll see **"Google hasn't verified this app"**. That's expected for an app in Testing mode that you own: click **Advanced → Go to Sweep (unsafe)**, then allow access.
4. Return to the app. Your inbox is scanned.

## Things to know
- **Testing mode tokens expire after 7 days.** Google revokes refresh tokens for unverified apps in Testing status, so you'll need to click **Reconnect** weekly during development. Publishing to production removes this, but the `gmail.modify` scope is *restricted* and public release requires Google's verification plus a third-party security assessment (see PLAN.md).
- Only the test users you listed can sign in (max 100).
- Tokens and your client secret are stored encrypted using your operating system's keychain (macOS Keychain), never in plain text.
- To revoke access any time: **Disconnect** in the app, or <https://myaccount.google.com/permissions>.

## For the app's developer: shipping one client to all users

End users should never create a Google app. Instead, the app ships with the client you created above:

```bash
cp apps/desktop/.env.example apps/desktop/.env   # then fill in both values; .env is git-ignored
npm run dev                                       # or: npm run build
```

The values are baked into the app at build time, and the Accounts tab then shows a single **Sign in with Google** button. (A client saved under *Advanced* overrides the bundled one.)

Before strangers can use it:
- **Testing mode** allows only the test users you list (max 100) and expires sign-ins weekly.
- To open it to everyone, publish the consent screen and pass Google's **OAuth verification**. `gmail.modify` is a *restricted* scope, so this also requires an annual third-party security assessment (CASA), a hosted privacy policy, and a verified domain. That is why the landing page matters. Budget weeks and, for the assessment, real money.
- Google treats a desktop app's client secret as non-confidential, but anyone can extract it from the installed app. It identifies the app; it does not protect users' mail.

## Adding the storage permission to an existing sign-in
If you connected before the storage meter existed, the meter shows **Reconnect Google**. Click it, then **Reconnect** in the Accounts tab, and approve the extra permission.

## Gmail's rate limit, and why big inboxes take hours

Google's [usage limits](https://developers.google.com/workspace/gmail/api/reference/quota) allow **6,000 quota units per minute per user**, and reading one message's headers costs **20 units**. That caps the app at about 300 messages a minute (it paces itself to roughly 270). The limit applies to Google's API, not to this app, so no code change makes a first scan faster:

| Inbox size | First full scan |
|---|---|
| 5,000 | ~20 min |
| 25,000 | ~1.5 h |
| 75,000 | ~4.5 h |

What the app does about it:
- The scan runs in the background, newest mail first, and the Overview, Subscriptions and rule previews work on what has been scanned so far.
- Progress is saved, so stopping or quitting loses nothing. The app also saves a Gmail history checkpoint with the inbox's id list, so a restart asks Google "what changed since then?" (2 quota units) instead of counting the inbox again, and only downloads what is left plus any new mail. It recounts in full only if Google no longer has history that far back, or once a week as a safety net.
- **Cleanup rules skip the scan entirely.** They ask Gmail to search (5 units per 500 matches, nothing downloaded) and then act in batches, so cleaning a whole inbox takes seconds even while the scan is still running.
- Actions are cheap: moving or labelling mail uses `batchModify` (50 units per 1,000 messages), so applying a rule to a whole inbox takes seconds once the mail is scanned.

To check or raise the limit for your project: Cloud console → **APIs & Services → Gmail API → Quotas & System Limits**, then **Request a higher quota limit**. Google says approval isn't guaranteed and large increases take longer. Projects that used the Gmail API between November 2025 and April 2026 keep their earlier quotas; newer projects get the limits above.

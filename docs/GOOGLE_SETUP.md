# Creating a Google Cloud OAuth client for Email Organizer

Email Organizer talks to Gmail directly from your computer, so it needs an OAuth **client ID** that identifies the app to Google. You create one in your own Google Cloud project. It's free and takes about 10 minutes.

## 1. Create a project
1. Go to <https://console.cloud.google.com/> and sign in.
2. Click the project picker (top bar) → **New project** → name it `Email Organizer` → **Create**, then select it.

## 2. Enable the Gmail API
1. Open <https://console.cloud.google.com/apis/library/gmail.googleapis.com> (with your project selected).
2. Click **Enable**.

## 3. Configure the consent screen (Google Auth Platform)
1. Open <https://console.cloud.google.com/auth/overview> and click **Get started**.
2. **App name:** `Email Organizer`. **User support email:** your email. → Next.
3. **Audience:** choose **External**. → Next.
4. **Contact information:** your email → Next → agree to the policy → **Create**.
5. Left menu → **Audience**. Leave **Publishing status: Testing**, then under **Test users** click **Add users** and add the Gmail address(es) you'll connect (e.g. your own). Save.
6. Left menu → **Data Access** → **Add or remove scopes** → find and tick
   `https://www.googleapis.com/auth/gmail.modify` (if it isn't listed, paste it into "Manually add scopes") → **Update** → **Save**.

## 4. Create the OAuth client
1. Left menu → **Clients** → **Create client**.
2. **Application type: Desktop app.** Name: `Email Organizer Desktop` → **Create**.
3. Copy the **Client ID** and **Client secret**.
   (For installed desktop apps Google does not treat the secret as confidential, but don't commit it to git anyway.)

## 5. Connect in the app
1. Run `npm run dev`, open the **Accounts** tab.
2. Paste the client ID and secret → **Save**, then **Connect Gmail**.
3. Your browser opens Google's sign-in page. You'll see **"Google hasn't verified this app"**. That's expected for an app in Testing mode that you own: click **Advanced → Go to Email Organizer (unsafe)**, then allow access.
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

# Google OAuth verification: demo video and scope justifications

For the Verification Center in Google Cloud Console (Google Auth Platform). Sweep asks for two scopes:

- `https://www.googleapis.com/auth/gmail.modify` (restricted)
- `https://www.googleapis.com/auth/drive.appdata`

## Scope justifications (paste into the form)

**gmail.modify**
Sweep is a desktop app that helps people tidy their own Gmail inbox. It uses this scope to (1) read message metadata (sender, subject, date, size, labels, unsubscribe headers) so it can show who fills the inbox and what takes up space; (2) add or remove labels, archive messages, and mark messages read or unread when the user applies a cleanup rule; and (3) move messages to Trash when the user confirms a cleanup, and move them back when the user presses Undo. Sweep never reads message bodies, never sends mail, and never deletes mail permanently. A narrower scope is not enough, because labeling, archiving and moving to Trash all require modify access, and a narrower scope cannot read the metadata Sweep needs. All processing happens on the user's computer; no mail data is sent to the developer or any third party.

**drive.appdata**
Sweep uses this scope only to read the account's total storage usage and limit, so it can show how full the user's Google storage is and how much a cleanup would free. It does not read, list or change any files in the user's Drive.

## Before recording

- Use a **separate test Gmail account** with some realistic sample mail (promotions, social, a few large attachments, a newsletter). Don't show a personal inbox.
- Use the **production OAuth client** (the one you're submitting), so the client ID in the address bar matches. Make sure the Google account is signed out of Sweep first (Account tab → Disconnect) so you can show a fresh sign-in.
- Set the Google account language to **English**.
- Turn on Do Not Disturb. Close other windows and tabs. Hide the Dock and bookmarks bar if you can.
- Record at **1080p or higher** (macOS: Shift+Command+5, "Record Entire Screen"; or QuickTime). Record the microphone. Speak slowly.
- Keep the browser address bar **visible and readable** while the Google sign-in page is on screen. Zoom in if needed.
- Upload to YouTube as **Unlisted**, and paste the link into the form.

## Shot list and narration (about 4 minutes, one take)

1. **Intro (0:00).** Show the website, https://www.sweepmail.org.
   *"This is Sweep, a desktop app that helps people clean up their Gmail inbox. Everything runs on the user's computer. There is no Sweep server. I'll show how the app uses each Google permission it requests."*

2. **Sign-in and consent (0:20).** In the app, open **Account** and click **Connect Gmail**. The browser opens Google's sign-in page. **Pause on the consent screen with the address bar visible so the `client_id` can be read.** Scroll to show the app name, the logo, and both permissions listed. Click Allow.
   *"The app opens Google's own sign-in page in my browser. The app name is Sweep. It requests two permissions: to view and modify Gmail messages, and the app-data Drive permission. I'll show what each is used for. Sweep never sees my password."*

3. **Overview, gmail.modify metadata (1:00).** Show the **Overview** page filling in: total, unread, tabs, top senders. Open **Senders**.
   *"Sweep reads message headers only (sender, subject, date, size and labels) to show who fills the inbox. It never reads the body of an email."*

4. **Storage, drive.appdata (1:40).** Open **Free up space**. Point at the storage figure at the top ("You're using X of Y").
   *"This storage figure is the only thing the Drive app-data permission is used for. Sweep reads the account's usage and limit. It doesn't read or change any Drive files."*

5. **Cleanup and Trash, gmail.modify (2:10).** On **Free up space**, open one suggestion (for example old promotions), choose some emails, and click **Move to Trash**. Show the confirmation and the result message.
   *"When I choose to clean something up, Sweep moves those messages to Gmail's Trash. It never deletes anything permanently. Starred mail is kept, and I can undo."*

6. **Undo (2:50).** Click **Undo** on the result, or open **Activity** and click Undo on the entry. Show the mail back in Gmail (switch to Gmail in the browser and show it in the inbox).
   *"Every change is logged in Activity, and I can undo it. Here the messages are back in my inbox."*

7. **Labels and archive (3:10).** Open **Cleanup**, pick a rule, click to preview it, then apply a rule that labels or archives. Show the label in Gmail.
   *"Rules can label, archive, or mark mail as read. Sweep always shows a preview of which messages a rule will touch before anything changes."*

8. **Data handling and disconnect (3:40).** Open the privacy policy page on the website, scroll to "Where data lives". Then in the app, **Account → Disconnect**.
   *"Message data is stored only in a local database on this computer, and the sign-in is encrypted with the system keychain. Disconnecting removes the saved data. The full policy is on our website, and it includes Google's Limited Use statement."*

## Checklist before submitting

- [ ] Video shows the consent screen with the `client_id` readable in the address bar
- [ ] Both scopes are shown on the consent screen and each is demonstrated
- [ ] Narration is in English and audible
- [ ] No personal email addresses or other people's mail visible
- [ ] Privacy policy is live at https://www.sweepmail.org/privacy.html with no "Draft" label
- [ ] Domain `sweepmail.org` is verified in Google Search Console
- [ ] Branding page filled in (name, logo, support email, homepage, privacy policy, authorized domain)
- [ ] App set to External and published to Production

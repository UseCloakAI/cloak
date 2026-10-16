# Cloak Agent (Android)

Personal Cloak that lives on a real phone — built for Android Go (Android 8+, 1 GB RAM).
Plain Java, zero dependencies, no AndroidX: the release APK is ~100 KB.

- **Auto-replies to texts** (SMS) with Cloak — same brain as the web app (`POST api.usecloak.org/v1/chat`).
  Batches bursts per sender, keeps a short per-contact history, never answers short codes
  (banks / 2FA), contacts-only by default, 40 replies/sender/day cap, anyone can text `STOP`.
- **Two personas**: "Cloak" (people text Cloak directly) or "Cloak answering for me" (always
  says it's your AI assistant, never commits you to anything).
- **Phone control** via an Accessibility service: open apps, read the screen, tap, type, scroll,
  back/home/recents, clear recents, force-stop ("sleep") apps. Only for **you** — the in-app
  console or texts from your owner number(s). Strangers' texts can never trigger it.
- **Cloak app inbox**: sign the phone into an **admin** Cloak account and it answers chats from
  Settings → Agent in the web app (polls Supabase `agent_messages`: every 3s for 2 min after
  activity, then every 15s). Admin senders get phone control; with Admin → "Admins only" off,
  other signed-in accounts get chat only. Needs `supabase/migrations/20261015000000_phone_agent.sql`.
- **RAM saver**: foreground service that kills cached background apps every N minutes, on
  screen-off and on low memory. Keep-list for apps it must never touch.

## Get the APK

GitHub → Actions → **Android agent** → latest run → download `cloak-agent-apk`. Sideload it.

For updates to install over the old version, add a fixed signing key as repo secrets once:

```bash
keytool -genkeypair -v -keystore agent.jks -alias cloak -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 agent.jks   # → CLOAK_AGENT_KEYSTORE
```

Plus `CLOAK_AGENT_KEYSTORE_PASS`, `CLOAK_AGENT_KEY_ALIAS` (`cloak`), `CLOAK_AGENT_KEY_PASS`.
Without them the APK is debug-signed and each new build needs an uninstall first.

Local build: Android SDK + `gradle assembleRelease` in this folder (Gradle 8.9+, JDK 17).

## Auto-update

Every push to `main` that touches `android-agent/` rebuilds and republishes the
`agent-latest` GitHub release (only once the signing secrets are set). The app checks it every
6 hours (or Updates → Check now), downloads, and installs. Allow "Install unknown apps" for
Cloak Agent once; the first update needs a confirm tap, after that Android 12+ updates silently.

## Phone setup

1. Install, open, tap through the Setup checklist (SMS, Contacts, Notification, Phone control, Battery).
2. Accessibility greyed out / "Restricted setting"? App info → ⋮ → **Allow restricted settings**.
3. Google Messages: turn **off RCS chats** on this phone so every text arrives as SMS
   (RCS messages don't hit `SMS_RECEIVED`, and Android Go blocks notification-listener access).
4. Put your other number in "Your number(s)" to command the phone by text
   ("open Spotify", "free RAM", "what's on screen?").

## Notes / limits

- No calls (by design, for now). No MMS / group texts.
- "Sleep apps" drives Settings → Force stop through accessibility; matches English button text.
- Killing background apps is non-root (`killBackgroundProcesses`): apps with a foreground
  service (music playing, navigation) are left alone by Android.
- Screen text read by the agent is sent to the Cloak API — owner-only, but worth knowing.

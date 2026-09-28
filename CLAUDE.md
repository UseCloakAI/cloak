# Cloak

A human-centric AI assistant. Static frontend on Cloudflare Pages, Supabase backend, Cohere via a Supabase Edge Function.

## Stack

| Layer | Service |
|---|---|
| Frontend | Static HTML/CSS/JS, served by Cloudflare Pages (`wrangler.jsonc`) |
| AI backend | Supabase Edge Function `chat-message` → Cohere API |
| Auth + DB | Supabase (email auth, chat history, profiles, announcements) |

There is **no build pipeline**. Files are served as-is. Push to `main` and Cloudflare Pages auto-deploys.

## Repo layout

- `index.html` — primary marketing landing. Self-contained (does NOT link `cloak.css`).
- `landing.html` — deeper "What is Cloak?" page, reachable from the chat auth screen.
- `values.html` — standalone values / safety laws / principles page (SEO, auth-screen link). Uses `cloak.css`. The in-app Values page in `chat.html` mirrors its copy — change both.
- `chat.html` — the main app: auth screens + the app shell (sidebar + Chat / Brain / Settings / Values pages in `#main`). Uses `cloak.css` + `cloak.js`.
- `agents.html` — standalone agent canvas. Has its OWN inlined theme tokens (`:root` block at lines ~22–58) — these are NOT duplicates of `cloak.css`; they are the page's only design source. Removing them breaks the page.
- `admin-management.html` — internal admin dashboard. Separate design system (yellow accent). Ships with a placeholder anon key.
- `cloak.css` — shared design system used by chat / values / landing.
- `cloak.js` — app logic, auth, Supabase client, settings, theming, chat.
- `motion.js` — shared motion layer (index, landing, values, design-system, chat, agents): scroll reveals (`data-rv`), the crop-mark cursor (`<body data-cursor>`), nav scroll progress (`data-progress`), and `CloakMotion.swapTheme / roll / morph / leave`. No-ops under reduced motion.
- `agent-orbit.js` — standalone "agents working" orb animation (`CloakAgentOrbit.mount(el,{state})`, states `starting`/`looping`/`completed`). Not wired into any page yet.
- `search.js` + `search-patch.js` — web-search overlay used inside chat. `search-patch.js` owns the live `send()` and wires memory + context into it.
- `thread.js` — chat list + conversation (`CloakThread`): owns the sidebar's chat list (`chats` table), switches between them, loads the open chat's `thread_messages` after its "moved on" boundary, persists each message, live-syncs new rows over Realtime (filtered to the open chat, so the same chat open in another tab/device gets messages the instant they land), renders the "Cloak has moved on from these chats" card, and the Settings → Telegram link row.
- `memory.js` / `context.js` / `brain.js` + `brain.css` — memory system: markdown memory files + local recall (`CloakMemory`), budgeted context with chunked compression (`CloakContext`), and the Brain panel (`CloakBrain`). Load before `cloak.js`. See `memory-system.md`.
- `api-worker/` — the `cloak-api` Worker serving `https://api.usecloak.org` (chat, streaming, search, memory extraction, context compression). This is what `chat.html` / `cloak.js` / `search-patch.js` call. Every upstream call goes through `src/governor.js` (free-tier limits). Deploys via Cloudflare Workers Builds; see `api-worker/README.md`.
- `supabase/functions/chat-message/` — Edge Function for chat (Groq + NVIDIA). Used by `agents.html` and the Telegram bot, not the main chat.
- `supabase/functions/telegram-bot/` — Telegram bot (deployed with `verify_jwt: false`). A linked Telegram chat continues the user's active chat (`profiles.active_chat_id` — same context + memories, server-side compression); also serves `?action=link` (web → deep link) and `?relay=<id>` (DB trigger → mirrors web messages from the active chat into the linked Telegram chat as "Name said: …"). Answers via cloak-api.
- `supabase/migrations/` — SQL migrations. Apply via Supabase dashboard or CLI.
- `robots.txt`, `sitemap.xml` — SEO.

## Design system

- **Tokens** (in `cloak.css` `:root` and mirrored in `index.html`):
  `--ink #0A0A0A`, `--paper #F2EEE5`, `--surf #FAFAF7`, `--p2 #EAE5DB`, `--p3 #DDD8CC`, `--acc #D44D2A`, `--acc2 #B83B1D`.
- **Borders**: `--bd: 2px solid #0A0A0A`. Hard, not soft rgba.
- **Shadows**: hard offset, no blur — `--sh: 4px 4px 0 #0A0A0A`, `--shsm: 2px 2px 0`, `--shlg: 6px 6px 0`. Neobrutalist aesthetic.
- **Fonts**: `--fd: 'Syne'` (display, 700/800), `--fu: 'Space Grotesk'` (body, 400/500/600/700).
- **Motion**: the shadow is the floor. Hover lifts by exactly the shadow gained (`translate(-2px,-2px)`, 2→4 / 4→6), press slams flat by the resting shadow (`2px`, `4px` on primary), on `--lift` (spring) / `--tp` (90ms). Spring tokens `--sp-snap/--sp-pop/--sp-soft` are real `linear()` curves with cubic-bezier fallbacks; `--ease-out/-in/-io` for entrances, exits, wipes. Entrances animate the individual `translate`/`scale`/`rotate` properties, never `transform`, so they stack with hover/press. Primitives (`[data-rv]`, `.ln`, `.uc`, `stamp`, theme wipe) live in `cloak.css` "MOTION PRIMITIVES" and are mirrored in `index.html`. Page swaps in the app shell: the leaving page dissolves on top (130ms, opacity only), the next page's header drops in and its body rises — plain CSS that runs whenever a page is shown (`.page`, "PAGES" in `cloak.css`). Full spec: `design-system.md` §6–7.
- **Themes**: `default`, `eco`, `aqua` × `light`/`dark`. Toggled via `localStorage.cloak_theme` and `localStorage.cloak_dark`. Each themed page has an early inline `<script>` that reads localStorage before paint to prevent FOUC — don't move or remove these.
- **`index.html` is its own world**: it has a self-contained `<style>` block and uses `prefers-color-scheme` for dark mode (not the `.dark` class). Its tokens are kept in sync with `cloak.css` manually. When changing tokens, change BOTH places.

## Routing conventions

- Internal links use relative paths (`chat.html`, `values.html`, etc.).
- "Launch App" / "Start Using Cloak" / "Open Cloak" CTAs always point to `https://chat.usecloak.org` (the production app subdomain).
- "Back to Cloak" buttons inside app pages (values, agents) point to `chat.html`, NOT `index.html`. The user came from the app, so they go back to the app.
- `chat.html` auth-note links to `landing.html` for "What is Cloak?".
- Inside the app, Chat / Brain / Settings / Values are pages in one shell — switch with `goPage('<page>')` (`cloak.js`). No back buttons: every page header has the sidebar toggle, and the sidebar marks the current page (`[data-nav]` + `aria-current`). Brain mounts into `#page-brain` (`brain.js`); `CloakBrain.open()` navigates there.
- Sidebar collapse (desktop/tablet, `.sidebar.collapsed`) is an icon rail (`--sw-c`, 76px), not gone: the `C` brand mark + an inline toggle (`.sb-collapse`, mirrors the topbar's `.sb-toggle`) stay, every label (`.sbl` spans, `.sb-label`, conv list, account name/email, guest note) hides, icons center. Below 640px `.collapsed` is still the full off-canvas drawer (no room for a rail on a phone) — that override lives in the mobile media query and wins on width alone, no JS branching needed. Sidebar buttons are tiered on purpose: primary nav (Chat/Brain) bold with a full ink wipe-in on the active page; `New chat` a solid ink CTA; utility (Settings/Our Values, `.sb-util`) quieter, its active state a soft `--p3` tint with accent text, never the nav's ink block; the account row (`button.user-row`) its own bordered `--surf` card, opens Settings.

## Accessibility conventions

- Decorative SVGs: `aria-hidden="true"`.
- Icon-only buttons / anchors: `aria-label="..."`.
- Respect `prefers-reduced-motion`: disable custom cursor, scroll-reveal stagger, decorative keyframes.
- Provide `:focus-visible` rings — keyboard users need to see focus.
- Do NOT add `maximum-scale=1.0` or `user-scalable=no` to viewport meta. Block pinch-zoom = a11y violation.
- Prefer `<a href>` over `<button onclick="window.location.href=...">` for navigation.

## iOS installed app

- `apple-mobile-web-app-status-bar-style` is `default` (opaque) on chat + values. Don't switch back to `black-translucent`: on iOS 26+ it triggers WebKit bug 301108 (window sized one status bar short → dead band under the composer that no CSS/JS can paint) plus the Liquid Glass edge blur over the topbar. iOS caches this meta at install — changes need the app removed and re-added.
- The opaque bar is painted from `theme-color`. `syncThemeColor()` (`cloak.js`) keeps it on the surface under it — loader/auth paper, the shell's topbar surf (every page has one). Call it after any screen switch.
- The composer pads `env(safe-area-inset-bottom)` for the home indicator; the viewport fix pins `#s-chat` to `visualViewport` only while the keyboard is up and sets `html.kb-open`, which drops that padding.

## Don't-touch list

- `agents.html` lines ~22–58 (`:root` token block). Page is standalone; these are its only theme source.
- `cloak.css` tokens. Shared by chat/values/landing. Token shifts ripple through the whole app — when unifying, sync `index.html` to match `cloak.css`, never the other direction.
- The early `localStorage.cloak_dark` / `cloak_theme` inline scripts in `<head>`. They prevent FOUC.
- The early `m-js` inline script on index / landing / values / design-system. It opts the page into hide-until-revealed and drops the class after 3s if `motion.js` never loads — without it, `[data-rv]` content either flashes or never appears.
- Supabase URL + anon key in `cloak.js` (top), `agents.html` (~line 802). Anon keys are publishable (RLS-protected), but extracting them properly needs a build step. Treat as known follow-up.
- `admin-management.html` body. Internal tool, separate design system, currently non-functional (placeholder anon key).
- `chat.html` and `agents.html` body content. Tons of state, IDs read by JS, inline `onclick` handlers. Edit head meta only unless the change is targeted and tested.

## Local dev

```bash
npx wrangler pages dev . --port 8788
# fallback:
python3 -m http.server 8000
```

Then click through:
1. `/` → Launch App goes to `https://chat.usecloak.org`.
2. `/values.html` → both back buttons go to `chat.html`.
3. `/agents.html` → back arrow goes to `chat.html`.
4. `/landing.html` → Launch buttons go to `https://chat.usecloak.org`.
5. `/chat.html` → "What is Cloak?" goes to `landing.html`.

No automated tests.

## Messaging integrations

### Telegram
- Edge Function: `supabase/functions/telegram-bot/index.ts`
- Required secrets: `TELEGRAM_BOT_TOKEN`
- Optional secrets: `TELEGRAM_WEBHOOK_SECRET` (adds request validation — recommended for production)
- Setup:
  1. Create a bot via [@BotFather](https://t.me/BotFather), get the token.
  2. Set secret: `supabase secrets set TELEGRAM_BOT_TOKEN=<token>`
  3. Deploy: `supabase functions deploy telegram-bot`
  4. Register the webhook:
     ```
     curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=<SUPABASE_URL>/functions/v1/telegram-bot"
     ```

### Session persistence
- Uses the `messaging_sessions` table (see `supabase/migrations/20260512000000_messaging_sessions.sql`).
- Apply the migration via Supabase dashboard SQL editor or `supabase db push`.

## Memory + context

- **Multiple chats per user**: `chats` (one row per conversation: title, its own compressed `context`) + `thread_messages` (append-only, all platforms, tagged with `chat_id`). Chunks/digest reference message **ids**, not array positions, scoped to that chat. The digest end is the chat's "moved on" boundary; the web only loads messages after it. `profiles.active_chat_id` points at whichever chat is active — `thread.js` sets it on every switch, and a linked Telegram chat continues it (so Telegram follows whatever's open on web, or the last chat it touched itself if the web was never opened). Realtime is filtered by `chat_id`, so the same chat open in multiple tabs/devices gets new messages live.
- **One Cloak**: every model (Pneuma/Logos/Kairos/Linus) uses the single `CLOAK` prompt in `api-worker/src/prompts.js`. Models differ in provider/settings only — never add per-model personas.
- Full design: `memory-system.md`. Memories are `.md` files (`<type>/<slug>.md`, frontmatter + bullets) stored only in Supabase `memory_files` — never cache them in localStorage (guests: session-only, in RAM).
- Chat history is no longer capped at 20 messages — `chats.context` holds chunk summaries + digest; don't reintroduce `hist.slice(-N)` in the send path.
- Background model calls (extraction, compression) must use the worker's `utility` tier, never a chat tier.
- New provider/model? Add its free-tier numbers to `LIMITS` in `api-worker/src/governor.js`.
- Asset versions: bump `?v=` in `chat.html` and `CACHE_VERSION`/`SHELL` in `sw.js` together; add new shell files to `SHELL`.

## Known follow-ups

- Minify `cloak.css`, `cloak.js`, `search.js`, `search-patch.js` (need a build step).
- Extract Supabase URL/anon key into env vars.
- Replace the placeholder anon key in `admin-management.html`.
- Generate a `og-image.png` (1200×630) and switch `twitter:card` to `summary_large_image`.
- Add a custom `404.html` matching the design system.
- Privacy / Terms pages.
- GDPR cookie-consent gate before AdSense lazy-load in `cloak.js`.
- Dedupe `agents.html` theme tokens into `cloak.css` (requires regression-testing the agent canvas).
- JS module split for `cloak.js`.

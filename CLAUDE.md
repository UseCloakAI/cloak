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
- `effort.js` — the topbar Effort slider (`CloakEffort`): 0–100 with magnetic detents (Minimal/Low/Medium/High/Max), persisted in `localStorage.cloak_effort`. Sent as `effort` on every `/v1/chat` call (`streamChat` in `search-patch.js`) and sets client research depth (sources per search, verification rounds). The worker side is `api-worker/src/effort.js`.
- `search.js` + `search-patch.js` — web-search overlay used inside chat. `search-patch.js` owns the live `send()` and wires memory + context into it.
- `thread.js` — chat list + conversation (`CloakThread`): owns the sidebar's chat list (`chats` table), switches between them, loads the open chat's `thread_messages` after its "moved on" boundary, persists each message, live-syncs new rows over Realtime (filtered to the open chat, so the same chat open in another tab/device gets messages the instant they land), renders the "Cloak has moved on from these chats" card, and the Settings → Telegram link row.
- `builds.js` + `builds.css` — code in chat (`CloakBuilds`): replaces the marked code renderer (filename-aware header, highlight.js, Copy/Download/Edit/Run), turns whole builds (full HTML page, React `jsx`/`tsx` with a default export, SVG, Mermaid) into build cards, and owns the Builds panel (Preview / Code / Console, versions, ask-to-change, "Fix with Cloak" + one-shot auto-repair, export). Builds run in a sandboxed iframe **without** `allow-same-origin` — never add it (the build would get Cloak's origin: session, storage). React compiles with Babel in the page, npm imports come from esm.sh, sibling `title="…"` files in the same message resolve as a multi-file project; JS/TS/Python (Pyodide) run with an output terminal. Editor is CodeMirror 5, lazy-loaded. Also: code-file attachments (+ menu / drop on composer → `[file: name]` + fence, chips in the user bubble). Loads after `cloak.js` (patches `postProcessBotEl` / `addMsg` / `onInput`) and wraps `send()` on DOMContentLoaded, after `search-patch.js`. CDN libs are pinned jsDelivr npm URLs (`CDN` at the top).
- `memory.js` / `context.js` / `brain.js` + `brain.css` — memory system: markdown memory files + local recall (`CloakMemory`), budgeted context with chunked compression (`CloakContext`), and the Brain panel (`CloakBrain`). Load before `cloak.js`. See `memory-system.md`.
- `api-worker/` — the `cloak-api` Worker serving `https://api.usecloak.org` (chat, streaming, search, memory extraction, context compression). This is what `chat.html` / `cloak.js` / `search-patch.js` call. Every upstream call goes through `src/governor.js` (free-tier limits). Deploys via Cloudflare Workers Builds; see `api-worker/README.md`.
- `supabase/functions/chat-message/` — Edge Function for chat (Groq + NVIDIA). Used by `agents.html` and the Telegram bot, not the main chat.
- `supabase/functions/telegram-bot/` — Telegram bot (deployed with `verify_jwt: false`). A linked Telegram chat continues the user's active chat (`profiles.active_chat_id` — same context + memories, server-side compression); also serves `?action=link` (web → deep link) and `?relay=<id>` (DB trigger → mirrors web messages from the active chat into the linked Telegram chat as "Name said: …"). Answers via cloak-api.
- `supabase/migrations/` — SQL migrations. Apply via Supabase dashboard or CLI.
- `robots.txt`, `sitemap.xml` — SEO.

## Versioning — MUST be updated on every commit

**Every commit, without exception, MUST bump the app version.** The version (`version.js` → `window.CLOAK_VERSION`, format `1.<release>.<build>`) is shown on the loading screen and at the bottom of the Settings nav, so users and support can tell exactly which build they're on.

- It's automatic: `.githooks/pre-commit` (and `pre-merge-commit`, for merges) runs `scripts/bump-version.sh`, which sets `build` to this commit's number (`git rev-list --count HEAD` + 1), stamps the date, rewrites `version.js`, updates its `?v=` cache tag in `chat.html` and `sw.js`, and stages them.
- **Enable the hook in every clone/session before committing:** `git config core.hooksPath .githooks`. If the hook isn't active (or you commit another way), run `sh scripts/bump-version.sh` yourself before `git commit`. A commit that doesn't change `version.js` is a mistake — amend it.
- Bump `release` in `version.js` by hand for notable releases (the hook keeps it and resets nothing else).
- Never hard-code a version anywhere else — read `window.CLOAK_VERSION`, or put `data-cloak-version` (short `v1.x.y`) / `data-cloak-version="long"` (`Cloak v1.x.y · date`) on an element and `version.js` fills it.

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
- Sidebar collapse (desktop/tablet, `.sidebar.collapsed`) is an icon rail (`--sw-c`, 76px), not gone. Everything hangs on one spine: icons sit centered on `--sb-axis` (the rail's center) and labels start at `--sb-tx` in BOTH states, so collapsing only narrows the panel and folds the labels away (opacity/translate/blur — staggered by `--sb-d` on open, all at once on close); nothing ever moves sideways. Don't bring back `display:none` / centering swaps for the rail — they break that. The wordmark is `.sb-word` (C + L·O·A·K spans): the C sits on the spine (centered by its measured width, `--c-w`) and stands alone in the rail; the other letters unfold out of it. The header `.sb-logo` is `--bar-h` tall (the topbar's height) and the bottom band `.sb-footer` is `--input-h` (the composer's height, measured in `cloak.js`), both full-bleed on `--surf`: their lines ARE the topbar's and the composer's lines, continued. Keep those heights tied if either changes. The band stacks account / Settings / Our Values on the spine (in the rail: three marks level with the message box). One toggle only — the topbar's `.sb-toggle` — expands and collapses it; the sidebar has no toggle of its own (a duplicate there used to read as two hamburgers). Below 640px `.collapsed` is the off-canvas drawer instead (no room for a rail on a phone): header under the status bar like the topbar, spine on the menu button's center, band level with the composer, Settings | Values sharing a row — that override lives in the mobile media query, no JS branching. Sidebar buttons are tiered on purpose: primary nav (Chat/Brain) bold, and the active page is marked by `.sb-ink` (`cloak.js`) — one ink block that glides between Chat and Brain on a spring, leading edge first, and lets go on other pages; it's the sidebar's only filled state. `New chat` is a plain row like Brain (bold/uppercase label + an accent-colored icon are its only markers — it's an action, not a destination). Utility (Settings/Our Values, `.sb-util`) quieter still, its active state a soft `--p3` tint with accent text. The account row (`button.user-row`) opens Settings. On the collapsed rail, hovering or focusing an item flies its name out beside it (`.sb-tip`, `cloak.js`; native `title`s become `data-tip` + `aria-label`).

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
- **Linus = code mode**: same `CLOAK` prompt plus `CODE_PLAYBOOK` (task instructions — plan, complete runnable code, the build formats `builds.js` renders, self-review). It's a playbook, not a persona. Its `lineup` (like every tier's) is tried in order — Gemini 3.8 Flash → NVIDIA GLM-5.3-Flash → Groq gpt-oss-120b → Gemini 3.5 Flash-Lite → NVIDIA Laguna XS 2.1 → Groq Qwen3.8-27B → NVIDIA Nemotron 3 Super — with per-model temperature / `extra` params / reasoning `reserve` / `firstTokenMs`, and it defaults to 8,192 output tokens (client sends none). Only models that answer at chat speed on the free tier belong there: Kimi K3 and full GLM-5.3 crawl on NVIDIA free (<10 tok/s, minute-long first tokens) and made Linus hang. Keep the build format in `CODE_PLAYBOOK` in sync with what `builds.js` can run.
- **Streaming failover** (`openStream` in `api-worker/src/index.js`): a model that misses its first-token deadline is skipped (and demoted for 10 min); after the stream starts, one that stalls 45s, reasons 2 min without answering, or ends with only reasoning hands over to the next model in the same SSE stream — only once answer text has gone out does a failure end the reply. Gemini 3.x runs at temperature 1.0 (lower loops) with a `thinkingLevel`; thinking counts against every provider's output cap, hence `reserve`. Groq retired its Llama models for free accounts on 2026-08-16 — never add them back.
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

# blinks/ (Cloak Blinks, early preview)

Cloak Blinks, a separate Cloak product, served at **usecloak.org/blinks**. There is no separate site deploy: the main `cloak` Worker serves the whole repo as static assets, so this folder goes live at `/blinks/` when it lands on `main`. The main service worker (`/sw.js`) skips `/blinks`, so Blinks is never served from Cloak's cache. Every page is `noindex` for now, and it uses its own localStorage keys (`pv_*`).

| File | What |
|---|---|
| `index.html` | Home: hero with Cloak texting on a loop, make-your-own section with example Blinks, routing demo, the one rule, the ledger |
| `app.html` + `app.css` + `app.js` | The app, built as a messaging app: replies arrive as short text bubbles with a typing indicator (split at blank lines; code, lists and tables stay whole), the Blink can tapback your message (`[react:X]`) or leave it on read (`[read]`, never when care is showing), your last message shows Delivered / Read, and you can tapback its bubbles (double-click, long-press or the heart). Plus chats, the stage, care card, sponsor card, per-reply energy |
| `impact.html` + `impact.js` | The public carbon ledger and its chart |
| `system.html` | Design system: the name, color, type, parts, the shape rig, motion, voice |
| `kit.css` / `kit.js` | Tokens, components, brand name, light/dark, API base, companion data |
| `creatures.js` | The rig. Every Blink is a spec `{shape, color, eyes, topper, glasses, cheeks}`: 7 shapes (orb, slab, spark, bloom, dome, drop, pill), any colour, 6 eye styles, glasses on any of them (a monocle on one eye), 8 toppers. Dot eyes, no mouths or arms; talking pulses the whole shape. One ships: `cloak`, the O from the wordmark drawn by hand. Every other character is an example or one somebody made |
| `maker.js` | The Blink maker: build your own (look, name, purpose, personality, how it thinks, hello, starters). Stored on this device in `pv_bots` (max 12), sent with each message as `bot` |
| `sync.js` | Optional sign-in with an existing Cloak account; chats sync to `pv_chats` |
| `fonts/`, `icons.svg` | Geist Mono (OFL), plus older font files no page loads; Phosphor Regular (MIT). Syne, Space Grotesk and Caveat come from Google Fonts |

Backend: `../blinks-api` (separate Worker, `cloak-blinks-api` at `blinks-api.usecloak.org`). Until it is deployed the app says so and plays short scripted replies, and the ledger shows clearly labelled sample data.

## Run it

```bash
npx wrangler dev --port 8787        # in blinks-api/ (needs provider keys in KV to answer)
python3 -m http.server 8799         # at the repo root, then open /blinks/
```

On localhost the site talks to `http://localhost:8787`. Anywhere else it talks to `https://blinks-api.usecloak.org`. Override with `?api=https://…` (remembered).

## Put it live

1. The site: merge to `main`. The `cloak` Worker serves it at usecloak.org/blinks.
2. The backend: Cloudflare dashboard, Workers & Pages, Create, import this repo with root directory `blinks-api` and deploy command `npx wrangler deploy`. Its `wrangler.jsonc` attaches `blinks-api.usecloak.org`. Add the secret `ADMIN_TOKEN`, then check models with `/admin/probe`.
3. Optional: apply `supabase/migrations/20261110000000_preview_chats.sql` so signed-in chats sync.
4. When it should be found by search engines: drop the `noindex` meta tags and add `/blinks/` to `sitemap.xml`.

## The name

The product is **Cloak Blinks**, a separate product under Cloak. `kit.js` renders every `[data-brand]` as CL(O)AK, where the O is a hand-drawn orb with eyes that follows the pointer and blinks, plus a handwritten "blinks" in the accent. Tokens are Cloak's own (ink, paper, orange, 2px borders, hard shadows, Syne + Space Grotesk, Caveat for the handwriting, all from Google Fonts). The backend's brand default is `BRAND` in `blinks-api/wrangler.jsonc`.

## Rules that hold everywhere

- Zero em-dashes in visible copy. No emoji in the UI except reactions. Proper grammar in all copy, including the texts. One accent colour (Cloak orange). Square corners, 2px ink borders, hard shadows.
- Companion art is hand-drawn paths in `creatures.js`. No image files, no generated art.
- Any number about energy or carbon is labelled an estimate. "Removed" means a receipt exists.
- Sponsor cards never appear inside a reply and are never targeted.

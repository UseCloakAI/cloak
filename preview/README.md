# preview/ (rebrand prototype, not live)

The full rebrand, built to live at `preview.usecloak.org`. Nothing in production loads it. Every page is `noindex`, and it uses its own localStorage keys (`pv_*`).

| File | What |
|---|---|
| `index.html` | Home: hero with the five companions, companion picker, routing demo, the one rule, the ledger |
| `app.html` + `app.css` + `app.js` | The chat app: companions, chats, the stage, care card, sponsor card, per-reply energy |
| `impact.html` + `impact.js` | The public carbon ledger and its chart |
| `system.html` | Design system: name candidates (live switch), color, type, parts, creature rig, motion, voice |
| `kit.css` / `kit.js` | Tokens, components, brand name, light/dark, API base, companion data |
| `creatures.js` | The five companions: hand-drawn SVG, rigged and animated in code |
| `sync.js` | Optional sign-in with an existing Cloak account; chats sync to `pv_chats` |
| `fonts/`, `icons.svg` | Bricolage Grotesque, Geist, Geist Mono (OFL); Phosphor Regular (MIT) |

Backend: `../preview-api` (separate Worker). Until it is deployed the app says so and plays short scripted replies, and the ledger shows clearly labelled sample data.

## Run it

```bash
npx wrangler dev --port 8787        # in preview-api/ (needs provider keys in KV to answer)
python3 -m http.server 8799         # in preview/
```

On localhost the site talks to `http://localhost:8787`. Anywhere else it talks to `https://preview-api.usecloak.org`. Override with `?api=https://…` (remembered).

## Put it on preview.usecloak.org

1. Cloudflare dashboard, Workers & Pages, Create, import this repo. Root directory `preview`, deploy command `npx wrangler deploy`. `wrangler.jsonc` attaches `preview.usecloak.org`.
2. Same again for the backend with root directory `preview-api`. It attaches `preview-api.usecloak.org`. Add the secret `ADMIN_TOKEN`.
3. Optional: apply `supabase/migrations/20261110000000_preview_chats.sql` so signed-in chats sync.

## The name

Working name is **Kith**. Tend and Alder are the other candidates; switch between them on `system.html#name`. To lock one in: set the default in `kit.js` (`brand`) and `BRAND` in `preview-api/wrangler.jsonc`.

## Rules that hold everywhere

- Zero em-dashes in visible copy. One accent color (marigold). Controls are pills, surfaces 20px, fields 14px.
- Creature art is hand-drawn paths in `creatures.js`. No image files, no generated art.
- Any number about energy or carbon is labelled an estimate. "Removed" means a receipt exists.
- Sponsor cards never appear inside a reply and are never targeted.

# cloak-preview-api

Backend for the rebrand prototype (`preview.usecloak.org`). A separate Worker from production `cloak-api`. It shares only the provider key ring (KV, read-only) and the free-tier governor (`../api-worker/src/governor.js`), so the preview cannot burn quota the live app needs.

## Routes

| Route | What |
|---|---|
| `POST /v1/chat` | `{companion, messages, mode?, brand?, user?, images?}` → SSE: `{meta}` `{care?}` `{start}` `{delta}`… `{done, usage, impact}` or `{error}` |
| `GET /v1/companions` | The five companions and the public lanes |
| `GET /v1/impact?days=90` | The public carbon ledger |
| `POST /v1/ads/event` | `{sponsor, kind: "view" \| "click"}` |
| `GET /admin/probe` | Times every model in every lane (first token, tokens/sec). `X-Admin-Token` |
| `POST /admin/offsets` | Record retired credits: `{kg, usd, project, registry, receipt, day?}`. `X-Admin-Token` |
| `POST /admin/revenue` | Book real sponsor revenue: `{usd, day?}`. `X-Admin-Token` |

## How a message is answered

1. **Safety first** (`src/safety.js`). Every turn is checked before any model runs. If someone may be in danger the request goes to the strongest general lane, the CARE protocol is added to the prompt, and the client gets a `care` event with helplines for the person's country, which the app pins above the reply whatever the model writes.
2. **Route** (`src/models.js`). A cheap heuristic (no model call) picks a lane: `swift`, `smart`, `deep`, `code`, `creative`, `vision`. Nothing special about the turn means the companion's home lane. The person can force Swift or Deep.
3. **Prompt** (`src/prompts.js`). Constitution (the one rule, how to think, how to talk) + companion voice + lane playbook + care protocol if active + context.
4. **Stream with failover** (`src/engine.js`). The lane's lineup is tried best-first. A model that misses its first-token deadline is skipped and tried last for 10 minutes; 429s cool that key; retired models are skipped for hours. Once text has gone out, a failure ends the reply honestly instead of restarting.
5. **Count it** (`src/carbon.js`, `src/ledger.js`). Tokens become Wh and grams CO2e, written to the Ledger Durable Object.

## Models

NVIDIA's free API leads every lane; Groq and Gemini are safety nets. Ids were read from `GET https://integrate.api.nvidia.com/v1/models` on 2026-11-10. They were **not benchmarked** (no keys in the build session), so after the first deploy run:

```bash
curl -H "X-Admin-Token: $ADMIN_TOKEN" https://preview-api.usecloak.org/admin/probe
```

and reorder the lineups in `src/models.js` by what is actually fast. Production's lesson still applies: only models that answer at chat speed on the free tier belong at the front of a lane.

## The ledger

Three kinds of numbers, never mixed: **emitted** (modelled, labelled estimated), **funded** (the 10x pledge as far as sponsor revenue covers it), **retired** (credits bought, each with a registry receipt). Only retired counts as removed. Constants live in `src/carbon.js`.

## Config

- KV `PROVIDER_KEYS` (same namespace as production): `{"nvidia":[…], "groq":[…], "gemini":[…]}`
- Vars: `BRAND` (working name), `CONVICTIONS` (`"off"` leaves the faith block out of the prompt), `ALLOWED_ORIGINS` (extra CORS origins, comma separated)
- Secret: `ADMIN_TOKEN`
- `UPSTREAM_OVERRIDE` is for local tests against a mock server only. Never set it in production.

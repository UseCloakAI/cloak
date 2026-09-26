# cloak-api

Cloudflare Worker behind `https://api.usecloak.org`. Deployed by Cloudflare Workers Builds from this folder (root directory `api-worker`, deploy command `npx wrangler deploy`).

## Routes

| Route | Format | Streaming |
|---|---|---|
| `POST /v1/chat` | native `{model, messages, system?, max_tokens?, imageBase64?, mimeType?, stream?}` → `{model, response}` | `stream: true` → SSE `data: {"delta"}` … `{"done", "model", "response"}` or `{"error", "partial"}` |
| `POST /v1/chat/completions` | OpenAI-compatible (needs API key) | OpenAI chunk format + `[DONE]` |
| `POST /v1/messages` | Anthropic-compatible (needs API key) | Anthropic event format |
| `POST /v1/search` | `{query, start?}` → `{items:[{title, link, snippet}]}` | — |
| `GET/POST/DELETE /admin/provider-keys` | `X-Admin-Token` | — |

## Models

Configured in `MODEL_CONFIG` in `src/index.js`. Each tier fails over provider → provider (and key → key) until one produces a first token. Vision goes Gemini → NVIDIA vision → text-only fallback. Model IDs go stale; when chat says "Cloak AI is currently unavailable", check Workers Logs for `[cloak-api] all providers failed` — the line lists each provider's exact error.

## Config

- `PROVIDER_KEYS` KV, key `keys`: `{"groq":[…], "nvidia":[…], "gemini":[…]}`
- Secrets: `ADMIN_TOKEN`; optional `API_KEY` (OpenAI/Anthropic endpoints), `GOOGLE_CSE_KEY` + `GOOGLE_CSE_CX`
- Search order: Tavily → Google CSE → DuckDuckGo. Tavily keys are pooled from `PROVIDER_KEYS` KV under `tavily` (add each free key with `POST /admin/provider-keys {"provider":"tavily","key":"tvly-…"}`); a random key is used per call and it rolls to the next on 401/429/432/433.
- `POST /v1/extract {url, format:"text"|"raw", maxChars}` — page text (Tavily extract → direct fetch) or the raw page body (HTML/JSON/CSV/text, 2 MB cap, public URLs only)

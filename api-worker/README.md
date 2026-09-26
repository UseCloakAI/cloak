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
- Secrets: `ADMIN_TOKEN`; optional `API_KEY` (OpenAI/Anthropic endpoints), `GOOGLE_CSE_KEY` + `GOOGLE_CSE_CX` (otherwise search uses DuckDuckGo)

# cloak-api

Cloudflare Worker behind `https://api.usecloak.org`. Deployed by Cloudflare Workers Builds from this folder (root directory `api-worker`, deploy command `npx wrangler deploy`).

## Routes

| Route | Format | Streaming |
|---|---|---|
| `POST /v1/chat` | native `{model, messages, system?, max_tokens?, imageBase64?, mimeType?, stream?}` → `{model, response}` | `stream: true` → SSE `data: {"delta"}` … `{"done", "model", "response"}` or `{"error", "partial"}` |
| `POST /v1/chat/completions` | OpenAI-compatible (needs API key) | OpenAI chunk format + `[DONE]` |
| `POST /v1/messages` | Anthropic-compatible (needs API key) | Anthropic event format |
| `POST /v1/search` | `{query, start?}` → `{items:[{title, link, snippet}]}` | — |
| `POST /v1/memory/extract` | `{turns:[{user, assistant}], existing:[{path,title,type,tags,body}], today?}` → `{ops:[…]}` | — |
| `POST /v1/context/compress` | `{mode:"chunk", messages, words?}` or `{mode:"merge", summaries, words?}` → `{summary}` | — |
| `GET /v1/usage` | this isolate's key cooldowns + learned limits (hashed ids) | — |
| `GET/POST/DELETE /admin/provider-keys` | `X-Admin-Token` | — |

## Models

Configured in `MODEL_CONFIG` in `src/index.js`: each tier is an ordered `lineup` of `{provider, model}` with per-model `temperature`, `extra` params (dropped automatically if a provider rejects them), a reasoning `reserve` and `firstTokenMs`. A tier fails over model → model (and key → key) until one produces a first token; a slow first token demotes the model for 10 min. After that, a stream that stalls, reasons too long without answering, or ends with only reasoning hands over to the next model inside the same SSE stream. Vision goes Gemini → NVIDIA vision → text-only fallback. Model IDs go stale; when chat says "Cloak AI is currently unavailable", check Workers Logs for `[cloak-api] all providers failed` — the line lists each provider's exact error.

## Free-tier governor

`src/governor.js` sits in front of every upstream call: caches the KV keyring (1 read/min/isolate), rotates keys round-robin, cools keys on 429/quota headers (shared across isolates via the Cache API), skips retired models for 6 h, and sizes `max_tokens` + history under each model's TPM. Memory extraction and context compression run on the `utility` tier (Groq `gpt-oss-20b` first). Limits table: `LIMITS` in `src/governor.js`; details in `/memory-system.md`.

## Config

- `PROVIDER_KEYS` KV, key `keys`: `{"groq":[…], "nvidia":[…], "gemini":[…]}`
- Secrets: `ADMIN_TOKEN`; optional `API_KEY` (OpenAI/Anthropic endpoints), `GOOGLE_CSE_KEY` + `GOOGLE_CSE_CX`
- Search order: Tavily → Google CSE → DuckDuckGo. Tavily keys are pooled from `PROVIDER_KEYS` KV under `tavily` (add each free key with `POST /admin/provider-keys {"provider":"tavily","key":"tvly-…"}`); a random key is used per call and it rolls to the next on 401/429/432/433.
- `POST /v1/extract {url, format:"text"|"raw", maxChars}` — page text (Tavily extract → direct fetch) or the raw page body (HTML/JSON/CSV/text, 2 MB cap, public URLs only)

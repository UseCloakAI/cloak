# Cloak memory system

Long-term memory, a live "Brain" view of it, and budgeted context compression — built to stay inside every provider's free tier.

| Piece | File | Runs where |
|---|---|---|
| Memory store + recall + extraction queue | `memory.js` (`window.CloakMemory`) | browser |
| Context window builder + chunked compression | `context.js` (`window.CloakContext`) | browser |
| Brain UI (map, recall list, context meter, .md editor) | `brain.js` + `brain.css` (`window.CloakBrain`) | browser |
| Send-path glue | `search-patch.js` (`_prepareContext`, `_afterTurn`) | browser |
| Extraction + compression endpoints | `api-worker/src/memory.js` | `cloak-api` Worker |
| Free-tier governor | `api-worker/src/governor.js` | `cloak-api` Worker |
| Tables | `supabase/migrations/20260926230000_memory_system.sql` | Supabase |

## Memories are markdown files

One small `.md` file per memory, stored at `<type>/<slug>.md`:

```md
---
title: Builds Cloak
type: project
tags: [cloak, cloudflare, supabase]
importance: 0.8
created: 2026-09-26
updated: 2026-09-26
source: auto
---
- User builds Cloak, a human-centric AI platform (usecloak.org).
- Stack: Cloudflare Pages + Workers, Supabase.
```

| type | Brain lobe | What goes in it |
|---|---|---|
| `project` | Frontal | ongoing work, goals, tech choices |
| `fact` | Parietal | durable specifics of the user's world |
| `profile` | Occipital | stable facts about the user |
| `episode` | Temporal | notable dated decisions/events |
| `preference` | Cerebellum | how they want answers |

- `MEMORY.md` is a generated index (one line per file), shown first in the Brain's file list.
- **Export .md** downloads `MEMORY.md` + every file as one bundle (`<!-- file: path -->` separators); **Import .md** reads that bundle or a single file back.
- Stored **only in Supabase** `memory_files` (RLS owner-only, 400-row hard cap, client keeps ≤300). The browser holds a RAM working copy for recall and never writes memories to localStorage (older device copies are purged on load). Guests get session-only memory, carried into the account if they sign in in the same session.
- The Brain's **Memory** switch turns recall and saving off entirely.
- Never stored (extraction prompt): credentials, card/ID numbers, exact addresses, health/mental-health details, religion/politics/sexuality unless explicitly asked, other people's private details.

## Recall (every message, zero API calls)

`CloakMemory.recall(message, {context, budget})`:

1. BM25 over title (×2.2), tags (×2), body, with light stemming and half-weight prefix matches (`deploy` ↔ `deployment`). The last few turns are added to the query at lower weight.
2. Score = `0.7·relevance + 0.15·importance + 0.08·recency + 0.07·usage`.
3. **Core** notes (profile/preference with importance ≥ 0.7) are always included, capped at 45% of the memory budget; the rest is filled with relevant notes above a relevance floor.
4. The result becomes a `## USER MEMORY` block in the system prompt, after the stable search prompt and before the clock (keeps the cacheable prefix stable).

The Brain lights up recalled nodes and sends a signal from the brainstem to each one. Replies that used a non-core memory get a small "N memories" chip.

## Writing memories (batched, cheap)

- **Explicit**: "remember that …" / "remember: …" / "forget …" are handled instantly, locally (no model call). A near-duplicate is folded into the existing file.
- **Automatic**: only turns with a self-disclosure signal ("I'm", "my", "I prefer", "we use", …) are queued. The queue is sent to `POST /v1/memory/extract` after 3 signal turns or 25 s idle (or on chat switch / tab hidden), never closer than 20 s apart, max 60 calls per browser per day. The model gets the new turns plus the ~14 most related existing notes and returns add/update/delete ops, which are validated on both server and client.

## Context window (budgeted, compressed in chunks)

Per request, `CloakContext.build()` spends a per-tier token budget:

| Tier | Budget | Memory | Summaries |
|---|---|---|---|
| pneuma / logos | 5,200 | 420 | 900 |
| kairos | 9,000 | 700 | 1,600 |
| linus | 7,000 | 520 | 1,200 |

Budget = memory + summaries + recent turns. Persona (~1.8k) + app prompt (~1k) + budget + 2k reply reserve ≈ 10k, under Groq 70B's 12K TPM.

Layout: `[memory] [digest] [chunk summaries] [gap] [recent turns verbatim]`.

- **Chunks**: once a chat's unsummarised history passes 80% of the budget, the oldest ~2.4k tokens (≤14 messages, ending on a reply) are compressed ~9:1 via `POST /v1/context/compress` — one chunk per reply, in the background.
- **Digest**: when there are 5 chunks or they exceed the summary budget, the oldest ones are merged into a digest (summary of summaries). Context stays bounded however long the chat gets.
- **Gap**: turns that aren't summarised yet and don't fit verbatim get a free local abbreviation, so nothing silently drops out while compression catches up.
- Old verbatim messages over 1,400 tokens are clipped head+tail; the new message and the reply before it are never clipped.
- State lives on `chats.context` (`{v:1, chunks:[{s,e,sum,tok}], digest:{e,sum,tok,n}}`, indices into `chats.messages`). Editing a message drops summaries that covered removed turns. Full history is now kept (the old 20-message cap is gone).

## Free-tier governor (`api-worker/src/governor.js`)

Every upstream call from the Worker goes through it:

- **Utility tier** — extraction and compression run on `llama-3.1-8b-instant` (Groq free: 14,400 req/day) → NVIDIA → Gemini, so chat tiers keep their quota (Groq 70B: 1,000 req/day).
- **Fit** — `max_tokens` is shrunk (floor 900) so prompt + max_tokens stays under the model's TPM (Groq counts both), then the oldest turns are trimmed (tool-call pairs kept together). Prevents 413s.
- **Learned limits** — Groq's `x-ratelimit-*` headers update TPM/RPD live and put a key on cooldown when its minute tokens or daily requests run out.
- **Cooldowns** — 429s (`retry-after` / `retryDelay`), auth failures, and retired models (skipped for 6 h) are remembered per isolate and shared across isolates via the Cache API (no KV writes).
- **Rotation** — healthy keys are tried round-robin so pooled free keys wear evenly; cooling keys go last.
- **Keyring cache** — `PROVIDER_KEYS` is read from KV once a minute per isolate instead of 2–3 times per request (KV free: 100k reads/day).
- `GET /v1/usage` — this isolate's view of key cooldowns and limits (hashed key ids, no key material).

Default limits (updated live from headers where available):

| Provider:model | RPM | RPD | TPM |
|---|---|---|---|
| groq:llama-3.3-70b-versatile | 30 | 1,000 | 12,000 |
| groq:llama-3.1-8b-instant | 30 | 14,400 | 6,000 |
| groq:openai/gpt-oss-120b | 30 | 1,000 | 8,000 |
| nvidia:* | 40 | — | — |
| gemini:* | 10 | 250 | 250,000 |

## Follow-ups

- Telegram bot (`messaging_sessions.history`) could use `/v1/context/compress` instead of its fixed history cap.
- Semantic recall (embeddings) if lexical recall proves too literal — would cost one embedding call per message.

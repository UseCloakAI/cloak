# cloak-preview-api

Backend for the rebrand prototype (`preview.usecloak.org`). A separate Worker from production `cloak-api`. It shares only the provider key ring (KV, read-only) and the free-tier governor (`../api-worker/src/governor.js`), so the preview cannot burn quota the live app needs.

## Routes

| Route | What |
|---|---|
| `POST /v1/chat` | Agent run. `{companion, messages, mode?, run_id?, chat_id?, brand?, user?, images?}` → SSE: `{meta}` `{care?}` `{step}`… `{sources}` `{delta}`… `{done, usage, impact}` or `{error}`. Modes: `auto`, `swift`, `deep`, `research`, `team` |
| `GET /v1/runs/:id?from=N` | Re-attach to a cloud run and replay from event N. `POST /v1/runs/:id/cancel` stops it |
| `GET /v1/me` | The person's memories, scheduled tasks and inbox. `DELETE` erases all of it |
| `POST /v1/memory`, `DELETE /v1/memory[/:id]` | Add or delete memories |
| `POST /v1/tasks`, `DELETE /v1/tasks/:id` | Schedule or cancel a task |
| `POST /v1/inbox/seen`, `DELETE /v1/inbox/:id` | Inbox housekeeping |
| `GET /v1/tools` | Tool catalog and modes |
| `POST /v1/speech`, `GET /v1/speech/voices` | Text to speech (WAV), reusing production's NVIDIA Magpie client |
| `GET /v1/companions` | The five companions and the public lanes |
| `GET /v1/impact?days=90` | The public carbon ledger |
| `POST /v1/ads/event` | `{sponsor, kind: "view" \| "click"}` |
| `GET /admin/probe` | Times every model in every lane (first token, tokens/sec). `X-Admin-Token` |
| `POST /admin/offsets` | Record retired credits: `{kg, usd, project, registry, receipt, day?}`. `X-Admin-Token` |
| `POST /admin/revenue` | Book real sponsor revenue: `{usd, day?}`. `X-Admin-Token` |

Identity: `Authorization: Bearer <Supabase token>` (verified with Supabase) or `X-Device: <random id the app keeps>`. Without either the agent still works, with no memory, tasks or inbox.

## The agent runtime

`src/agent.js` runs one companion on a task: call the model with tools, run the tool calls it asks for (in parallel), feed the results back, repeat until it answers or the step budget runs out (6 normally, 10 in research, 4 for a sub-agent). Native OpenAI-style tool calling; if every model in a lane rejects the tool schema, the step is retried once without tools.

| Tool | What it does |
|---|---|
| `web_search` | Tavily (keys under `tavily` in the key ring), then DuckDuckGo. `recent` limits to the last 7 days |
| `read_page` | Reads a public page as text. Public http(s) only, no IPs or internal hosts |
| `calculate` | A real expression parser (no eval) |
| `remember` / `recall` / `forget` | The person's long-term memory, shared by all five companions |
| `ask_companion` | Hands a self-contained job to another companion (a sub-agent with its own tools) |
| `schedule_task` / `list_tasks` / `cancel_task` | Work that runs later or on a repeat, with the result delivered to the inbox |

- **Guard** (`tools.js`): every search, page read and scheduled prompt is screened before it runs. Self-harm methods, locating or unmasking a private person, mass-harm weapons, sexual content involving minors and partner surveillance are blocked at the tool, whatever the model was talked into. Only tools offered on a call can run.
- **Images**: a vision model looks first; the agent then works from its description with the full toolbelt.
- **Research mode**: deep lane, bigger step budget, a research playbook (plan, search several angles, read primary sources, cross-check, cite).
- **Team mode**: three other companions work the request in parallel as sub-agents, each from its own angle, then the lead writes one answer from their drafts.
- **Memory** (`mind.js`, one Durable Object per person): relevant memories go into every prompt. Companions save lasting facts with `remember`; a cheap utility-lane pass after each turn catches what they missed. Secrets are refused, near-duplicates update in place, capped at 200.
- **Tasks** (`mind.js`): the object's alarm runs due tasks as headless agent runs (which cannot schedule more work) and puts results in the inbox. Up to 10 per person.
- **Cloud runs** (`run.js`): with a `run_id`, the work happens in an `AgentRun` Durable Object, so it survives a closed tab. Clients re-attach with `?from=N`. A run that finishes unwatched is delivered to the inbox.

Not built yet: code execution and a file workspace (waiting on the real-computer workspaces), image generation.

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
- Durable Objects: `LEDGER`, `MIND`, `AGENT_RUN`
- Vars: `SUPABASE_URL` + `SUPABASE_ANON_KEY` (publishable; only to verify sign-in tokens), `BRAND` (working name), `CONVICTIONS` (`"off"` leaves the faith block out of the prompt), `ALLOWED_ORIGINS` (extra CORS origins, comma separated)
- Secret: `ADMIN_TOKEN`
- `UPSTREAM_OVERRIDE` is for local tests against a mock server only. Never set it in production.

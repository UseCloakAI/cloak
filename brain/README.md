# brain/ (Cloak Brain, the home PC)

The home-PC half of Cloak Blinks. Cloudflare stays the front door; this
machine is the brain behind it: the agent loop, each person's memory,
scheduled tasks and inbox, chat files, a copy of every chat, and the
management site.

```
Browser ── usecloak.org/blinks ── blinks-api.usecloak.org (Worker) ══ tunnel ══ brain.usecloak.org (this PC)
                                         │                                      │
                                Supabase: accounts, chats, Blinks      memory, tasks, files, chat copies
                                Low Light when the PC is away           models + web via the Worker
```

| File | What |
|---|---|
| `server.js` | The service. Node 22+, no npm dependencies. Listens on 127.0.0.1:7777 only; Cloudflare reaches it through the tunnel |
| `sqlite.js` | Lets `blinks-api/src/mind-core.js` (memory, tasks, inbox) run on `node:sqlite` |
| `admin/index.html` | The management site at brain.usecloak.org/admin |
| `install.sh` | One-command installer for Debian/Ubuntu |
| `SETUP-GUIDE-PROMPT.md` | A prompt for a helper AI to walk someone through prepping the PC |

The agent itself is not copied here: the installer fetches `blinks-api/src` and `api-worker/src/governor.js` and runs the same code the Worker runs.

## How it fits together

- **Turns.** The Worker sends each turn to `POST /v1/turn` (SSE back, pings every 10s). If the brain does not answer within 8 seconds, or drops out mid-reply, the Worker finishes the turn itself in **Low Light**: plain chat, no memory, no tools, lighter models.
- **Status.** A Cloudflare cron checks `GET /health` every minute and stores the result. The site reads `GET /v1/status` and shows the Low Light banner (and sleepy eyes) when the brain is away or paused.
- **Models and the web.** The brain calls the Worker (`/internal/lane`, `/internal/net`, `/internal/ledger`), so provider keys stay in Cloudflare.
- **Chats.** Supabase (`pv_chats`) is the main copy, written by the browser. The brain keeps its own copy from every turn in `/var/lib/cloak-brain/chats`.
- **Files.** Chat files upload through the Worker to `/v1/files` and live in `/var/lib/cloak-brain/files/<person>/` (100 MB each). In Low Light they are unavailable.
- **Security.** Every brain route needs the shared `BRAIN_TOKEN` (only the Worker has it), except `/admin`, which needs a Cloak account on the admin list. The service runs as an unprivileged user with a read-only system.

## Install

1. Prep the PC (Debian or Ubuntu, internet, a login). `SETUP-GUIDE-PROMPT.md` covers it.
2. Ask for a pairing code (made with `POST /admin/pair` on the Worker; good for one hour, one use).
3. On the PC:
   ```bash
   curl -fsSL https://usecloak.org/brain/install.sh | sudo bash -s -- ABCD-EFGH-JKLM
   ```
4. Open https://brain.usecloak.org/admin and sign in with your Cloak account.
5. Set `BRAIN_URL` on the Worker (`blinks-api/wrangler.jsonc` vars) and redeploy. From then on, turns go to the brain.

Update: run the same command without a code. Uninstall: `... | sudo bash -s -- --uninstall` (data in `/var/lib/cloak-brain` is kept).

Logs: `journalctl -u cloak-brain -f` and `journalctl -u cloudflared -f`, or the Log panel on /admin.

## Back it up

Files and memories exist only on this PC. Copy `/var/lib/cloak-brain` somewhere else every night (an external drive, or a cheap cloud backup).

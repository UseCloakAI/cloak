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
| `blinks.js` | Each Blink as a folder: `SOUL.md`, `USER.md`, `MEMORY.md`, `HISTORY.md`, its one continuous chat (`log.jsonl`), tasks. Compaction and Blink-to-Blink messaging |
| `sqlite.js` | Lets `blinks-api/src/mind-core.js` (memory, tasks, inbox) run on `node:sqlite` |
| `admin/index.html` | The management site at brain.usecloak.org/admin |
| `install.sh` | One-command installer for Debian/Ubuntu |
| `SETUP-GUIDE-PROMPT.md` | A prompt for a helper AI to walk someone through prepping the PC |

The agent itself is not copied here: the installer fetches `blinks-api/src` and `api-worker/src/governor.js` and runs the same code the Worker runs.

## How it fits together

- **Turns.** The Worker sends each turn to `POST /v1/turn` (SSE back, pings every 10s). If the brain does not answer within 8 seconds, or drops out mid-reply, the Worker finishes the turn itself in **Low Light**: plain chat, no memory, no tools, lighter models.
- **Status.** A Cloudflare cron checks `GET /health` every minute and stores the result. The site reads `GET /v1/status` and shows the Low Light banner (and sleepy eyes) when the brain is away or paused.
- **Models and the web.** The brain calls the Worker (`/internal/lane`, `/internal/net`, `/internal/ledger`), so provider keys stay in Cloudflare.
- **Blinks.** Every Blink has one continuous chat and its own folder in `/var/lib/cloak-brain/blinks/<person>/<blink>/`: `SOUL.md` (who it is, seeded from its persona, editable in the app), `USER.md` and `MEMORY.md` (what it remembers, one fact per line), `HISTORY.md` (older messages, compacted automatically once the chat passes 30 messages; the newest 12 stay verbatim) and `log.jsonl` (every message). The app sends its copy of the chat each turn; the brain lines it up with `log.jsonl` and adds what is new (including messages sent in Low Light).
- **Keeps working when you leave.** Once the brain has a message it finishes the reply even if the browser or the Worker hangs up, and writes it into the Blink's chat. The app catches up with `GET /v1/blink/since?t=`. Scheduled task results land in the chat too.
- **Blinks message each other** with the `message_blink` tool (the other Blink answers with its own soul and memory, in its own chat). No fixed limit: every 4 messages in one exchange a small model call checks whether they are still making progress, and stops the exchange if they are going in circles (40 messages is a hard ceiling).
- **Files.** Chat files upload through the Worker to `/v1/files` and live in `/var/lib/cloak-brain/files/<person>/` (100 MB each). In Low Light they are unavailable.
- **Security.** Every brain route needs the shared `BRAIN_TOKEN` (only the Worker has it), except `/admin`, which needs a Cloak account on the admin list. The service runs as an unprivileged user with a read-only system.

## Cloak Computer (optional): everyone gets their own machines

`curl -fsSL https://usecloak.org/brain/install.sh | sudo bash -s -- --with-computer` runs `vm/setup.sh` (KVM/libvirt), which builds two sealed golden images once:

| Image | OS | Slot on this PC |
|---|---|---|
| desktop | Debian 13 + minimal XFCE (1280x800), Firefox, terminal | 1 slot: 6 GB RAM, 4 vCPU |
| server | Debian 13 cloud image, no desktop | 2 slots: 1.5 GB RAM, 2 vCPU each |

- **One machine per person, per kind.** The brain (`computer.js`) gives each person their own disks on top of the images (`/var/lib/cloak-vm/users/<id>/`, copy-on-write, capped at the image size: 16 GB desktop, 12 GB server), their own cloud-init seed and their own agent key (kept in `/var/lib/cloak-brain/computer/`, mode 600). Nothing is shared between people: disk, browser profile, processes, ports, `/tmp`, packages. Inside their own machine the person (and their Blink) has sudo.
- **Sealed.** Every machine sits on an isolated port of `cloak-vm` (10.77.0.0/24) with libvirt's `clean-traffic` filter (no MAC/IP spoofing), so machines cannot reach each other. The `cloak_vm` nftables table lets them reach the internet only: no LAN, router, link-local, multicast or this PC (except DNS/DHCP). The agent inside (`vm/agent.py`) answers only 10.77.0.1, with that machine's key. Golden images ship with SSH off and unattended security upgrades on.
- **Asleep until needed.** A machine boots into a slot when its person needs it (about a minute on a hard drive) and shuts down after 10 minutes unused. The desktop slot is held by its driver for 4 minutes after their last action; anyone else's desktop waits ("in use"). A server slot quiet for a minute is handed to whoever needs it. Running machines are re-adopted after a brain restart.
- **Deleting.** Settings > Reset everything also destroys the person's machines, disks and keys.
- **Who can use it:** admins only by default; switch to everyone on /admin.
- Tools: `computer_look`, `computer_click`, `computer_type`, `computer_key`, `computer_scroll`, `computer_drag`, `computer_run`, `server_run`.
- Not covered: the brain PC's own disk is not encrypted. Full-disk encryption (LUKS) needs a reinstall; a good moment is when an SSD goes in.

## Install

1. Prep the PC (Debian or Ubuntu, internet, a login). `SETUP-GUIDE-PROMPT.md` covers it.
2. Ask for a pairing code (made with `POST /admin/pair` on the Worker; good for one hour, one use).
3. On the PC:
   ```bash
   curl -fsSL https://usecloak.org/brain/install.sh | sudo bash -s -- ABCD-EFGH-JKLM
   ```
4. Open https://brain.usecloak.org/admin and sign in with your Cloak account.
5. Set `BRAIN_URL` on the Worker (`blinks-api/wrangler.jsonc` vars) and redeploy. From then on, turns go to the brain.

Updates are automatic: a systemd timer (`cloak-brain-update.timer`) checks usecloak.org every 30 minutes and reinstalls only when a file changed. A restart waits up to two minutes for replies in progress. To update by hand, run the same command without a code. Uninstall: `... | sudo bash -s -- --uninstall` (data in `/var/lib/cloak-brain` is kept).

Logs: `journalctl -u cloak-brain -f` and `journalctl -u cloudflared -f`, or the Log panel on /admin.

## Back it up

Files and memories exist only on this PC. Copy `/var/lib/cloak-brain` somewhere else every night (an external drive, or a cheap cloud backup).

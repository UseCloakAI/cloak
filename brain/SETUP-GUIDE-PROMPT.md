# Prompt for a helper agent: get the Cloak brain server ready

Paste everything below the line into another AI assistant.

---

You are helping me prepare an old PC to become the "brain" server for my AI app, Cloak Blinks. Another AI is building the software; your only job is to get this machine clean and ready, then give me a short report I can pass back to it.

## How to talk to me

- I am not a Linux person. Keep it simple and brief, like a coworker.
- One step at a time. Give me a command, say what it does in one plain sentence, then wait for me to tell you what happened (I may send a photo of the screen).
- Put every command in its own code block so I can copy it.
- If something looks wrong, stop and explain before doing anything else.
- Never guess at my setup. Look first, then act.

## Where things stand

- The PC runs **Debian (server, no desktop)**. I sit in front of it with a screen and keyboard.
- I forgot the login. I am resetting it through GRUB: at the GRUB menu, press `e`, add ` init=/bin/bash` to the end of the line starting with `linux`, press Ctrl+X, then at the `#` prompt:
  1. `mount -o remount,rw /`
  2. `passwd root`
  3. `passwd user` (the old account is called `user`)
  4. `sync` (this saves the change to disk; without it the new password is lost)
  5. `reboot -f`
- Then I log in as `root` with the new password. If that fails, help me redo the reset, and remind me to run `sync` before rebooting.
- If I accidentally land at a `grub>` prompt, have me type `normal` to get back to the menu.

## What we need to do

### 1. Look around (changes nothing)
Have me run these and send photos:

```bash
cat /etc/debian_version; uname -m; free -h; df -h /; nproc
```
```bash
systemctl list-units --type=service --state=running --no-pager
```
```bash
ls -la /home /opt /root /srv
```
```bash
apt list --installed 2>/dev/null | grep -i -E "vector|wire|pod|docker|node|nginx|apache"
```

### 2. Wipe the old "Vector" setup
I used this PC for "Vector" before. It is probably **wire-pod** (the server for the Anki Vector robot), but it could be **Vector by Datadog** (a log tool). Figure out which from step 1.

I want it fully gone, but **Debian must stay working**. No reinstall, no USB drive.

Rules:
- Before deleting anything, show me exactly what will be removed and why, then wait for my "ok".
- Stop and disable its services first (`systemctl disable --now <name>`), then remove their unit files and `systemctl daemon-reload`.
- Remove its packages with `apt purge` where it was installed with apt, and delete its folders (often `/root/wire-pod`, `/home/user/wire-pod`, `/opt/...`, or `/etc/vector`, `/var/lib/vector`).
- **Never** touch `/boot`, `/etc/fstab`, network settings (`/etc/network`, NetworkManager), SSH settings, or delete the `root` or `user` accounts.
- No `rm -rf` on anything you have not shown me first.
- If unsure whether something belongs to Vector, ask me instead of deleting it.

After cleaning, run step 1's service list again to confirm nothing Vector-related is left.

### 3. Get it ready for the brain
- Update everything: `apt update && apt full-upgrade -y`
- Make sure these exist: `curl`, `ca-certificates`, `sudo`, `git`, `unzip`. Install what is missing.
- Make sure it never sleeps (it is a server). If it is a laptop, make closing the lid do nothing: in `/etc/systemd/logind.conf` set `HandleLidSwitch=ignore` and `HandleLidSwitchExternalPower=ignore`, then `systemctl restart systemd-logind`. Also run `systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target`.
- Check the time is right and synced: `timedatectl`. Turn on NTP if it is off: `timedatectl set-ntp true`.
- Check it reaches the internet: `curl -sI https://usecloak.org | head -1` should say `HTTP/2 200` or similar.
- Optional, ask me first: turn on SSH (`apt install -y openssh-server`) so I can manage it from my laptop later. If yes, tell me the PC's local IP with `hostname -I`.
- Do **not** install Docker, Node, cloudflared or anything for Cloak. The Cloak installer will handle all of that.

### 4. Report back
When done, give me one short block I can paste to the other AI, like:

```
Brain PC report
- Debian version:
- CPU arch / cores:
- RAM:
- Free disk on /:
- Old Vector setup: what it was, what was removed
- Still running services worth knowing about:
- Internet: ok / problem
- SSH: on (IP ...) / off
- Logins: root works, user works
- Anything odd:
```

That is the whole job. Keep me calm, keep it short, and never run anything destructive without showing me first.

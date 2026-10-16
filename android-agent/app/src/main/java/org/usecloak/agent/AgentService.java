package org.usecloak.agent;

import android.app.ActivityManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * Always-on foreground service. One worker thread does everything in order:
 * batches bursts of texts per sender, asks Cloak, replies, and runs the RAM saver.
 */
public final class AgentService extends Service {
    static final String EXTRA_FROM = "from", EXTRA_BODY = "body", EXTRA_SUB = "sub";
    private static final String CHANNEL = "agent";
    private static final int NOTIF_ID = 1;

    /** The running instance, so receivers can hand texts over without another service start. */
    static volatile AgentService live;

    private ScheduledExecutorService exec;
    private final Map<String, Pending> pending = new HashMap<>();   // worker thread only
    private long lastSweep, nextPoll, lastRemote;
    private BroadcastReceiver screenOff;

    private static final class Pending {
        String from, name;
        int sub;
        boolean owner;
        final StringBuilder text = new StringBuilder();
        ScheduledFuture<?> job;
    }

    /** Starts or stops the service to match the settings. */
    static void sync(Context c) {
        Intent i = new Intent(c, AgentService.class);
        if (wanted(c)) c.startForegroundService(i);
        else c.stopService(i);
    }

    static boolean wanted(Context c) {
        return Prefs.enabled(c) || Prefs.ramSaver(c) || Remote.on(c);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Agent running", NotificationManager.IMPORTANCE_MIN));
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIF_ID, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIF_ID, notification());
        }
        exec = Executors.newSingleThreadScheduledExecutor();
        exec.scheduleWithFixedDelay(this::ramTick, 2, 2, TimeUnit.MINUTES);
        exec.scheduleWithFixedDelay(this::remoteTick, 3, 3, TimeUnit.SECONDS);
        exec.scheduleWithFixedDelay(() -> {
            if (Prefs.bool(this, Updater.AUTO, true)) {
                String r = Updater.check(this, true);
                if (!r.startsWith("Up to date")) Prefs.log(this, r);
            }
        }, 1, 360, TimeUnit.MINUTES);

        screenOff = new BroadcastReceiver() {
            @Override
            public void onReceive(Context c, Intent i) {
                exec.schedule(() -> {
                    if (Prefs.ramSaver(c) && !getSystemService(PowerManager.class).isInteractive()) sweep("screen off");
                }, 20, TimeUnit.SECONDS);
            }
        };
        registerReceiver(screenOff, new IntentFilter(Intent.ACTION_SCREEN_OFF));
        live = this;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (!wanted(this)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        getSystemService(NotificationManager.class).notify(NOTIF_ID, notification());
        if (intent != null && intent.hasExtra(EXTRA_FROM)) {
            String from = intent.getStringExtra(EXTRA_FROM);
            String body = intent.getStringExtra(EXTRA_BODY);
            enqueue(from, body, intent.getIntExtra(EXTRA_SUB, -1));
        }
        return START_STICKY;
    }

    void enqueue(String from, String body, int sub) {
        exec.execute(() -> incoming(from, body == null ? "" : body, sub));
    }

    @Override
    public void onDestroy() {
        live = null;
        if (screenOff != null) unregisterReceiver(screenOff);
        if (exec != null) exec.shutdownNow();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ── Texts ───────────────────────────────────────────────────────────────

    private void incoming(String from, String body, int sub) {
        if (!Prefs.enabled(this) || from == null || body.trim().isEmpty()) return;
        String key = Sms.key(from);
        boolean owner = Prefs.isOwner(this, from);
        String name = Sms.contactName(this, from);
        String who = name != null ? name : from;

        if (!owner) {
            if (!Sms.isPerson(from)) {
                Prefs.log(this, "skipped " + from + " (short code)");
                return;
            }
            String t = body.trim();
            if (t.equalsIgnoreCase("stop")) {
                Prefs.setMuted(this, key, true);
                Sms.send(this, from, "Okay, Cloak won't auto-reply here anymore. Text START to turn it back on.", sub);
                Prefs.log(this, who + " muted Cloak");
                return;
            }
            if (t.equalsIgnoreCase("start") && Prefs.muted(this, key)) {
                Prefs.setMuted(this, key, false);
                Sms.send(this, from, "Cloak's back on.", sub);
                return;
            }
            if (Prefs.muted(this, key)) return;
            if (Prefs.bool(this, Prefs.CONTACTS_ONLY, true) && name == null) {
                Prefs.log(this, "skipped " + from + " (not in contacts)");
                return;
            }
            if (Prefs.count(this, "s:" + key) >= Prefs.MAX_PER_SENDER_DAY) {
                Prefs.log(this, "skipped " + who + " (daily limit)");
                return;
            }
        }

        // People send texts in bursts — wait for them to finish, then answer once.
        Pending p = pending.get(key);
        if (p == null) pending.put(key, p = new Pending());
        if (p.text.length() > 0) p.text.append('\n');
        p.text.append(body.trim());
        p.from = from;
        p.name = who;
        p.sub = sub;
        p.owner = owner;
        if (p.job != null) p.job.cancel(false);
        int delay = owner ? 1 : Math.max(0, Prefs.num(this, Prefs.DELAY, 6));
        p.job = exec.schedule(() -> answer(key), delay, TimeUnit.SECONDS);
    }

    private void answer(String key) {
        Pending p = pending.remove(key);
        if (p == null || !Prefs.enabled(this)) return;
        String text = p.text.toString();
        Prefs.log(this, "← " + p.name + (p.owner ? " (owner)" : " (not owner — chat only)") + ": " + clip(text));
        try {
            String reply = Agent.reply(this, "sms:" + key, p.name, text, p.owner, true,
                    p.owner ? line -> Prefs.log(this, line) : null);
            if (reply.isEmpty()) return;
            Sms.send(this, p.from, reply, p.sub);
            Prefs.bump(this, "s:" + key);
            Prefs.bump(this, "replies");
            Prefs.log(this, "→ " + p.name + ": " + clip(reply));
        } catch (Exception e) {
            Prefs.log(this, "couldn't answer " + p.name + ": " + e.getMessage());
            if (p.owner) Sms.send(this, p.from, "Cloak couldn't reach its brain: " + e.getMessage(), p.sub);
        }
    }

    // ── Cloak app inbox ─────────────────────────────────────────────────────

    /** Polls every 3s for 2 min after activity, then every 15s. */
    private void remoteTick() {
        long now = System.currentTimeMillis();
        if (!Remote.on(this) || now < nextPoll) return;
        try {
            int n = Remote.poll(this);
            if (n > 0) lastRemote = System.currentTimeMillis();
        } catch (Exception e) {
            if (now - lastRemote > 60_000) lastRemote = 0;   // back off on errors
        }
        nextPoll = System.currentTimeMillis() + (System.currentTimeMillis() - lastRemote < 120_000 ? 0 : 12_000);
    }

    // ── RAM saver ───────────────────────────────────────────────────────────

    private void ramTick() {
        if (!Prefs.ramSaver(this)) return;
        ActivityManager am = getSystemService(ActivityManager.class);
        ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
        am.getMemoryInfo(mi);
        boolean low = mi.lowMemory || mi.availMem < mi.totalMem * 15 / 100;
        long every = Math.max(5, Prefs.num(this, Prefs.RAM_EVERY, 20)) * 60_000L;
        if (low) sweep("low memory");
        else if (System.currentTimeMillis() - lastSweep >= every) sweep(null);
    }

    private void sweep(String why) {
        lastSweep = System.currentTimeMillis();
        try {
            String r = Actions.freeRam(this);
            if (why != null) Prefs.log(this, "RAM saver (" + why + "): " + r);
        } catch (Exception e) {
            Prefs.log(this, "RAM saver failed: " + e.getMessage());
        }
    }

    // ── Notification ────────────────────────────────────────────────────────

    private Notification notification() {
        String text = Prefs.enabled(this) ? "Replying to texts" : "Auto-reply off";
        if (Prefs.ramSaver(this)) text += " · RAM saver on";
        if (Remote.on(this)) text += " · app inbox on";
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("Cloak Agent")
                .setContentText(text)
                .setContentIntent(open)
                .setOngoing(true)
                .build();
    }

    private static String clip(String s) {
        s = s.replace('\n', ' ');
        return s.length() > 80 ? s.substring(0, 80) + "…" : s;
    }
}

package org.usecloak.agent;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.os.Build;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Self-update from the rolling `agent-latest` GitHub release (CI publishes it, signed with the
 * fixed key). The first update asks you to confirm; after that this app is its own installer of
 * record, so Android 12+ installs updates silently.
 */
final class Updater {
    private static final String BASE = "https://github.com/UseCloakAI/cloak/releases/download/agent-latest/";
    static final String AUTO = "auto_update";
    private static final String CHANNEL = "updates";

    private Updater() {}

    static boolean canInstall(Context c) { return c.getPackageManager().canRequestPackageInstalls(); }

    static long current(Context c) {
        try {
            return c.getPackageManager().getPackageInfo(c.getPackageName(), 0).getLongVersionCode();
        } catch (PackageManager.NameNotFoundException e) {
            return 0;
        }
    }

    /** Blocking. Returns a short status line. */
    static String check(Context c, boolean install) {
        try {
            JSONObject v = new JSONObject(new String(get(BASE + "version.json"), "UTF-8"));
            long latest = v.getLong("versionCode");
            String name = v.optString("versionName", String.valueOf(latest));
            if (latest <= current(c)) return "Up to date (v" + name + ")";
            if (!install) return "Update available: v" + name;
            if (!canInstall(c)) return "Update v" + name + " ready — allow \"Install unknown apps\" for Cloak Agent";
            File apk = new File(c.getCacheDir(), "update.apk");
            try (OutputStream o = new FileOutputStream(apk)) {
                o.write(get(BASE + "cloak-agent.apk"));
            }
            installApk(c, apk);
            Prefs.log(c, "installing update v" + name);
            return "Installing v" + name + "…";
        } catch (Exception e) {
            if ("HTTP 404".equals(e.getMessage())) return "No published update yet — up to date";
            return "Update check failed: " + e.getMessage();
        }
    }

    private static void installApk(Context c, File apk) throws Exception {
        PackageInstaller pi = c.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams p = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        p.setAppPackageName(c.getPackageName());
        if (Build.VERSION.SDK_INT >= 31) p.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
        int id = pi.createSession(p);
        try (PackageInstaller.Session s = pi.openSession(id)) {
            try (OutputStream out = s.openWrite("base.apk", 0, apk.length()); InputStream in = new FileInputStream(apk)) {
                byte[] buf = new byte[65536];
                for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
                s.fsync(out);
            }
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            PendingIntent done = PendingIntent.getBroadcast(c, id, new Intent(c, Result.class), flags);
            s.commit(done.getIntentSender());
        }
    }

    /** Install result. If Android wants a confirm tap, show it (or a notification to tap). */
    public static final class Result extends BroadcastReceiver {
        @Override
        public void onReceive(Context c, Intent i) {
            int status = i.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
            if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                Intent confirm = i.getParcelableExtra(Intent.EXTRA_INTENT);
                if (confirm == null) return;
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                Context starter = PhoneControl.instance != null ? PhoneControl.instance : c;
                try {
                    starter.startActivity(confirm);
                } catch (Exception ignored) {
                }
                notifyTap(c, confirm);
            } else if (status != PackageInstaller.STATUS_SUCCESS) {
                Prefs.log(c, "update failed: " + i.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE));
            }
        }
    }

    private static void notifyTap(Context c, Intent confirm) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Updates", NotificationManager.IMPORTANCE_DEFAULT));
        PendingIntent pi = PendingIntent.getActivity(c, 7, confirm, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        nm.notify(2, new Notification.Builder(c, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("Cloak Agent update ready")
                .setContentText("Tap to install")
                .setContentIntent(pi)
                .setAutoCancel(true)
                .build());
    }

    private static byte[] get(String url) throws Exception {
        HttpURLConnection h = (HttpURLConnection) new URL(url).openConnection();
        try {
            h.setConnectTimeout(15_000);
            h.setReadTimeout(60_000);
            h.setInstanceFollowRedirects(true);
            h.setRequestProperty("User-Agent", "CloakAgent");
            int code = h.getResponseCode();
            if (code != 200) throw new Exception("HTTP " + code);
            try (InputStream in = h.getInputStream()) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[65536];
                for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
                return out.toByteArray();
            }
        } finally {
            h.disconnect();
        }
    }
}

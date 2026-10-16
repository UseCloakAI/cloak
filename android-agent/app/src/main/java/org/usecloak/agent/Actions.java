package org.usecloak.agent;

import android.accessibilityservice.AccessibilityService;
import android.app.ActivityManager;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.PowerManager;
import android.os.SystemClock;
import android.provider.Settings;
import android.provider.Telephony;
import android.telecom.TelecomManager;
import android.view.accessibility.AccessibilityNodeInfo;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/** Everything the agent can do to the phone. Blocking; call off the main thread. */
final class Actions {
    private static final long MB = 1024 * 1024;

    private Actions() {}

    static String run(Context c, String a, String v) {
        try {
            switch (a) {
                case "open": return open(c, v);
                case "screen": return need() != null ? need() : PhoneControl.instance.dump(2000);
                case "tap": return need() != null ? need() : PhoneControl.instance.tap(v);
                case "type": return need() != null ? need() : PhoneControl.instance.type(v);
                case "tap_xy": return need() != null ? need() : PhoneControl.instance.tapXY(v);
                case "enter": return need() != null ? need() : PhoneControl.instance.enter();
                case "look": return need() != null ? need() : PhoneControl.instance.look(v);
                case "scroll":
                    if (need() != null) return need();
                    return PhoneControl.instance.scroll(!"up".equalsIgnoreCase(v)) ? "scrolled" : "nothing to scroll";
                case "back": return global(AccessibilityService.GLOBAL_ACTION_BACK, "went back");
                case "home": return global(AccessibilityService.GLOBAL_ACTION_HOME, "went home");
                case "recents": return global(AccessibilityService.GLOBAL_ACTION_RECENTS, "opened recents");
                case "close_all": return closeAll(c);
                case "free_ram": return freeRam(c);
                case "sleep": return sleep(c, v);
                case "apps": return apps(c, v);
                case "status": return status(c);
                case "wait":
                    int s = 2;
                    try { s = Integer.parseInt(v.replaceAll("[^0-9]", "")); } catch (Exception ignored) {}
                    pause(Math.max(1, Math.min(10, s)) * 1000L);
                    return "waited";
                default: return "unknown action";
            }
        } catch (Exception e) {
            return "failed: " + e.getMessage();
        }
    }

    // ── Apps ────────────────────────────────────────────────────────────────

    static final class App {
        final String label, pkg;
        App(String label, String pkg) { this.label = label; this.pkg = pkg; }
    }

    private static List<App> apps;
    private static long appsAt;

    static synchronized List<App> apps(Context c) {
        if (apps != null && SystemClock.elapsedRealtime() - appsAt < 600_000) return apps;
        PackageManager pm = c.getPackageManager();
        Intent launcher = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        List<App> out = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (ResolveInfo r : pm.queryIntentActivities(launcher, 0)) {
            String p = r.activityInfo.packageName;
            if (seen.add(p)) out.add(new App(r.loadLabel(pm).toString(), p));
        }
        apps = out;
        appsAt = SystemClock.elapsedRealtime();
        return out;
    }

    static App find(Context c, String name) {
        String q = name.trim().toLowerCase(Locale.ROOT);
        if (q.isEmpty()) return null;
        App starts = null, contains = null;
        for (App a : apps(c)) {
            String l = a.label.toLowerCase(Locale.ROOT);
            if (l.equals(q) || a.pkg.equals(q)) return a;
            if (starts == null && l.startsWith(q)) starts = a;
            if (contains == null && (l.contains(q) || a.pkg.contains(q))) contains = a;
        }
        return starts != null ? starts : contains;
    }

    static String label(Context c, CharSequence pkg) {
        if (pkg == null) return "?";
        try {
            PackageManager pm = c.getPackageManager();
            return pm.getApplicationLabel(pm.getApplicationInfo(pkg.toString(), 0)).toString();
        } catch (Exception e) {
            return pkg.toString();
        }
    }

    private static String open(Context c, String v) {
        App a = find(c, v);
        if (a == null) return "no app called \"" + v + "\"";
        Intent i = c.getPackageManager().getLaunchIntentForPackage(a.pkg);
        if (i == null) return a.label + " can't be opened";
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
        // Android blocks background activity starts unless an accessibility service is bound.
        Context starter = PhoneControl.instance != null ? PhoneControl.instance : c;
        starter.startActivity(i);
        pause(1500);
        String r = "opened " + a.label;
        if (PhoneControl.instance == null) r += " (if nothing showed up, turn on Phone control)";
        if (locked(c)) r += " — the phone is locked, so it's behind the lock screen";
        return r;
    }

    private static String apps(Context c, String q) {
        String needle = q.trim().toLowerCase(Locale.ROOT);
        StringBuilder sb = new StringBuilder();
        int n = 0;
        for (App a : apps(c)) {
            if (!needle.isEmpty() && !a.label.toLowerCase(Locale.ROOT).contains(needle)) continue;
            if (n++ >= 60) break;
            sb.append(n == 1 ? "" : ", ").append(a.label);
        }
        return n == 0 ? "no matching apps" : sb.toString();
    }

    // ── RAM ─────────────────────────────────────────────────────────────────

    /** Apps the RAM saver never touches. */
    private static Set<String> protectedPkgs(Context c) {
        Set<String> s = new HashSet<>(Arrays.asList(c.getPackageName(), "android", "com.android.systemui",
                "com.android.phone", "com.android.providers.telephony", "com.google.android.gms",
                "com.google.android.gsf", "com.google.android.ext.services", "com.android.settings"));
        PackageManager pm = c.getPackageManager();
        ResolveInfo home = pm.resolveActivity(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME),
                PackageManager.MATCH_DEFAULT_ONLY);
        if (home != null) s.add(home.activityInfo.packageName);
        String sms = Telephony.Sms.getDefaultSmsPackage(c);
        if (sms != null) s.add(sms);
        String ime = Settings.Secure.getString(c.getContentResolver(), Settings.Secure.DEFAULT_INPUT_METHOD);
        if (ime != null) s.add(ime.split("/")[0]);
        TelecomManager tm = c.getSystemService(TelecomManager.class);
        if (tm != null && tm.getDefaultDialerPackage() != null) s.add(tm.getDefaultDialerPackage());
        if (!PhoneControl.foreground.isEmpty()) s.add(PhoneControl.foreground);
        for (String k : Prefs.list(c, Prefs.KEEP)) {
            App a = find(c, k);
            s.add(a != null ? a.pkg : k);
        }
        return s;
    }

    /**
     * Kills cached background processes (KILL_BACKGROUND_PROCESSES — no root). Anything with a
     * foreground service, like music that's playing, is left alone by the system.
     */
    static String freeRam(Context c) {
        ActivityManager am = c.getSystemService(ActivityManager.class);
        PackageManager pm = c.getPackageManager();
        long before = avail(am);
        Set<String> keep = protectedPkgs(c);
        Set<String> launchable = new HashSet<>();
        for (App a : apps(c)) launchable.add(a.pkg);
        int n = 0;
        for (ApplicationInfo ai : pm.getInstalledApplications(0)) {
            if (keep.contains(ai.packageName)) continue;
            if ((ai.flags & ApplicationInfo.FLAG_PERSISTENT) != 0) continue;
            boolean core = (ai.flags & ApplicationInfo.FLAG_SYSTEM) != 0
                    && (ai.flags & ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) == 0;
            if (core && !launchable.contains(ai.packageName)) continue;
            am.killBackgroundProcesses(ai.packageName);
            n++;
        }
        pause(1200);
        long after = avail(am);
        return String.format(Locale.US, "swept %d background apps — free RAM %d → %d MB (+%d)",
                n, before / MB, after / MB, Math.max(0, after - before) / MB);
    }

    static long avail(ActivityManager am) {
        ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
        am.getMemoryInfo(mi);
        return mi.availMem;
    }

    /** Recents → "Clear all", then a background sweep. Falls back to just the sweep. */
    static String closeAll(Context c) {
        PhoneControl pc = PhoneControl.instance;
        if (pc == null || locked(c)) return freeRam(c) + (pc == null ? " (Phone control is off, so recents weren't cleared)" : "");
        pc.performGlobalAction(AccessibilityService.GLOBAL_ACTION_RECENTS);
        pause(1000);
        boolean cleared = false;
        for (int i = 0; i < 10 && !cleared; i++) {
            AccessibilityNodeInfo n = pc.findExact("Clear all", "Close all", "Dismiss all", "Clear all apps");
            if (n != null) {
                cleared = pc.click(n);
                break;
            }
            if (!pc.scroll(i < 4)) break;
            pause(350);
        }
        pause(600);
        pc.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME);
        return (cleared ? "cleared recent apps; " : "no Clear all button (recents may be empty); ") + freeRam(c);
    }

    /**
     * "Deep sleep": App info → Force stop, driven through accessibility. Stops services and alarms
     * too, until the app is opened again. English UI only (matches the button text).
     */
    static String sleep(Context c, String v) {
        PhoneControl pc = PhoneControl.instance;
        if (pc == null) return "Phone control is off — turn on Cloak Agent in Accessibility settings";
        if (locked(c)) return "the phone is locked — unlock it to put apps to sleep";
        List<String> names = v.isEmpty() ? Prefs.list(c, Prefs.SLEEP) : Arrays.asList(v.split(","));
        if (names.isEmpty()) return "the sleep list is empty — add apps in Cloak Agent";
        Set<String> keep = protectedPkgs(c);
        StringBuilder out = new StringBuilder();
        for (String name : names) {
            App a = find(c, name);
            String r;
            if (a == null) r = name.trim() + ": not installed";
            else if (keep.contains(a.pkg)) r = a.label + ": protected, skipped";
            else r = a.label + ": " + forceStop(c, pc, a.pkg);
            out.append(out.length() == 0 ? "" : "; ").append(r);
        }
        pc.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME);
        return out.toString();
    }

    private static String forceStop(Context c, PhoneControl pc, String pkg) {
        Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + pkg))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK | Intent.FLAG_ACTIVITY_NO_HISTORY);
        pc.startActivity(i);
        pause(1500);
        AccessibilityNodeInfo btn = pc.findExact("Force stop", "FORCE STOP");
        if (btn == null) {
            pc.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK);
            return "couldn't find Force stop";
        }
        if (!PhoneControl.enabled(btn)) {
            pc.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK);
            return "already asleep";
        }
        pc.click(btn);
        pause(800);
        AccessibilityNodeInfo ok = pc.findExact("OK", "Force stop", "FORCE STOP");
        boolean done = ok != null && pc.click(ok);
        pause(500);
        pc.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK);
        pause(300);
        return done ? "asleep" : "couldn't confirm";
    }

    // ── Status ──────────────────────────────────────────────────────────────

    private static String status(Context c) {
        BatteryManager bm = c.getSystemService(BatteryManager.class);
        ActivityManager am = c.getSystemService(ActivityManager.class);
        ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
        am.getMemoryInfo(mi);
        PowerManager pm = c.getSystemService(PowerManager.class);
        String screen = !pm.isInteractive() ? "off" : locked(c) ? "on, locked" : "on, unlocked";
        String fg = PhoneControl.foreground.isEmpty() ? "unknown" : label(c, PhoneControl.foreground);
        return String.format(Locale.US, "battery %d%%%s; RAM free %d of %d MB%s; screen %s; current app %s; phone control %s",
                bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY), bm.isCharging() ? " (charging)" : "",
                mi.availMem / MB, mi.totalMem / MB, mi.lowMemory ? " (low)" : "", screen, fg,
                PhoneControl.instance != null ? "on" : "off");
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    private static String need() {
        return PhoneControl.instance == null ? "Phone control is off — turn on Cloak Agent in Accessibility settings" : null;
    }

    private static String global(int action, String ok) {
        if (need() != null) return need();
        boolean r = PhoneControl.instance.performGlobalAction(action);
        pause(700);
        return r ? ok : "didn't work";
    }

    static boolean locked(Context c) {
        PowerManager pm = c.getSystemService(PowerManager.class);
        KeyguardManager km = c.getSystemService(KeyguardManager.class);
        return !pm.isInteractive() || km.isKeyguardLocked();
    }

    static void pause(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}

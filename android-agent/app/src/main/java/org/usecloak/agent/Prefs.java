package org.usecloak.agent;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/** Settings, per-conversation history, counters and the activity log. One SharedPreferences file. */
final class Prefs {
    static final String ENABLED = "enabled";
    static final String PERSONA = "persona";          // "cloak" | "me"
    static final String NAME = "name";
    static final String EXTRA = "extra";
    static final String MODEL = "model";
    static final String DELAY = "delay";              // seconds to wait for a burst of texts
    static final String CONTACTS_ONLY = "contacts_only";
    static final String OWNERS = "owners";
    static final String RAM = "ram";
    static final String RAM_EVERY = "ram_every";      // minutes
    static final String KEEP = "keep";
    static final String SLEEP = "sleep_list";

    static final int MAX_PER_SENDER_DAY = 40;
    private static final int LOG_MAX = 40;

    private Prefs() {}

    static SharedPreferences sp(Context c) {
        return c.getApplicationContext().getSharedPreferences("agent", Context.MODE_PRIVATE);
    }

    static String str(Context c, String k, String def) { return sp(c).getString(k, def); }
    static boolean bool(Context c, String k, boolean def) { return sp(c).getBoolean(k, def); }
    static int num(Context c, String k, int def) { return sp(c).getInt(k, def); }

    static void put(Context c, String k, Object v) {
        SharedPreferences.Editor e = sp(c).edit();
        if (v instanceof Boolean) e.putBoolean(k, (Boolean) v);
        else if (v instanceof Integer) e.putInt(k, (Integer) v);
        else e.putString(k, String.valueOf(v));
        e.apply();
    }

    static boolean enabled(Context c) { return bool(c, ENABLED, false); }
    static boolean ramSaver(Context c) { return bool(c, RAM, true); }

    /** Comma / newline separated list setting. */
    static List<String> list(Context c, String k) {
        List<String> out = new ArrayList<>();
        for (String s : str(c, k, "").split("[,\\n]")) {
            s = s.trim();
            if (!s.isEmpty()) out.add(s);
        }
        return out;
    }

    static boolean isOwner(Context c, String number) {
        String k = Sms.key(number);
        if (k.isEmpty()) return false;
        for (String o : list(c, OWNERS)) if (Sms.key(o).equals(k)) return true;
        return false;
    }

    // ── History (role/content pairs, capped) ────────────────────────────────

    static JSONArray history(Context c, String convo) {
        try {
            return new JSONArray(str(c, "h:" + convo, "[]"));
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    static void saveHistory(Context c, String convo, JSONArray all, int max) {
        JSONArray keep = new JSONArray();
        for (int i = Math.max(0, all.length() - max); i < all.length(); i++) keep.put(all.opt(i));
        put(c, "h:" + convo, keep.toString());
    }

    static void clearHistory(Context c, String convo) { sp(c).edit().remove("h:" + convo).apply(); }

    // ── Mutes + daily counters ──────────────────────────────────────────────

    static boolean muted(Context c, String who) { return bool(c, "mute:" + who, false); }
    static void setMuted(Context c, String who, boolean m) { put(c, "mute:" + who, m); }

    private static String today() { return new SimpleDateFormat("yyyyMMdd", Locale.US).format(new Date()); }

    static synchronized int count(Context c, String k) {
        String v = str(c, "n:" + k, "");
        return v.startsWith(today() + ":") ? Integer.parseInt(v.substring(9)) : 0;
    }

    static synchronized void bump(Context c, String k) { put(c, "n:" + k, today() + ":" + (count(c, k) + 1)); }

    // ── Activity log ────────────────────────────────────────────────────────

    static synchronized void log(Context c, String line) {
        JSONArray a;
        try {
            a = new JSONArray(str(c, "log", "[]"));
        } catch (Exception e) {
            a = new JSONArray();
        }
        a.put(new SimpleDateFormat("HH:mm", Locale.US).format(new Date()) + "  " + line);
        JSONArray keep = new JSONArray();
        for (int i = Math.max(0, a.length() - LOG_MAX); i < a.length(); i++) keep.put(a.opt(i));
        put(c, "log", keep.toString());
    }

    static synchronized List<String> logs(Context c) {
        List<String> out = new ArrayList<>();
        try {
            JSONArray a = new JSONArray(str(c, "log", "[]"));
            for (int i = a.length() - 1; i >= 0; i--) out.add(a.getString(i));
        } catch (Exception ignored) {
        }
        return out;
    }
}

package org.usecloak.agent;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/**
 * The Cloak app inbox: people chat with this phone from Settings → Agent in the web app.
 * The phone signs in as an admin Cloak account (Supabase REST, no SDK), polls pending
 * agent_messages, answers, and posts the reply back. Admin senders get phone control;
 * everyone else gets chat only — and only when the admin toggle (agent_config) allows them.
 */
final class Remote {
    // Same publishable project URL + anon key as cloak.js (RLS does the protecting).
    private static final String SB_URL = "https://kdawsqrrmwirilyhcolk.supabase.co";
    private static final String SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtkYXdzcXJybXdpcmlseWhjb2xrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5NjUxNjAsImV4cCI6MjA4OTU0MTE2MH0.cMN9V51J3042DrdaDmL7-ro-AMaw-IU47wQLnW2NMBE";

    static final String ON = "remote";
    private static final String ACCESS = "sb_access", REFRESH = "sb_refresh", EXP = "sb_exp", UID = "sb_uid", EMAIL = "sb_email";

    private Remote() {}

    static boolean signedIn(Context c) { return !Prefs.str(c, REFRESH, "").isEmpty(); }
    static boolean on(Context c) { return Prefs.bool(c, ON, false) && signedIn(c); }
    static String email(Context c) { return Prefs.str(c, EMAIL, ""); }

    // ── Auth ────────────────────────────────────────────────────────────────

    /** Signs in and checks the account is an admin. The password is never stored. */
    static void signIn(Context c, String email, String password) throws Exception {
        JSONObject r = call("POST", "/auth/v1/token?grant_type=password", null,
                new JSONObject().put("email", email).put("password", password).toString(), null);
        save(c, r);
        Prefs.put(c, EMAIL, email);
        JSONArray me = new JSONArray(rest(c, "GET", "profiles?select=is_admin&id=eq." + Prefs.str(c, UID, ""), null, null));
        if (me.length() == 0 || !me.getJSONObject(0).optBoolean("is_admin")) {
            signOut(c);
            throw new Exception("That account isn't an admin. The phone needs an admin account.");
        }
    }

    static void signOut(Context c) {
        Prefs.sp(c).edit().remove(ACCESS).remove(REFRESH).remove(EXP).remove(UID).apply();
    }

    private static void save(Context c, JSONObject r) {
        Prefs.sp(c).edit()
                .putString(ACCESS, r.optString("access_token"))
                .putString(REFRESH, r.optString("refresh_token"))
                .putLong(EXP, System.currentTimeMillis() + r.optLong("expires_in", 3600) * 1000)
                .putString(UID, r.optJSONObject("user") != null ? r.optJSONObject("user").optString("id") : "")
                .apply();
    }

    private static String token(Context c) throws Exception {
        if (System.currentTimeMillis() < Prefs.sp(c).getLong(EXP, 0) - 60_000) return Prefs.str(c, ACCESS, "");
        try {
            save(c, call("POST", "/auth/v1/token?grant_type=refresh_token", null,
                    new JSONObject().put("refresh_token", Prefs.str(c, REFRESH, "")).toString(), null));
        } catch (HttpError e) {
            if (e.code == 400 || e.code == 401) {
                signOut(c);
                Prefs.log(c, "Cloak app inbox signed out — sign in again");
            }
            throw e;
        }
        return Prefs.str(c, ACCESS, "");
    }

    // ── Inbox ───────────────────────────────────────────────────────────────

    /** Answers up to 5 pending messages. Returns how many it handled. Worker thread only. */
    static int poll(Context c) throws Exception {
        if (!on(c)) return 0;
        JSONArray rows = new JSONArray(rest(c, "GET",
                "agent_messages?select=id,user_id,content&role=eq.user&status=eq.pending&order=id.asc&limit=5", null, null));
        if (rows.length() == 0) return 0;

        JSONArray cfg = new JSONArray(rest(c, "GET", "agent_config?select=admins_only&id=eq.1", null, null));
        boolean adminsOnly = cfg.length() == 0 || cfg.getJSONObject(0).optBoolean("admins_only", true);

        for (int i = 0; i < rows.length(); i++) {
            JSONObject m = rows.getJSONObject(i);
            long id = m.getLong("id");
            String uid = m.getString("user_id");
            JSONArray p = new JSONArray(rest(c, "GET",
                    "profiles?select=display_name,is_admin&id=eq." + enc(uid), null, null));
            JSONObject prof = p.length() > 0 ? p.getJSONObject(0) : new JSONObject();
            boolean admin = prof.optBoolean("is_admin");
            String name = prof.optString("display_name", "a Cloak user");
            if (name.isEmpty() || "null".equals(name)) name = "a Cloak user";

            // RLS already blocks these inserts; this is the second lock.
            if (adminsOnly && !admin) {
                answer(c, uid, id, "The Cloak agent is admin-only right now.", "error");
                continue;
            }
            String text = m.getString("content");
            Prefs.log(c, "← app " + name + (admin ? " (admin)" : "") + ": " + clip(text));
            try {
                String out = Agent.reply(c, "app:" + uid, name, text, admin, false,
                        admin ? line -> Prefs.log(c, line) : null);
                answer(c, uid, id, out.isEmpty() ? "(no reply)" : out, "done");
                Prefs.log(c, "→ app " + name + ": " + clip(out));
            } catch (Exception e) {
                answer(c, uid, id, "Cloak couldn't reach its brain: " + e.getMessage(), "error");
            }
        }
        return rows.length();
    }

    private static void answer(Context c, String uid, long id, String text, String status) throws Exception {
        if (text.length() > 4000) text = text.substring(0, 3999) + "…";
        rest(c, "POST", "agent_messages", new JSONObject()
                .put("user_id", uid).put("role", "agent").put("content", text)
                .put("reply_to", id).put("status", "done").toString(), "return=minimal");
        rest(c, "PATCH", "agent_messages?id=eq." + id,
                new JSONObject().put("status", status).toString(), "return=minimal");
    }

    // ── HTTP ────────────────────────────────────────────────────────────────

    static final class HttpError extends Exception {
        final int code;
        HttpError(int code, String msg) { super(msg); this.code = code; }
    }

    private static String rest(Context c, String method, String path, String body, String prefer) throws Exception {
        return raw(method, SB_URL + "/rest/v1/" + path, token(c), body, prefer);
    }

    private static JSONObject call(String method, String path, String bearer, String body, String prefer) throws Exception {
        String r = raw(method, SB_URL + path, bearer, body, prefer);
        return new JSONObject(r.isEmpty() ? "{}" : r);
    }

    private static String raw(String method, String url, String bearer, String body, String prefer) throws Exception {
        HttpURLConnection h = (HttpURLConnection) new URL(url).openConnection();
        try {
            h.setConnectTimeout(15_000);
            h.setReadTimeout(20_000);
            h.setRequestMethod(method);   // Android's (OkHttp-backed) impl allows PATCH
            h.setRequestProperty("apikey", SB_KEY);
            h.setRequestProperty("Authorization", "Bearer " + (bearer != null ? bearer : SB_KEY));
            h.setRequestProperty("Content-Type", "application/json");
            if (prefer != null) h.setRequestProperty("Prefer", prefer);
            if (body != null) {
                h.setDoOutput(true);
                try (OutputStream o = h.getOutputStream()) {
                    o.write(body.getBytes(StandardCharsets.UTF_8));
                }
            }
            int code = h.getResponseCode();
            String text = read(code < 400 ? h.getInputStream() : h.getErrorStream());
            if (code >= 400) {
                String msg = "HTTP " + code;
                try {
                    JSONObject e = new JSONObject(text);
                    msg = e.optString("error_description", e.optString("message", e.optString("msg", msg)));
                } catch (Exception ignored) {
                }
                throw new HttpError(code, msg);
            }
            return text;
        } finally {
            h.disconnect();
        }
    }

    private static String read(InputStream in) throws Exception {
        if (in == null) return "";
        try (InputStream s = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            for (int n; (n = s.read(buf)) > 0; ) out.write(buf, 0, n);
            return out.toString("UTF-8");
        }
    }

    private static String enc(String s) throws Exception { return URLEncoder.encode(s, "UTF-8"); }

    private static String clip(String s) {
        s = s.replace('\n', ' ');
        return s.length() > 80 ? s.substring(0, 80) + "…" : s;
    }
}

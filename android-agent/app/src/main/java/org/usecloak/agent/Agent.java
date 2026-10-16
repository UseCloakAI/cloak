package org.usecloak.agent;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The brain: builds the prompt, calls Cloak, and — for the owner only — runs phone
 * actions the model asks for with <do a="…" v="…"/> tags, feeding results back.
 * Tags in a reply to anyone else are stripped, never executed.
 */
final class Agent {
    interface Steps { void step(String line); }

    private static final Pattern DO = Pattern.compile("<do\\s+a=\"([a-z_]+)\"(?:\\s+v=\"([^\"]*)\")?\\s*/?>(?:\\s*</do>)?");
    private static final int HISTORY = 20;
    private static final int ACTION_ROUNDS = 6;

    private static final String TOOLS =
            "To act on the phone, reply with action tags only (one per line, max 5), e.g.\n"
            + "<do a=\"open\" v=\"Spotify\"/>  open an app\n"
            + "<do a=\"screen\"/>  read what's on screen\n"
            + "<do a=\"tap\" v=\"visible text\"/>  tap a button or label\n"
            + "<do a=\"type\" v=\"text\"/>  type into the focused field\n"
            + "<do a=\"scroll\" v=\"down\"/>  or up\n"
            + "<do a=\"back\"/>  <do a=\"home\"/>  <do a=\"recents\"/>\n"
            + "<do a=\"close_all\"/>  clear recent apps\n"
            + "<do a=\"free_ram\"/>  stop background apps to free memory\n"
            + "<do a=\"sleep\" v=\"app name\"/>  force-stop an app (empty v = the owner's sleep list)\n"
            + "<do a=\"apps\" v=\"search\"/>  find installed apps\n"
            + "<do a=\"status\"/>  battery, memory, screen, current app\n"
            + "<do a=\"wait\" v=\"2\"/>  let the screen settle (seconds)\n"
            + "You get the results back, then act again or answer. Read the screen before tapping. "
            + "When done, answer in plain text with no tags. Only act when asked. Never pay, buy, delete, "
            + "post, or send messages unless the owner explicitly said to.\n";

    private Agent() {}

    static String reply(Context c, String convo, String who, String text, boolean owner, boolean sms, Steps steps)
            throws Exception {
        JSONArray msgs = Prefs.history(c, convo);
        msgs.put(msg("user", text));
        String system = system(c, who, owner, sms);
        String model = Prefs.str(c, Prefs.MODEL, "pneuma");
        String effort = owner ? "medium" : "low";
        int maxTokens = sms ? 700 : 1500;

        String out = null;
        for (int round = 0; out == null; round++) {
            String raw = CloakApi.chat(model, system, msgs, effort, maxTokens);
            List<String[]> acts = owner && round < ACTION_ROUNDS ? parse(raw) : new ArrayList<>();
            if (acts.isEmpty()) {
                out = clean(raw, sms);
                break;
            }
            msgs.put(msg("assistant", raw));
            StringBuilder res = new StringBuilder("[phone] results:");
            for (String[] a : acts) {
                String r = Actions.run(c, a[0], a[1]);
                String shown = a[0] + (a[1].isEmpty() ? "" : " " + a[1]);
                if (steps != null) steps.step("⚙ " + shown + " → " + firstLine(r));
                res.append("\n- ").append(shown).append(": ").append(r);
            }
            if (round == ACTION_ROUNDS - 1) res.append("\nNo more actions — answer now in plain text.");
            msgs.put(msg("user", res.toString()));
        }

        // Keep only the clean exchange in memory, not the tool chatter.
        JSONArray saved = Prefs.history(c, convo);
        saved.put(msg("user", text));
        if (!out.isEmpty()) saved.put(msg("assistant", out));
        Prefs.saveHistory(c, convo, saved, HISTORY);
        return out;
    }

    private static String system(Context c, String who, boolean owner, boolean sms) {
        String me = Prefs.str(c, Prefs.NAME, "").trim();
        String ownerName = me.isEmpty() ? "the owner" : me;
        String now = new SimpleDateFormat("EEE MMM d yyyy, h:mm a", Locale.US).format(new Date());
        StringBuilder s = new StringBuilder();

        boolean console = "you".equals(who);
        if (sms) {
            s.append("You're Cloak Agent, replying over SMS from an Android phone. Write like a text: plain text, ")
             .append("no markdown, usually one to three short sentences, never over 600 characters.\n");
        } else if (console) {
            s.append("You're Cloak Agent, running on ").append(ownerName).append("'s Android phone, talking in its console.\n");
        } else {
            s.append("You're Cloak Agent, running on ").append(ownerName).append("'s Android phone, chatting with ")
             .append("someone through the Cloak app. Keep replies short and plain.\n");
        }
        s.append("Now: ").append(now).append(".\n");

        if (owner) {
            s.append("You're talking with ")
             .append(console ? ownerName + ", the phone's owner" : sms ? ownerName + ", the phone's owner, texting in from their own number" : who + ", a Cloak admin")
             .append(". You can operate this phone.\n")
             .append(TOOLS);
        } else {
            if (sms && "me".equals(Prefs.str(c, Prefs.PERSONA, "cloak"))) {
                s.append("You're answering texts for ").append(ownerName).append(" while they're away. ")
                 .append("Say you're Cloak, ").append(ownerName).append("'s AI assistant, early in a conversation — ")
                 .append("never pretend to be ").append(ownerName).append(". Don't agree to plans, money or anything ")
                 .append("binding for them; say you'll pass it on. Never share their location, schedule, contacts ")
                 .append("or other private details.\n");
            } else {
                s.append(sms ? "People text this number to talk to Cloak directly. You are Cloak.\n" : "You are Cloak.\n");
            }
            s.append("You're talking with ").append(who).append(". You can't operate this phone for them or share ")
             .append("anything about it or its owner.\n");
        }

        String extra = Prefs.str(c, Prefs.EXTRA, "").trim();
        if (!extra.isEmpty()) s.append("\nOwner's instructions:\n").append(extra).append('\n');
        return s.toString();
    }

    private static List<String[]> parse(String raw) {
        List<String[]> out = new ArrayList<>();
        Matcher m = DO.matcher(raw);
        while (m.find() && out.size() < 5) {
            String v = m.group(2) == null ? "" : m.group(2)
                    .replace("&quot;", "\"").replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&");
            out.add(new String[]{m.group(1), v.trim()});
        }
        return out;
    }

    static String clean(String raw, boolean sms) {
        String s = raw.replaceAll("(?s)<think>.*?</think>", "");
        s = DO.matcher(s).replaceAll("");
        s = s.replaceAll("(?m)^#{1,6}\\s*", "").replace("**", "").replace("__", "").replace("`", "");
        s = s.replaceAll("\\n{3,}", "\n\n").trim();
        if (sms && s.length() > 700) s = s.substring(0, 697).trim() + "…";
        return s;
    }

    private static String firstLine(String s) {
        int i = s.indexOf('\n');
        s = i < 0 ? s : s.substring(0, i);
        return s.length() > 90 ? s.substring(0, 90) + "…" : s;
    }

    private static JSONObject msg(String role, String content) {
        try {
            return new JSONObject().put("role", role).put("content", content);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}

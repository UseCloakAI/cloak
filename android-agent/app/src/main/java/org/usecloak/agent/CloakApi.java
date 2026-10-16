package org.usecloak.agent;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** POST https://api.usecloak.org/v1/chat — same brain as the web app (worker adds the CLOAK prompt). */
final class CloakApi {
    private static final String URL_CHAT = "https://api.usecloak.org/v1/chat";
    private static final String URL_LOOK = "https://api.usecloak.org/v1/look";

    private CloakApi() {}

    static String chat(String model, String system, JSONArray messages, String effort, int maxTokens) throws Exception {
        String body = new JSONObject()
                .put("model", model)
                .put("system", system)
                .put("messages", messages)
                .put("effort", effort)
                .put("max_tokens", maxTokens)
                .put("stream", false)
                .toString();
        Exception last = null;
        for (int attempt = 0; attempt < 2; attempt++) {
            try {
                return post(body);
            } catch (Exception e) {
                last = e;
                Thread.sleep(2000);
            }
        }
        throw last;
    }

    /** POST /v1/look — vision answers a question about one image (the text model never sees it). */
    static String look(String jpegB64, String question) throws Exception {
        String body = new JSONObject().put("imageBase64", jpegB64).put("mimeType", "image/jpeg")
                .put("question", question).toString();
        JSONObject r = new JSONObject(send(URL_LOOK, body));
        return r.optString("answer", "");
    }

    private static String post(String json) throws Exception {
        return new JSONObject(send(URL_CHAT, json)).optString("response", "");
    }

    private static String send(String url, String json) throws Exception {
        HttpURLConnection h = (HttpURLConnection) new URL(url).openConnection();
        try {
            h.setConnectTimeout(15_000);
            h.setReadTimeout(90_000);
            h.setRequestMethod("POST");
            h.setDoOutput(true);
            h.setRequestProperty("Content-Type", "application/json");
            h.setRequestProperty("User-Agent", "CloakAgent/1.0 (Android)");
            try (OutputStream o = h.getOutputStream()) {
                o.write(json.getBytes(StandardCharsets.UTF_8));
            }
            int code = h.getResponseCode();
            String text = read(code < 400 ? h.getInputStream() : h.getErrorStream());
            JSONObject r;
            try {
                r = new JSONObject(text);
            } catch (Exception e) {
                throw new Exception("HTTP " + code);
            }
            if (code >= 400 || r.has("error")) throw new Exception(r.optString("error", "HTTP " + code));
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
}

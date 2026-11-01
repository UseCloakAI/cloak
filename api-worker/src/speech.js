// Text-to-speech: NVIDIA Magpie TTS Multilingual (Riva) on the NVIDIA key pool.
//
//   POST /v1/speech         {text, voice?, lang?} → audio/wav (16-bit mono, 22.05 kHz)
//   GET  /v1/speech/voices  → {voices:[{name, lang}]}
//
// Riva is gRPC-only, and Cloudflare's edge strips the `te: trailers` header
// plain gRPC needs ("Missing :te header" in production). NVIDIA's front door
// also speaks gRPC-Web (HTTP/1.1, no te, trailers in the body), so the Worker
// uses that: protobuf encoded by hand, gRPC-Web framing, no deps.
// Keys come from PROVIDER_KEYS (`nvidia`) through the governor: round-robin,
// cooldowns on 429 / bad keys, shared like every other upstream call.
import * as gov from "./governor.js";
import { connect } from "cloudflare:sockets";

const HOST = "https://grpc.nvcf.nvidia.com";
const SERVICE = "/nvidia.riva.tts.RivaSpeechSynthesis";
export const SPEECH_MODEL = "magpie-tts-multilingual";
const FUNCTION_ID = "877104f7-e885-42b9-8de8-f6e4c6303969"; // Magpie TTS Multilingual (NVCF)
const RATE = 22050;
const LINEAR_PCM = 1;
const DEFAULT_VOICE = "Magpie-Multilingual.EN-US.Aria";
const MAX_CHARS = 600;

// ── protobuf, just what Riva TTS needs ──────────────────────────────────────
const te = new TextEncoder();
const td = new TextDecoder();
function varint(n) {
  const out = [];
  while (n > 127) { out.push((n & 127) | 128); n = Math.floor(n / 128); }
  out.push(n);
  return out;
}
const tag = (f, w) => varint(f * 8 + w);
const pbString = (f, s) => { if (!s) return []; const b = te.encode(s); return [...tag(f, 2), ...varint(b.length), ...b]; };
const pbInt = (f, n) => (n ? [...tag(f, 0), ...varint(n)] : []);

export function synthesizeRequest(text, voice, lang) {
  return new Uint8Array([...pbString(1, text), ...pbString(2, lang), ...pbInt(3, LINEAR_PCM), ...pbInt(4, RATE), ...pbString(5, voice)]);
}

export function decode(buf) {
  const out = {};
  let i = 0;
  const rv = () => { let x = 0, m = 1, b; do { b = buf[i++]; x += (b & 127) * m; m *= 128; } while (b & 128); return x; };
  while (i < buf.length) {
    const key = rv(), f = Math.floor(key / 8), w = key & 7;
    let v;
    if (w === 0) v = rv();
    else if (w === 2) { const n = rv(); v = buf.subarray(i, i + n); i += n; }
    else if (w === 1) { v = buf.subarray(i, i + 8); i += 8; }
    else if (w === 5) { v = buf.subarray(i, i + 4); i += 4; }
    else throw new Error(`protobuf wire type ${w}`);
    (out[f] ||= []).push(v);
  }
  return out;
}

export function wav(pcm, rate = RATE) {
  const out = new Uint8Array(44 + pcm.length);
  const h = new DataView(out.buffer);
  const s = (o, t) => { for (let k = 0; k < t.length; k++) h.setUint8(o + k, t.charCodeAt(k)); };
  s(0, "RIFF"); h.setUint32(4, 36 + pcm.length, true); s(8, "WAVE"); s(12, "fmt ");
  h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
  h.setUint32(24, rate, true); h.setUint32(28, rate * 2, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true);
  s(36, "data"); h.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

// gRPC status → the HTTP status the governor understands.
const AS_HTTP = { 3: 400, 5: 404, 7: 403, 8: 429, 14: 503, 16: 401 };

// One gRPC-Web call with one key. Resolves to {ok, status, msgs?, error?}.
// Body = frames: [flag][len:4][bytes]; flag 0x00 is a message, 0x80 the trailers
// ("grpc-status: 0\r\ngrpc-message: …"). Errors can also come back as a plain
// HTTP status with a text body (auth failures arrive as 403 text).
async function call(method, msg, key) {
  const frame = new Uint8Array(5 + msg.length);
  new DataView(frame.buffer).setUint32(1, msg.length);
  frame.set(msg, 5);
  const res = await fetch(HOST + SERVICE + "/" + method, {
    method: "POST",
    headers: {
      "content-type": "application/grpc-web+proto",
      accept: "application/grpc-web+proto",
      "x-grpc-web": "1",
      "function-id": FUNCTION_ID,
      authorization: `Bearer ${key}`,
    },
    body: frame,
  });
  const body = new Uint8Array(await res.arrayBuffer());
  const isGrpc = /grpc/.test(res.headers.get("content-type") || "");
  if (!isGrpc) return { ok: false, status: res.ok ? 502 : res.status, error: td.decode(body.subarray(0, 300)) || `http ${res.status}`, headers: res.headers };
  const msgs = [];
  let status = res.headers.get("grpc-status"), message = res.headers.get("grpc-message");
  for (let i = 0; i + 5 <= body.length;) {
    const flag = body[i], n = new DataView(body.buffer, body.byteOffset + i + 1, 4).getUint32(0);
    const chunk = body.subarray(i + 5, i + 5 + n);
    if (flag & 0x80) {
      for (const line of td.decode(chunk).split("\r\n")) {
        const k = line.indexOf(":");
        if (k < 0) continue;
        const name = line.slice(0, k).trim().toLowerCase(), val = line.slice(k + 1).trim();
        if (name === "grpc-status") status = val;
        if (name === "grpc-message") message = val;
      }
    } else msgs.push(chunk);
    i += 5 + n;
  }
  if (status && status !== "0") {
    const error = decodeURIComponent(message || "") || `grpc ${status}`;
    return { ok: false, status: AS_HTTP[Number(status)] || 502, error, headers: res.headers };
  }
  if (!msgs.length) return { ok: false, status: 502, error: "empty gRPC response", headers: res.headers };
  return { ok: true, status: 200, msgs, headers: res.headers };
}

// Plain gRPC over a raw TLS socket, HTTP/1.1 written by hand. fetch() can't
// send `te: trailers` from Cloudflare's edge (it's stripped), and NVIDIA's
// gateway wants it once a real key passes auth. A socket sends what we write.
async function callSocket(method, msg, key) {
  const frame = new Uint8Array(5 + msg.length);
  new DataView(frame.buffer).setUint32(1, msg.length);
  frame.set(msg, 5);
  const head = [
    `POST ${SERVICE}/${method} HTTP/1.1`, "Host: grpc.nvcf.nvidia.com", "Content-Type: application/grpc", "TE: trailers",
    `function-id: ${FUNCTION_ID}`, `Authorization: Bearer ${key}`, `Content-Length: ${frame.length}`, "Connection: close", "", "",
  ].join("\r\n");
  const sock = connect({ hostname: "grpc.nvcf.nvidia.com", port: 443 }, { secureTransport: "on" });
  const w = sock.writable.getWriter();
  await w.write(new TextEncoder().encode(head));
  await w.write(frame);
  w.releaseLock();
  const chunks = [];
  const r = sock.readable.getReader();
  for (;;) { const { value, done } = await r.read(); if (done) break; chunks.push(value); }
  sock.close().catch(() => {});
  const raw = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  { let o = 0; for (const c of chunks) { raw.set(c, o); o += c.length; } }
  // headers
  let he = -1;
  for (let i = 0; i + 3 < raw.length; i++) if (raw[i] === 13 && raw[i + 1] === 10 && raw[i + 2] === 13 && raw[i + 3] === 10) { he = i; break; }
  if (he < 0) return { ok: false, status: 502, error: "bad HTTP response" };
  const lines = td.decode(raw.subarray(0, he)).split("\r\n");
  const code = Number(lines[0].split(" ")[1]) || 502;
  const hdr = new Headers();
  for (const l of lines.slice(1)) { const k = l.indexOf(":"); if (k > 0) hdr.append(l.slice(0, k).trim(), l.slice(k + 1).trim()); }
  let body = raw.subarray(he + 4);
  if (/chunked/i.test(hdr.get("transfer-encoding") || "")) {
    const parts = [];
    let i = 0;
    for (;;) {
      let e = i; while (e + 1 < body.length && !(body[e] === 13 && body[e + 1] === 10)) e++;
      const n = parseInt(td.decode(body.subarray(i, e)), 16);
      i = e + 2;
      if (!n) { // trailers
        for (const l of td.decode(body.subarray(i)).split("\r\n")) { const k = l.indexOf(":"); if (k > 0) hdr.set(l.slice(0, k).trim(), l.slice(k + 1).trim()); }
        break;
      }
      parts.push(body.subarray(i, i + n)); i += n + 2;
    }
    const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0; for (const p of parts) { joined.set(p, o); o += p.length; }
    body = joined;
  }
  const g = hdr.get("grpc-status");
  if (code !== 200 || (g && g !== "0")) {
    const error = decodeURIComponent(hdr.get("grpc-message") || "") || td.decode(body.subarray(0, 200)) || `http ${code}`;
    return { ok: false, status: g ? AS_HTTP[Number(g)] || 502 : code, error, headers: hdr };
  }
  const msgs = [];
  for (let i = 0; i + 5 <= body.length;) {
    const n = new DataView(body.buffer, body.byteOffset + i + 1, 4).getUint32(0);
    msgs.push(body.subarray(i + 5, i + 5 + n)); i += 5 + n;
  }
  if (!msgs.length) return { ok: false, status: 502, error: "empty gRPC response", headers: hdr };
  return { ok: true, status: 200, msgs, headers: hdr };
}

// Socket first; gRPC-Web over fetch if sockets fail outright.
async function callAny(method, msg, key) {
  try { return await callSocket(method, msg, key); } catch (e) {
    const r = await call(method, msg, key);
    if (!r.ok) r.error = `${r.error} (socket: ${e?.message || e})`;
    return r;
  }
}

// Try keys from the pool (healthy first) until one answers.
async function withKeys(env, ctx, method, msg) {
  const keys = (await gov.readKeyring(env)).nvidia || [];
  if (!keys.length) throw Object.assign(new Error("No NVIDIA keys configured"), { status: 503 });
  const groups = [{ provider: "nvidia", model: SPEECH_MODEL, keys }];
  await gov.syncCooldowns(gov.idsFor(groups)).catch(() => {});
  const { healthy, cold } = gov.orderCandidates(groups);
  let last = null;
  for (const c of [...healthy, ...cold].slice(0, 4)) {
    gov.noteCall(c.slot);
    let r;
    try { r = await callAny(method, msg, c.key); } catch (e) { last = { status: 502, error: String(e?.message || e) }; continue; }
    gov.observe({ provider: "nvidia", model: SPEECH_MODEL, key: c.key, res: { status: r.status, headers: r.headers || new Headers() }, bodyText: r.error || "", ctx });
    if (r.ok) return r.msgs;
    last = r;
    if (r.status === 400) break; // bad request: another key won't help
  }
  console.error(`[cloak-api] speech failed: ${last?.status} ${last?.error}`);
  throw Object.assign(new Error(last?.error || "speech unavailable"), { status: last?.status === 400 ? 400 : 503 });
}

let voiceCache = null;
async function listVoices(env, ctx) {
  if (voiceCache && Date.now() - voiceCache.at < 6 * 3600_000) return voiceCache.list;
  const [m] = await withKeys(env, ctx, "GetRivaSynthesisConfig", new Uint8Array());
  const list = [];
  for (const cfg of decode(m)[1] || []) {
    const params = {};
    for (const e of decode(cfg)[2] || []) {
      const kv = decode(e);
      params[td.decode(kv[1]?.[0] || new Uint8Array())] = td.decode(kv[2]?.[0] || new Uint8Array());
    }
    const base = params.voice_name, lang = params.language_code || "";
    const subs = (params.subvoices || "").split(",").map((x) => x.split(":")[0].trim()).filter(Boolean);
    for (const sub of subs) list.push({ name: base ? `${base}.${sub}` : sub, lang });
    if (base && !subs.length) list.push({ name: base, lang });
  }
  voiceCache = { at: Date.now(), list };
  return list;
}

export async function handleSpeech(env, request, ctx, { json, cors }) {
  try {
    const path = new URL(request.url).pathname;
    if (path === "/v1/speech/voices") return json({ voices: await listVoices(env, ctx) });
    let body;
    try { body = await request.json(); } catch { return json({ error: "JSON body required" }, 400); }
    const text = String(body?.text || "").trim().slice(0, MAX_CHARS);
    if (!text) return json({ error: "text required" }, 400);
    const voice = String(body.voice || DEFAULT_VOICE).slice(0, 80);
    const lang = String(body.lang || "en-US").slice(0, 12);
    const [m] = await withKeys(env, ctx, "Synthesize", synthesizeRequest(text, voice, lang));
    const pcm = decode(m)[1]?.[0];
    if (!pcm?.length) return json({ error: "no audio" }, 502);
    return new Response(wav(pcm), { headers: { ...cors, "Content-Type": "audio/wav", "Cache-Control": "no-store" } });
  } catch (e) {
    return json({ error: e.message || "speech unavailable" }, e.status || 503);
  }
}

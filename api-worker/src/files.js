// ─────────────────────────────────────────────────────────────────────────────
// Files from the web, for agents. No computer needed: the Worker is the fetcher.
//
//   GET  /v1/raw?url=…          the exact bytes, CORS-open, so builds can load
//                               images/audio/fonts/data from any public URL
//   POST /v1/file {url}         a text file for the model: {name, type, content}
//                               (binary → size + type only; use /v1/raw in code)
//   POST /v1/repo {url, path?}  a public GitHub repo: its file tree, or one file
//
// Public URLs only, size-capped. GitHub page URLs are rewritten to raw files.
// ─────────────────────────────────────────────────────────────────────────────

const RAW_MAX = 10 * 1024 * 1024;      // binary passthrough cap
const TEXT_MAX = 2 * 1024 * 1024;      // text handed to the model (before maxChars)
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "Content-Type, X-Source-Url" };
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const UA = "Mozilla/5.0 (compatible; CloakAgent/1.0; +https://usecloak.org)";

export function publicUrl(raw) {
  let u;
  try { u = new URL(String(raw || "")); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || /\.(localhost|internal|local)$/.test(h)) return null;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h.startsWith("[")) return null;
  return u;
}

// github.com/o/r/blob/branch/path → raw.githubusercontent.com/o/r/branch/path
export function githubRaw(u) {
  if (u.hostname === "github.com") {
    const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/);
    if (m) return new URL(`https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`);
  }
  if (u.hostname === "gist.github.com" && !/\/raw\b/.test(u.pathname)) return new URL(u.href.replace(/\/?$/, "/raw"));
  return u;
}

const TEXTY = /text|json|xml|javascript|ecmascript|csv|yaml|toml|markdown|svg|x-sh|x-python|sql|graphql/i;
const TEXT_EXT = /\.(txt|md|csv|tsv|json|jsonl|geojson|xml|svg|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sh|ya?ml|toml|ini|cfg|sql|lua|swift|r|ipynb|srt|vtt)$/i;

async function grab(u, cap) {
  const res = await fetch(u.href, { headers: { "User-Agent": UA, Accept: "*/*" }, redirect: "follow", signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers.get("content-length") || 0);
  if (len > cap) throw new Error(`file is ${Math.round(len / 1e6)}MB (limit ${Math.round(cap / 1e6)}MB)`);
  return res;
}
async function readCapped(res, cap) {
  const reader = res.body.getReader();
  const parts = []; let n = 0, cut = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > cap) { cut = true; reader.cancel(); break; }
    parts.push(value);
  }
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return { bytes: out, cut };
}

export async function handleRaw(request) {
  const u0 = publicUrl(new URL(request.url).searchParams.get("url"));
  if (!u0) return J({ error: "public http(s) url required" }, 400);
  const u = githubRaw(u0);
  try {
    const res = await grab(u, RAW_MAX);
    const { bytes, cut } = await readCapped(res, RAW_MAX);
    if (cut) return J({ error: "file larger than 10MB" }, 413);
    let type = res.headers.get("content-type") || "application/octet-stream";
    // raw.githubusercontent serves everything as text/plain: fix by extension so builds can use it.
    if (/raw\.githubusercontent|gist/.test(u.hostname) && /text\/plain/.test(type)) {
      const ext = (u.pathname.match(/\.(\w+)$/) || [])[1] || "";
      type = { js: "text/javascript", mjs: "text/javascript", css: "text/css", json: "application/json", svg: "image/svg+xml", html: "text/html", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", woff2: "font/woff2" }[ext.toLowerCase()] || type;
    }
    return new Response(bytes, { headers: { ...CORS, "Content-Type": type, "Cache-Control": "public, max-age=3600", "X-Source-Url": u.href } });
  } catch (e) {
    return J({ error: "Could not fetch: " + e.message }, 502);
  }
}

export async function handleFile(body) {
  const u0 = publicUrl(body?.url);
  if (!u0) return J({ error: "public http(s) url required" }, 400);
  const u = githubRaw(u0);
  const maxChars = Math.max(1000, Math.min(400_000, Number(body?.maxChars) || 120_000));
  const name = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || u.hostname).slice(0, 80) || "file";
  try {
    const res = await grab(u, RAW_MAX);
    const type = res.headers.get("content-type") || "";
    const texty = TEXTY.test(type) || TEXT_EXT.test(u.pathname);
    if (!texty) {
      const { bytes } = await readCapped(res, RAW_MAX);
      return J({ url: u.href, name, type, binary: true, bytes: bytes.length, rawUrl: "https://api.usecloak.org/v1/raw?url=" + encodeURIComponent(u.href) });
    }
    const { bytes, cut } = await readCapped(res, TEXT_MAX);
    const text = new TextDecoder().decode(bytes);
    return J({ url: u.href, name, type, binary: false, content: text.slice(0, maxChars), truncated: cut || text.length > maxChars, chars: text.length, rawUrl: "https://api.usecloak.org/v1/raw?url=" + encodeURIComponent(u.href) });
  } catch (e) {
    return J({ error: "Could not fetch " + u.href + ": " + e.message }, 502);
  }
}

// Public GitHub repos via the REST API (60 req/h unauthenticated; GITHUB_TOKEN raises it).
export async function handleRepo(env, body) {
  const m = String(body?.url || "").match(/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+)(?:\/(.*))?)?\/?$/);
  if (!m) return J({ error: "github.com/owner/repo url required" }, 400);
  const [, owner, repo, ref0, sub] = m;
  const h = { "User-Agent": UA, Accept: "application/vnd.github+json", ...(env.GITHUB_TOKEN ? { Authorization: "Bearer " + env.GITHUB_TOKEN } : {}) };
  try {
    let ref = ref0;
    if (!ref) {
      const r = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: h });
      if (!r.ok) throw new Error("repo " + r.status);
      ref = (await r.json()).default_branch || "main";
    }
    const path = String(body?.path || "").replace(/^\/+/, "");
    if (path) return handleFile({ url: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`, maxChars: body?.maxChars });
    const t = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, { headers: h });
    if (!t.ok) throw new Error("tree " + t.status);
    const tree = (await t.json()).tree || [];
    const files = tree.filter((x) => x.type === "blob" && (!sub || x.path.startsWith(sub))).map((x) => ({ path: x.path, size: x.size }));
    return J({ repo: `${owner}/${repo}`, ref, files: files.slice(0, 800), total: files.length });
  } catch (e) {
    return J({ error: "GitHub: " + e.message }, 502);
  }
}

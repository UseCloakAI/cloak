// The tools a companion can use, and the guard every call passes through.
//
// Each tool: { spec (OpenAI function schema), label(args) → what the app shows
// while it runs, run(args, cx) → { text, sources?, summary? } }.
// cx = { env, ctx, mind, userKey, companion, depth, emit, signal, tz }.
//
// Safety lives here as well as in the prompt: guard() runs before any tool
// that reaches the outside world, so the one rule holds even if a model
// talks itself into a bad call.

import * as gov from "../../api-worker/src/governor.js";
import { COMPANIONS } from "./prompts.js";

const PAGE_CHARS = 9000;
const RESULT_CHARS = 6000;

// ── Guard ────────────────────────────────────────────────────────────────────
const BLOCK = [
  [/\b(lethal|fatal|deadly)\s+(dose|amount|quantity)\b|\b(painless|easiest|quickest|best)\s+(way|method)s?\s+to\s+(die|kill (my|your|one)self|commit suicide)\b|\bsuicide\s+methods?\b|\bhow\s+to\s+(hang|overdose|poison)\s+(my|your|one)self\b/i, "self-harm methods"],
  [/\b(home|current|private|real)\s+address\s+(of|for)\b|\bwhere\s+does\s+.{2,60}\s+live\b|\b(dox+|doxx?ing)\b|\b(find|track|locate|unmask|identify)\b.{0,40}\b(person|someone|him|her|them|owner of|who is behind)\b.{0,40}\b(address|location|phone|identity|account|ip)\b|\breverse\s+(lookup|search).{0,30}\b(phone|address|username)\b/i, "locating or unmasking a private person"],
  [/\b(synthesi[sz]e|make|produce|culture|weaponi[sz]e|build)\b.{0,40}\b(sarin|vx\b|nerve agent|mustard gas|ricin|anthrax|botulinum|smallpox|chlorine gas|pipe bomb|ied\b|explosive device|dirty bomb|nuclear device)\b/i, "weapons capable of mass harm"],
  [/\b(child|minor|underage|preteen|teen)\b.{0,30}\b(porn|nude|naked|sexual|sex)\b|\bcsam\b|\bloli\b/i, "sexual content involving minors"],
  [/\b(spy|track|monitor)\b.{0,30}\b(my )?(wife|husband|girlfriend|boyfriend|partner|ex)\b.{0,30}\b(phone|location|messages|without)\b|\bstalkerware\b/i, "covert surveillance of a person"],
];
export function guard(text) {
  const s = String(text || "");
  for (const [re, why] of BLOCK) if (re.test(s)) return why;
  return null;
}

function publicUrl(u) {
  try {
    const url = new URL(u);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const h = url.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || !h.includes(".")) return null;
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(h) || h.includes(":")) return null; // raw IPs, v6
    return url;
  } catch {
    return null;
  }
}

// ── Search + read ────────────────────────────────────────────────────────────
async function tavily(env, endpoint, payload) {
  let keys = [];
  try {
    const ring = await gov.readKeyring(env);
    keys = Array.isArray(ring.tavily) ? ring.tavily.filter(Boolean) : [];
  } catch {}
  if (!keys.length) return null;
  const first = Math.floor(Math.random() * keys.length);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[(first + i) % keys.length];
    const res = await fetch(`https://api.tavily.com/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) return res.json();
    if (![401, 403, 429, 432, 433].includes(res.status)) break;
  }
  return null;
}

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'", nbsp: " " };
const decode = (s) => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => ENT[e.toLowerCase()] ?? (e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : m));
const strip = (html) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

async function duckduckgo(query) {
  const res = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query), { headers: { "User-Agent": "Mozilla/5.0 (compatible; research-assistant)" }, signal: AbortSignal.timeout(12_000) });
  if (!res.ok) return [];
  const html = await res.text();
  const out = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
  let m;
  while ((m = re.exec(html)) && out.length < 8) {
    let url = decode(m[1]);
    const uddg = /[?&]uddg=([^&]+)/.exec(url);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (!/^https?:/.test(url)) continue;
    out.push({ title: strip(m[2]), url, snippet: strip(m[3] || "").slice(0, 400) });
  }
  return out;
}

export async function search(env, query, recent) {
  try {
    const data = await tavily(env, "search", { query, max_results: 7, search_depth: "basic", ...(recent ? { topic: "news", days: 7 } : {}) });
    const items = (data?.results || []).map((r) => ({ title: r.title || r.url, url: r.url, snippet: String(r.content || "").replace(/\s+/g, " ").trim().slice(0, 500), date: r.published_date || "" }));
    if (items.length) return items;
  } catch {}
  try {
    return await duckduckgo(query);
  } catch {
    return [];
  }
}

function htmlToText(html) {
  return strip(
    html
      .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>/gi, "\n"),
  );
}

export async function readPage(env, url) {
  try {
    const data = await tavily(env, "extract", { urls: [url] });
    const text = data?.results?.[0]?.raw_content;
    if (text && text.length > 200) return text;
  } catch {}
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; research-assistant)", Accept: "text/html,text/plain,application/json" }, redirect: "follow", signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`the site answered ${res.status}`);
  const type = res.headers.get("content-type") || "";
  if (!/text|json|xml/.test(type)) throw new Error(`not a readable page (${type.split(";")[0] || "unknown type"})`);
  const raw = (await res.text()).slice(0, 1_500_000);
  return /html/.test(type) ? htmlToText(raw) : raw;
}

// ── Calculator: a real parser, no eval ───────────────────────────────────────
const FN = { sqrt: Math.sqrt, abs: Math.abs, ln: Math.log, log: Math.log10, log2: Math.log2, exp: Math.exp, sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, round: Math.round, floor: Math.floor, ceil: Math.ceil, min: Math.min, max: Math.max, pow: Math.pow };
const CONST = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };
export function calculate(src) {
  const s = String(src).replace(/[,_](?=\d{3}\b)/g, "").replace(/×/g, "*").replace(/÷/g, "/").replace(/\*\*/g, "^");
  let i = 0;
  const ws = () => { while (/\s/.test(s[i] || "")) i++; };
  const eat = (c) => { ws(); if (s[i] === c) { i++; return true; } return false; };
  function expr() { let v = term(); for (;;) { if (eat("+")) v += term(); else if (eat("-")) v -= term(); else return v; } }
  function term() { let v = unary(); for (;;) { if (eat("*")) v *= unary(); else if (eat("/")) v /= unary(); else if (eat("%")) v %= unary(); else return v; } }
  function unary() { if (eat("-")) return -unary(); if (eat("+")) return unary(); return power(); }
  function power() { const b = atom(); return eat("^") ? Math.pow(b, unary()) : b; }
  function atom() {
    ws();
    if (eat("(")) { const v = expr(); if (!eat(")")) throw new Error("missing )"); return post(v); }
    const num = /^\d*\.?\d+(e[+-]?\d+)?/i.exec(s.slice(i));
    if (num) { i += num[0].length; return post(parseFloat(num[0])); }
    const id = /^[a-z_]\w*/i.exec(s.slice(i));
    if (!id) throw new Error(`unexpected "${s[i] ?? "end"}"`);
    i += id[0].length;
    const name = id[0].toLowerCase();
    if (eat("(")) {
      const args = [];
      if (!eat(")")) { do args.push(expr()); while (eat(",")); if (!eat(")")) throw new Error("missing )"); }
      if (!FN[name]) throw new Error(`unknown function ${name}`);
      return post(FN[name](...args));
    }
    if (!(name in CONST)) throw new Error(`unknown name ${name}`);
    return post(CONST[name]);
  }
  function post(v) { ws(); if (s[i] === "!") { i++; if (v < 0 || v > 170 || v % 1) throw new Error("factorial needs a whole number from 0 to 170"); let f = 1; for (let k = 2; k <= v; k++) f *= k; return f; } return v; }
  const v = expr();
  ws();
  if (i < s.length) throw new Error(`unexpected "${s[i]}"`);
  if (!Number.isFinite(v)) throw new Error("result is not a finite number");
  return v;
}

// ── The catalog ──────────────────────────────────────────────────────────────
const fn = (name, description, properties, required = []) => ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } });
const str = (description, extra = {}) => ({ type: "string", description, ...extra });
const clip = (s, n) => (s.length > n ? s.slice(0, n) + `\n…[${s.length - n} more characters not shown]` : s);

export const TOOLS = {
  web_search: {
    spec: fn("web_search", "Search the web. Use for anything that may have changed since your training (news, prices, people in office, releases, scores, laws), to verify a claim, or to find sources. Several focused searches beat one vague one.", { query: str("Search terms, as you would type them into a search engine."), recent: { type: "boolean", description: "True to search only news from the last 7 days." } }, ["query"]),
    label: (a) => `Searching: ${String(a.query || "").slice(0, 80)}`,
    outward: (a) => a.query,
    async run(a, cx) {
      const q = String(a.query || "").trim().slice(0, 300);
      if (!q) return { text: "No query given." };
      const items = cx.net ? await cx.net.search(q, !!a.recent) : await search(cx.env, q, !!a.recent);
      if (!items.length) return { text: "No results. Try different words.", summary: "no results" };
      const sources = items.slice(0, 6).map((r) => ({ title: r.title, url: r.url }));
      const base = cx.cite(sources);
      return { text: items.slice(0, 6).map((r, i) => `[${base + i}] ${r.title}\n${r.url}${r.date ? `\n${r.date}` : ""}\n${r.snippet}`).join("\n\n"), sources, summary: `${Math.min(6, items.length)} results` };
    },
  },
  read_page: {
    spec: fn("read_page", "Open a web page and read its text. Use after a search when the snippet is not enough, or when the person gives you a link.", { url: str("Full URL, starting with https://") }, ["url"]),
    label: (a) => { try { return `Reading ${new URL(a.url).hostname.replace(/^www\./, "")}`; } catch { return "Reading a page"; } },
    outward: (a) => a.url,
    async run(a, cx) {
      const url = publicUrl(a.url);
      if (!url) return { text: "That address cannot be opened. Only public http(s) pages can be read." };
      try {
        const text = cx.net ? await cx.net.read(url.href) : await readPage(cx.env, url.href);
        const sources = [{ title: url.hostname.replace(/^www\./, ""), url: url.href }];
        const n = cx.cite(sources);
        return { text: `[${n}] ${url.href}\n\n${clip(text, PAGE_CHARS)}`, sources, summary: `${Math.round(Math.min(text.length, PAGE_CHARS) / 1000)}k characters` };
      } catch (e) {
        return { text: `Could not read that page: ${e.message}. Try another source.`, summary: "could not read" };
      }
    },
  },
  computer_look: {
    spec: fn("computer_look", "Look at the screen of your computer (a Linux desktop with Firefox and a terminal, 1280x800). Returns what is on screen with x,y coordinates read off a 100px grid. Wakes the computer if it is asleep (that takes about a minute). Always look before clicking, and look again after to check what happened.", { question: str("What you need to find or check, for example: where is the address bar, did the page load, what does the error say.") }, ["question"]),
    label: () => "Looking at the screen",
    needs: "computer", top: true,
    async run(a, cx) {
      const r = await cx.computer.look(String(a.question || "Describe the screen."));
      return { text: `Screen ${r.w}x${r.h}.\n${clip(r.text, RESULT_CHARS)}`, summary: "looked" };
    },
  },
  computer_click: {
    spec: fn("computer_click", "Click on the computer's screen at x,y (pixels, from computer_look).", { x: { type: "integer" }, y: { type: "integer" }, button: str("left (default), right, or double.", { enum: ["left", "right", "double"] }) }, ["x", "y"]),
    label: (a) => `Clicking at ${a.x}, ${a.y}`,
    needs: "computer", top: true,
    async run(a, cx) {
      await cx.computer.input({ action: a.button === "right" ? "right" : a.button === "double" ? "double" : "click", x: a.x, y: a.y });
      return { text: "Clicked. Look again to see what happened.", summary: "clicked" };
    },
  },
  computer_type: {
    spec: fn("computer_type", "Type text on the computer, into whatever has focus (click the field first).", { text: str("The text to type. Use computer_key for Enter, Tab and shortcuts.") }, ["text"]),
    label: () => "Typing",
    needs: "computer", top: true, outward: (a) => a.text,
    async run(a, cx) { await cx.computer.input({ action: "type", text: String(a.text || "") }); return { text: "Typed.", summary: "typed" }; },
  },
  computer_key: {
    spec: fn("computer_key", "Press keys on the computer, xdotool style, separated by spaces: Return, Tab, Escape, BackSpace, ctrl+l, ctrl+c, alt+F4, super, Down.", { keys: str("For example: ctrl+l or Return or ctrl+shift+t") }, ["keys"]),
    label: (a) => `Pressing ${String(a.keys || "").slice(0, 30)}`,
    needs: "computer", top: true,
    async run(a, cx) { await cx.computer.input({ action: "key", keys: String(a.keys || "") }); return { text: "Pressed.", summary: "pressed" }; },
  },
  computer_scroll: {
    spec: fn("computer_scroll", "Scroll on the computer's screen, optionally at x,y.", { direction: str("up, down, left or right.", { enum: ["up", "down", "left", "right"] }), amount: { type: "integer", description: "Notches, 1 to 25 (default 3)." }, x: { type: "integer" }, y: { type: "integer" } }, ["direction"]),
    label: (a) => `Scrolling ${a.direction || "down"}`,
    needs: "computer", top: true,
    async run(a, cx) { await cx.computer.input({ action: "scroll", direction: a.direction, amount: a.amount, x: a.x, y: a.y }); return { text: "Scrolled.", summary: "scrolled" }; },
  },
  computer_drag: {
    spec: fn("computer_drag", "Drag with the mouse on the computer from x,y to to_x,to_y.", { x: { type: "integer" }, y: { type: "integer" }, to_x: { type: "integer" }, to_y: { type: "integer" } }, ["x", "y", "to_x", "to_y"]),
    label: () => "Dragging",
    needs: "computer", top: true,
    async run(a, cx) { await cx.computer.input({ action: "drag", x: a.x, y: a.y, to_x: a.to_x, to_y: a.to_y }); return { text: "Dragged.", summary: "dragged" }; },
  },
  computer_run: {
    spec: fn("computer_run", "Run a bash command on this person's own desktop computer (only theirs; you have sudo). Programs you start open windows on its screen (end the command with & to leave them running). For code and packages with no screen, prefer server_run.", { command: str("The bash command."), timeout: { type: "integer", description: "Seconds, up to 600 (default 60)." } }, ["command"]),
    label: (a) => `Running ${String(a.command || "").slice(0, 40)}`,
    needs: "computer", top: true, outward: (a) => a.command,
    async run(a, cx) { return ranText(await cx.computer.run("desktop", String(a.command || ""), a.timeout)); },
  },
  server_run: {
    spec: fn("server_run", "Run a bash command on this person's own server (headless Debian with Python, Node, git and build tools; only theirs; you have sudo, so sudo apt-get install works). Their files stay between chats. Up to 600 seconds per command.", { command: str("The bash command."), timeout: { type: "integer", description: "Seconds, up to 600 (default 60)." } }, ["command"]),
    label: (a) => `Running ${String(a.command || "").slice(0, 40)}`,
    needs: "computer", top: true, outward: (a) => a.command,
    async run(a, cx) { return ranText(await cx.computer.run("server", String(a.command || ""), a.timeout)); },
  },
  create_blink: {
    spec: fn("create_blink", "Make a new Blink for this person: a companion with its own look, name, purpose and personality. It appears in their sidebar right away with its own chat. Use when they ask you to make, build or design a Blink (or a bot or assistant inside Blinks). Design it thoughtfully to fit the purpose; fill in what they did not say.", {
      name: str("Its name, one or two words."),
      purpose: str("What it is for, in one short sentence, in their words where possible."),
      persona: str("How it talks and behaves, a few sentences (tone, focus, format)."),
      shape: str("One of: orb, slab, spark, bloom, dome, drop, pill.", { enum: ["orb", "slab", "spark", "bloom", "dome", "drop", "pill"] }),
      color: str("Body colour as a hex code, for example #4CBF73."),
      eyes: str("One of: dots, big, small, wide, one, sleepy.", { enum: ["dots", "big", "small", "wide", "one", "sleepy"] }),
      topper: str("One of: none, curl, sprout, sparks, rays, antenna, bow, star.", { enum: ["none", "curl", "sprout", "sparks", "rays", "antenna", "bow", "star"] }),
      glasses: { type: "boolean", description: "Glasses on or off." },
      cheeks: { type: "boolean", description: "Rosy cheeks on or off." },
      lane: str("Its usual brain: swift (fast, simple), smart (balanced), deep (hard thinking), code (programming).", { enum: ["swift", "smart", "deep", "code"] }),
      hello: str("Its first line when they open it, short and in character."),
    }, ["name", "purpose", "shape", "color", "eyes"]),
    label: (a) => `Making ${String(a.name || "a new Blink").slice(0, 32)}`,
    top: true,
    outward: (a) => `${a.name} ${a.purpose} ${a.persona}`,
    async run(a) {
      const pick = (v, list, d) => (list.includes(v) ? v : d);
      const name = String(a.name || "").replace(/[^\p{L}\p{N} '\-]/gu, "").trim().slice(0, 24);
      if (!name) return { text: "It needs a name.", summary: "no name" };
      const blink = {
        name,
        purpose: String(a.purpose || "").trim().slice(0, 140),
        persona: String(a.persona || "").trim().slice(0, 900),
        lane: pick(a.lane, ["swift", "smart", "deep", "code"], "smart"),
        hello: String(a.hello || "").trim().slice(0, 120),
        look: {
          shape: pick(a.shape, ["orb", "slab", "spark", "bloom", "dome", "drop", "pill"], "orb"),
          color: /^#[0-9a-f]{6}$/i.test(a.color || "") ? a.color : "#5B9BF8",
          eyes: pick(a.eyes, ["dots", "big", "small", "wide", "one", "sleepy"], "dots"),
          topper: pick(a.topper, ["none", "curl", "sprout", "sparks", "rays", "antenna", "bow", "star"], "none"),
          glasses: !!a.glasses,
          cheeks: !!a.cheeks,
        },
      };
      return { text: `Made ${name}. It is in their sidebar now with its own chat, and they can change anything about it with the pencil next to its name. Tell them in a sentence or two, in your own voice.`, summary: "made", event: { blink: blink } };
    },
  },
  grep_files: {
    spec: fn("grep_files", "Search the code files in this chat (the canvas) for a word, name or regular expression. Returns matching lines with line numbers. Use before editing to find the exact lines.", { pattern: str("Text or a regular expression, for example: function render|onClick"), file: str("Optional: only this file, by name.") }, ["pattern"]),
    label: (a) => `Searching the code for ${String(a.pattern || "").slice(0, 40)}`,
    needs: "files",
    async run(a, cx) {
      let re;
      try { re = new RegExp(String(a.pattern || "").slice(0, 200), "i"); } catch { re = new RegExp(String(a.pattern || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); }
      const out = [];
      for (const f of cx.files) {
        if (a.file && f.name !== a.file) continue;
        f.code.split("\n").forEach((l, i) => { if (out.length < 80 && re.test(l)) out.push(`${f.name}:${i + 1}: ${l.slice(0, 200)}`); });
      }
      return { text: out.length ? out.join("\n") : "No matches.", summary: `${out.length} ${out.length === 1 ? "match" : "matches"}` };
    },
  },
  read_file: {
    spec: fn("read_file", "Read lines from a code file in this chat (the canvas), with line numbers.", { file: str("The file's name, as listed under CODE FILES."), from: { type: "integer", description: "First line (1-based). Optional." }, to: { type: "integer", description: "Last line. Optional; at most 400 lines at a time." } }, ["file"]),
    label: (a) => `Reading ${String(a.file || "a file").slice(0, 40)}`,
    needs: "files",
    async run(a, cx) {
      const f = cx.files.find((x) => x.name === a.file) || cx.files.find((x) => x.name.toLowerCase() === String(a.file || "").toLowerCase());
      if (!f) return { text: `No file called ${a.file}. Files: ${cx.files.map((x) => x.name).join(", ")}`, summary: "not found" };
      const lines = f.code.split("\n");
      const from = Math.max(1, Number(a.from) || 1), to = Math.min(lines.length, Number(a.to) || from + 399, from + 399);
      return { text: lines.slice(from - 1, to).map((l, i) => `${from + i}: ${l}`).join("\n"), summary: `lines ${from}-${to} of ${lines.length}` };
    },
  },
  calculate: {
    spec: fn("calculate", "Evaluate arithmetic exactly. Use for any calculation where a wrong digit would matter. Supports + - * / % ^ ! parentheses, sqrt, abs, ln, log, exp, sin, cos, tan, round, floor, ceil, min, max, pow, pi, e.", { expression: str("For example: (1250 * 1.07^10) / 12") }, ["expression"]),
    label: (a) => `Calculating ${String(a.expression || "").slice(0, 60)}`,
    async run(a) {
      try {
        const v = calculate(a.expression);
        const out = Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(12)));
        return { text: `${a.expression} = ${out}`, summary: out };
      } catch (e) {
        return { text: `Could not evaluate: ${e.message}.`, summary: "error" };
      }
    },
  },
  remember: {
    spec: fn("remember", "Save one lasting fact about the person so every companion knows it in future conversations: who they are, what they prefer, what they are working on, people and dates that matter to them. One fact per call, written as a full sentence. Do not save secrets (passwords, card numbers), one-off details, or anything they asked you not to keep.", { fact: str("For example: Is training for a half marathon in March."), kind: str("What sort of fact it is.", { enum: ["profile", "preference", "project", "person", "other"] }) }, ["fact"]),
    label: () => "Saving to memory",
    needs: "mind",
    async run(a, cx) {
      const r = await cx.mind.remember({ fact: a.fact, kind: a.kind, by: cx.companion });
      return { text: r.ok ? (r.updated ? "Updated an existing memory." : "Saved.") : `Not saved: ${r.error}`, summary: r.ok ? "saved" : "not saved" };
    },
  },
  recall: {
    spec: fn("recall", "Search what the companions have remembered about this person. The most relevant memories are already in your context; use this to look for something specific that is not shown.", { query: str("What to look for.") }, ["query"]),
    label: () => "Checking memory",
    needs: "mind",
    async run(a, cx) {
      const list = await cx.mind.recall(String(a.query || ""), 12);
      return { text: list.length ? list.map((m) => `- ${m.fact} (${m.kind}, saved ${m.day})`).join("\n") : "Nothing saved about that.", summary: `${list.length} found` };
    },
  },
  forget: {
    spec: fn("forget", "Delete memories that match. Use when the person asks you to forget something or says a saved fact is wrong.", { query: str("Words that identify the memory to delete.") }, ["query"]),
    label: () => "Removing from memory",
    needs: "mind",
    async run(a, cx) {
      const n = await cx.mind.forget(String(a.query || ""));
      return { text: n ? `Deleted ${n} ${n === 1 ? "memory" : "memories"}.` : "Nothing matched, so nothing was deleted.", summary: `${n} removed` };
    },
  },
  ask_companion: {
    spec: fn("ask_companion", "Hand a self-contained piece of work to a helper and get their answer back. Use it when part of the task is clearly their strength: moss (the researcher) for careful research and analysis, ember (the builder) for code, juno (the writer) for creative writing, pip (the quick helper) for quick lookups, sol (the listener) for a gentle read on a hard personal situation. They do not see this conversation, so put everything they need in the task.", { companion: str("Who to ask.", { enum: ["pip", "moss", "ember", "juno", "sol"] }), task: str("The complete brief: what you need, the facts they need, and the form the answer should take.") }, ["companion", "task"]),
    label: (a) => `Asking ${COMPANIONS[a.companion] ? COMPANIONS[a.companion].name.toLowerCase() : "a helper"}`,
    top: true,
    async run(a, cx) {
      if (a.companion === cx.companion) return { text: "That is you. Do the work yourself or ask a different companion." };
      const text = await cx.delegate(a.companion, String(a.task || "").slice(0, 6000));
      return { text: clip(text || "They had nothing to add.", RESULT_CHARS), summary: "answered" };
    },
  },
  // Blink to Blink. Only where the host can run another Blink (the home-PC
  // brain sets cx.talk), only from a Blink the person is talking to, and
  // the Blink that receives can never message anyone in turn (no loops).
  message_blink: {
    spec: fn("message_blink", "Send a message to another of this person's Blinks and get its reply. Use it when the person asks you to tell or ask another Blink something, or when another Blink's purpose makes it clearly better placed to answer part of this. Write the message so it stands alone; the other Blink does not see this conversation. Never use it to chat for its own sake.", { to: str("The other Blink's name, exactly as listed under OTHER BLINKS."), message: str("What to send, in your own voice.") }, ["to", "message"]),
    label: (a) => `Messaging ${String(a.to || "another Blink").slice(0, 40)}`,
    needs: "talk",
    top: true,
    outward: (a) => a.message,
    async run(a, cx) {
      const r = await cx.talk(String(a.to || ""), String(a.message || "").slice(0, 4000));
      return r.ok ? { text: `${r.name} replied:\n${clip(r.reply, RESULT_CHARS)}`, summary: "replied" } : { text: `Not sent: ${r.error}`, summary: "not sent" };
    },
  },
  schedule_task: {
    spec: fn("schedule_task", "Schedule work to run later, once or on a repeat, without the person being here. When it runs, a companion does the task with tools and the result lands in their inbox. Use for reminders, recurring briefings, and checking on something later. Times are UTC: convert from the person's local time given in your context.", { title: str("Short name shown in their task list."), prompt: str("The full instruction to carry out at that time, written so it makes sense with no other context."), run_at: str("When to run first, ISO 8601 in UTC, for example 2026-11-11T14:00:00Z."), repeat: str("How often to repeat after the first run.", { enum: ["none", "hourly", "daily", "weekly"] }) }, ["title", "prompt", "run_at"]),
    label: (a) => `Scheduling: ${String(a.title || "task").slice(0, 60)}`,
    needs: "mind",
    top: true,
    outward: (a) => a.prompt,
    async run(a, cx) {
      const r = await cx.mind.addTask({ title: a.title, prompt: a.prompt, run_at: a.run_at, repeat: a.repeat, companion: cx.companion, bot: cx.bot, brand: cx.brand });
      return { text: r.ok ? `Scheduled (id ${r.id}). First run ${r.run_at} UTC${r.repeat !== "none" ? `, repeating ${r.repeat}` : ""}.` : `Not scheduled: ${r.error}`, summary: r.ok ? "scheduled" : "not scheduled" };
    },
  },
  list_tasks: {
    spec: fn("list_tasks", "List the person's scheduled tasks.", {}),
    label: () => "Checking scheduled tasks",
    needs: "mind",
    top: true,
    async run(a, cx) {
      const list = await cx.mind.tasks();
      return { text: list.length ? list.map((t) => `- id ${t.id}: "${t.title}" next ${t.run_at} UTC, repeat ${t.repeat}`).join("\n") : "No scheduled tasks.", summary: `${list.length} tasks` };
    },
  },
  cancel_task: {
    spec: fn("cancel_task", "Cancel a scheduled task by its id (from list_tasks).", { id: { type: "integer", description: "The task id." } }, ["id"]),
    label: () => "Cancelling a task",
    needs: "mind",
    top: true,
    async run(a, cx) {
      const ok = await cx.mind.removeTask(Number(a.id));
      return { text: ok ? "Cancelled." : "No task with that id.", summary: ok ? "cancelled" : "not found" };
    },
  },
};

// The tools on offer for this call. Sub-agents (depth > 0) cannot delegate or
// schedule; without a user key there is no memory.
function ranText(r) {
  const parts = [`exit code ${r.code} after ${r.seconds}s`];
  if (r.stdout) parts.push(`stdout:\n${clip(r.stdout, 4000)}`);
  if (r.stderr) parts.push(`stderr:\n${clip(r.stderr, 2000)}`);
  if (r.truncated) parts.push("(output was long; only the end is shown)");
  return { text: parts.join("\n"), summary: r.code === 0 ? "done" : `exit ${r.code}` };
}
export function toolbox({ depth = 0, hasMind = false, hasTalk = false, hasFiles = false, hasComputer = false }) {
  return Object.entries(TOOLS)
    .filter(([, t]) => !(t.top && depth > 0) && !(t.needs === "mind" && !hasMind) && !(t.needs === "talk" && !hasTalk) && !(t.needs === "files" && !hasFiles) && !(t.needs === "computer" && !hasComputer))
    .map(([name]) => name);
}
// Every tool also takes "status": the line the person sees while it runs,
// written by the model in plain words ("Looking for cheaper homes around
// Las Vegas"), the way a person would say what they are doing.
const STATUS = { type: "string", description: "One short, friendly line telling the person what you are doing right now, in the present tense, with a capital letter and no full stop. For example: Looking for cheaper homes around Las Vegas" };
export const specs = (names) => names.map((n) => {
  const s = TOOLS[n].spec;
  return { ...s, function: { ...s.function, parameters: { ...s.function.parameters, properties: { ...s.function.parameters.properties, status: STATUS } } } };
});

export async function runTool(name, rawArgs, cx) {
  const tool = TOOLS[name];
  if (!tool) return { text: `There is no tool called ${name}.`, summary: "unknown tool" };
  let args;
  try {
    args = typeof rawArgs === "string" ? JSON.parse(rawArgs || "{}") : rawArgs || {};
  } catch {
    return { text: "The arguments were not valid JSON. Call the tool again with a JSON object.", summary: "bad arguments" };
  }
  if (tool.outward) {
    const why = guard(tool.outward(args));
    if (why) return { text: `Blocked by the platform: this looks like ${why}, which could put a person in danger. Do not try another route to it. Tell the person plainly that you cannot help with that part, and offer the safe help you can give.`, summary: "blocked", blocked: true };
  }
  try {
    return await tool.run(args, cx);
  } catch (e) {
    return { text: `The tool failed: ${String(e.message || e).slice(0, 200)}. Carry on without it or try a different approach.`, summary: "failed" };
  }
}

export function toolLabel(name, rawArgs) {
  try {
    const args = typeof rawArgs === "string" ? JSON.parse(rawArgs || "{}") : rawArgs || {};
    const said = typeof args.status === "string" ? args.status.replace(/[\u0000-\u001f]+/g, " ").replace(/\s*[.…]+$/, "").trim().slice(0, 90) : "";
    return said || TOOLS[name]?.label(args) || name;
  } catch {
    return name;
  }
}

// Public catalog for the app (GET /v1/tools).
export function catalog() {
  return Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.spec.function.description.split(". ")[0] + "." }));
}

// The one rule: never harm a human life or put one in danger.
//
// Two layers, so safety never depends on a model behaving:
//   1. detect()  — runs on every turn before any model is called. If someone
//      may be in danger the worker (a) routes to the strongest general lane,
//      (b) adds the CARE protocol to the system prompt, and (c) sends the
//      client a `care` event with real helplines for the person's country,
//      which the app pins above the reply no matter what the model writes.
//   2. The constitution in prompts.js, which every companion runs.

const SELF = [
  /\b(kill|end|hurt|harm|cut|starv|hang|shoot|drown|poison|overdos)\w*\s+(my ?self|myself)\b/i,
  /\b(suicid\w*|self[- ]?harm\w*|kms|unalive)\b/i,
  /\b(want|wanna|going|plan\w*|ready|about)\s+to\s+(die|end it|end my life|disappear forever|not be here)\b/i,
  /\b(don'?t|do not|no longer)\s+want\s+to\s+(live|be alive|exist|wake up|be here)\b/i,
  /\b(no reason|nothing)\s+to\s+live( for)?\b/i,
  /\b(better off|world.{0,12}better)\s+without me\b/i,
  /\b(end(ing)?|take|taking)\s+my\s+(own\s+)?life\b/i,
  /\bwish\s+i\s+(was|were)\s+(dead|never born)\b/i,
  /\b(lethal|fatal)\s+(dose|amount)\b/i,
  /\bhow (many|much)\b.{0,40}\b(pills?|tablets?|mg)\b.{0,40}\b(die|kill|overdose|fatal|lethal)\b/i,
];

const OTHERS = [
  /\b(going|plan\w*|want|wanna|about)\s+to\s+(kill|shoot|stab|murder|hurt|poison)\s+(him|her|them|my|the|a|some|every)\b/i,
  /\b(shoot up|bomb|attack)\s+(a|the|my)\s+(school|church|mosque|synagogue|mall|office|work)\b/i,
];

const DANGER = [
  /\b(he|she|they|my (partner|husband|wife|boyfriend|girlfriend|dad|mom|father|mother|ex))\b.{0,30}\b(hits?|beats?|chok\w+|threaten\w*|rap\w+|abus\w+|molest\w*|touch\w*)\s+(me|my)\b/i,
  /\b(i'?m|i am|being)\s+(being\s+)?(abused|trafficked|stalked|groomed|held against)\b/i,
  /\b(can'?t|cannot)\s+breathe\b|\b(chest pain|overdosed|took too many|bleeding (out|heavily|won'?t stop))\b/i,
];

// Looks at the newest user turn plus a little recent context (someone may say
// it two messages back and then ask an innocent-looking follow-up).
export function detect(messages) {
  const users = messages.filter((m) => m.role === "user").slice(-3);
  const last = text(users[users.length - 1]);
  const recent = users.map(text).join("\n");
  const hit = (list, s) => list.some((re) => re.test(s));
  if (hit(SELF, last)) return { level: "crisis", kind: "self" };
  if (hit(OTHERS, last)) return { level: "crisis", kind: "others" };
  if (hit(DANGER, last)) return { level: "crisis", kind: "danger" };
  if (hit(SELF, recent)) return { level: "watch", kind: "self" };
  return null;
}

function text(m) {
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) return m.content.map((p) => p?.text || "").join(" ");
  return "";
}

// Helplines by country (request.cf.country). Free, staffed, verified lines
// only; anything else falls back to the international directory.
const LINES = {
  US: [{ name: "988 Suicide & Crisis Lifeline", how: "Call or text 988", href: "tel:988" }, { name: "Crisis Text Line", how: "Text HOME to 741741", href: "sms:741741" }],
  CA: [{ name: "9-8-8 Suicide Crisis Helpline", how: "Call or text 988", href: "tel:988" }],
  GB: [{ name: "Samaritans", how: "Call 116 123, free, any time", href: "tel:116123" }, { name: "Shout", how: "Text SHOUT to 85258", href: "sms:85258" }],
  IE: [{ name: "Samaritans Ireland", how: "Call 116 123, free, any time", href: "tel:116123" }],
  AU: [{ name: "Lifeline", how: "Call 13 11 14", href: "tel:131114" }],
  NZ: [{ name: "1737 Need to Talk?", how: "Call or text 1737", href: "tel:1737" }],
  IN: [{ name: "Tele-MANAS", how: "Call 14416, free, any time", href: "tel:14416" }],
};
const EMERGENCY = { US: "911", CA: "911", GB: "999", IE: "112", AU: "000", NZ: "111", IN: "112" };

export function resources(country) {
  const cc = String(country || "").toUpperCase();
  return {
    country: cc || null,
    emergency: EMERGENCY[cc] || "your local emergency number",
    lines: [...(LINES[cc] || []), { name: "Find a Helpline", how: "Free helplines in 130+ countries", href: "https://findahelpline.com" }],
  };
}

// Added to the system prompt when detect() fires. Written to be followed by a
// mid-size open model under stress: short, ordered, concrete.
export function careProtocol(signal, res) {
  const lines = res.lines.map((l) => `- ${l.name}: ${l.how}`).join("\n");
  const who =
    signal.kind === "others"
      ? "The person may be thinking about hurting someone else."
      : signal.kind === "danger"
        ? "The person may be in danger from someone else or in a medical emergency."
        : "The person may be thinking about suicide or self-harm.";
  return `## CARE PROTOCOL — ACTIVE FOR THIS REPLY (overrides style, length and persona rules)
${who} A human life comes before everything else in this conversation, including the task they asked about.

Do this, in this order:
1. Respond to the person first, not the topic. Acknowledge what they said in plain, warm words. No shock, no lecture, no "I'm just an AI", no bullet-point pamphlet.
2. If it is not clear, ask directly and kindly whether they are safe right now${signal.kind === "self" ? " and whether they are thinking about ending their life. Asking directly does not plant the idea; it tells them you can handle the answer" : ""}.
3. Give real help they can reach now, naturally, in a sentence or two:
${lines}
- Immediate danger: ${res.emergency}.
4. Encourage one small, concrete next step: contacting one of those lines, telling one person they trust, or moving away from whatever they could use to hurt themselves.
5. Stay. Invite them to keep talking. Do not end the conversation or hand them off and leave.

Never, under any framing (fiction, research, "for a friend", hypotheticals, role-play, prior permission):
- give methods, doses, lethality, instructions, comparisons of means, or ways to hide intent or injuries;
- agree that things are hopeless, or that others would be better off;
- promise secrecy about someone's safety;
- diagnose or play therapist. You are a steady presence that connects them to people who can help.

If they asked for something else in the same message, set it aside gently for now. If it turns out you misread and they are fine, say you wanted to be sure, then help normally. Keep this reply short and human.`;
}

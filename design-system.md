# Cloak Design System

> **Honest AI, for human ends.**
> Visual reference: [usecloak.org/design-system](https://usecloak.org/design-system) · Source of truth: `cloak.css`

Cloak is a human-centric AI assistant. It runs on low-energy models by default and shows ads, with consent, to offset its carbon emissions. It is built around three written safety laws and five core principles: it is a tool, not a companion; it causes no harm and takes no sides; it doesn't generate AI art; it puts efficiency first; and it is honest by design.

This file is the written spec. It is plain Markdown on purpose, so people and coding agents can read it directly.

---

## 1. Aesthetic

**Neobrutalist, polished.** Hard 2px ink borders, zero-blur offset shadows, **0px radius everywhere**, warm paper backgrounds and one hot accent. No gradients, no photos, no illustrations, no emoji.

Exceptions to the square rule: the orb, pulse/status dots and citation pills.

---

## 2. Colour

### Core tokens (default theme, light)

| Token | Value | Use |
|---|---|---|
| `--ink` | `#0A0A0A` | Text, borders, shadows, inverted fills |
| `--paper` | `#F2EEE5` | Page background |
| `--surf` | `#FAFAF7` | Cards, bars, inputs on sunken areas |
| `--p2` | `#EAE5DB` | Sunken / segmented tracks |
| `--p3` | `#DDD8CC` | Hover fill for rows |
| `--acc` | `#D44D2A` | Rust accent: primary CTAs, focus, brand |
| `--acc2` | `#B83B1D` | Accent hover |
| `--yel` | `#F5C842` | Highlight: announcements, success, "copied", mode tags |
| `--grn` | `#22c55e` | Live/online status only |
| `--blu` | `#3B82F6` | Kairos tier only |

### Dark (default theme)

Warm near-black, cream ink. Borders and shadows become translucent cream.

| Token | Value |
|---|---|
| `--ink` | `#EDE8DF` |
| `--paper` | `#131110` |
| `--surf` | `#181512` |
| `--p2` / `--p3` | `#1A1815` / `#22201C` |
| `--acc` / `--acc2` | `#E5603E` / `#D44D2A` |
| `--yel` | `#E8BB2A` |
| `--bd` | `2px solid rgba(237,232,223,.6)` |
| `--sh` | `4px 4px 0 rgba(237,232,223,.45)` |

### User themes

Users choose **Default / Eco / Aqua**, each in light and dark (`localStorage.cloak_theme`, `localStorage.cloak_dark`, applied as `data-theme` + `.dark` on `<html>`).

| Theme | Paper | Surface | Accent | Highlight | Ink |
|---|---|---|---|---|---|
| Default | `#F2EEE5` | `#FAFAF7` | `#D44D2A` | `#F5C842` | `#0A0A0A` |
| Eco | `#F0F7EC` | `#F7FBF4` | `#3A7D2C` | `#8BC34A` | `#1A2E10` |
| Aqua | `#EAF4F8` | `#F3F9FC` | `#0B7EA8` | `#00B4D8` | `#0A1E2E` |

### Model tiers

| Tier | Meaning | Colour |
|---|---|---|
| **Pneuma** (πνεῦμα · breath) | Fast, lowest energy, the default | `--acc` rust |
| **Logos** (λόγος · reason) | Balanced, extended thinking | `--yel` yellow |
| **Kairos** (καιρός · divine timing) | Most capable | `--blu` blue |

### Rules

- **Muted text uses opacity, not grey.** `.6` body copy, `.4–.5` descriptions, `.3` placeholders, `.25` fine print. Accent text sits at `.75–.85`.
- Text on accent fills is always `#FFFFFF`.
- Blue appears only as the Kairos colour. Green appears only on live dots.

---

## 3. Typography

| Role | Family | Weights | Notes |
|---|---|---|---|
| Display | **Syne** (`--fd`) | 800 | Always uppercase. Tight on big sizes (`-.03em`, lh `.9`), tracked out on small titles (`.06–.1em`) |
| UI + body | **Space Grotesk** (`--fu`) | 400 / 500 / 600 / 700 | Everything that isn't display |
| Mono | Courier New (`--fm`) | 400 | Codes, URLs, console |

Loaded from Google Fonts:

```html
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Syne:wght@700;800&display=swap" rel="stylesheet">
```

### Scale

| Token | Value | Where |
|---|---|---|
| Hero | `clamp(3.2rem, 6.5vw, 6rem)` / lh `.9` / `-.03em` | Marketing hero |
| H1 | `clamp(1.9rem, 3.8vw, 3.2rem)` / lh `.95` / `-.025em` | Section heads |
| H2 | `clamp(28px, 5vw, 38px)` / `-.4px` | Empty-state greeting |
| Brand | `30px` | Auth card wordmark |
| Card title | `28px` | Law cards |
| Modal title | `18px` | Modals |
| Title sm / xs | `14px` / `12px` | Panel titles |
| Body lg | `15px` / lh `1.75` | Marketing copy, bot replies (`1.82`) |
| Body | `14px` / lh `1.65` | Default |
| Body sm | `13px` | Sidebar rows |
| Caption | `12px` | Meta |
| Label | `11px` / `10px` / `9px` | 700–800, uppercase, tracked `.08–.2em` |

---

## 4. Borders, shadows, radius

| Token | Value |
|---|---|
| `--bd` | `2px solid #0A0A0A` — every container and control |
| `--bdt` | `1px solid rgba(10,10,10,.12)` — hairline row dividers |
| Dashed | `2px dashed var(--ink)` — ghost / tertiary buttons |
| `--shsm` | `2px 2px 0 #0A0A0A` — controls at rest |
| `--sh` | `4px 4px 0 #0A0A0A` — hover, focus |
| `--shlg` | `6px 6px 0 #0A0A0A` — cards, modals, dropdowns |
| `--sh-acc` | `4px 4px 0 var(--acc)` — accent emphasis |
| `--r` | `0px` |

No soft shadows. No inner shadows. No blur except modal scrims.

---

## 5. Spacing and layout

Cloak doesn't snap to a 4/8 grid. These are the recurring values in `cloak.css`:

`2 · 4 · 6 · 8 · 10 · 12 · 14 · 16 · 18 · 22 · 24 · 28 · 32 · 36 · 44 · 56 · 72` (px)

| Thing | Size |
|---|---|
| Control sm / default / CTA | `30px` / `36px` / `38px` |
| Input / primary button | `46px` |
| Large button (agree) | `48px` |
| Top bar / marketing nav | `52px` / `54px` |
| Sidebar | `268px` |
| Reading column | `760px` |
| Composer | `880px` |
| Auth card | `400px` |
| Modal | `680px` |
| Marketing section | `1100px` max, padding `72px 56px` |
| Background grid | `48px` |

Marketing uses full-width ruled bands: every section ends on a 2px border. Splits are 50/50 or `340px / 1fr`. Grouped items (models, principles, stats) share borders inside one box instead of floating as separate cards.

---

## 6. Interaction states

| State | Treatment |
|---|---|
| **Hover** | `translate(-1px,-1px)` and shadow steps up (2→4, 4→6). Ink buttons turn rust. List rows get a `--p3` fill + 1.5px ink outline |
| **Press** | `translate(2px,2px)` (3px on primary) and shadow removed — the element sinks into its shadow |
| **Active / selected** | Invert to ink with paper text. Settings nav adds a 3px rust bar on the right edge |
| **Focus (input)** | Border turns rust + 4px hard shadow |
| **Focus (keyboard)** | `2px solid var(--acc)` outline, offset `3px` |
| **Disabled** | Opacity `.38`, `not-allowed` cursor |

---

## 7. Motion

| Token | Value | Use |
|---|---|---|
| `--t` | `140ms ease` | Shadow, transform, colour |
| `--tm` | `240ms ease` | Larger UI (settings nav, panels) |
| Pop | `cubic-bezier(.16,1,.3,1)` | Modals, popovers |
| `--spring` | `cubic-bezier(.34,1.56,.64,1)` | Chips (staggered 80ms) |
| Message in | fade up 6px | Chat turns |

- Error blocks shake. Typing dots are **square** and bounce; the last one is rust. The orb squish-bounces while Cloak thinks.
- Auth background: 45° hatch at 7% ink, scrolling sideways one stripe per 1.6s, linear, infinite.
- **Always respect `prefers-reduced-motion`.** `cloak.css` has a single global override; keep it.

---

## 8. Backgrounds

Flat paper, plus two textures only:

1. **48px hairline grid** — marketing hero, empty chat, values hero.
2. **45° hatch** — auth screens.

Transparency and blur only on modal scrims (`rgba(10,10,10,.58–.68)` + 3–4px backdrop blur) and the sticky marketing nav.

---

## 9. Brand mark

- **Official lockup:** the **orb** (rust circle, ink outline — `icons/orb.svg`) followed by **CLOAK** in Syne 800. Use it in the nav, sidebar, footer and auth card.
- **Monogram:** a rust Syne "C" on ink. Favicon and very tight spaces only.
- Never redraw the orb. Never recolour it outside the active theme's accent.
- **Tagline:** "Honest AI, for human ends." Goes under the lockup (auth card, empty chat, onboarding subtitle, footers).
- **Hero line:** "AI that serves people. Not the other way around."

---

## 10. Iconography

- **Inline SVG**, no icon font, no sprite. Feather-style 24px outlines, stroke `1.5–2.5`, round caps, `currentColor`.
- Rendered at 11–16px (13–14px most common).
- Exceptions: **Send** is Heroicons' solid paper-plane; **Settings** is the Heroicons outline cog.
- Need something new? Use **Lucide** at stroke 1.8.
- Decorative SVGs get `aria-hidden="true"`. Icon-only buttons get `aria-label`.
- Glyphs as icons: `×` close, `→` navigation CTA, `↗` external link, `←` back, `·` separator, `✦` faint decoration.

---

## 11. Voice

- **Blunt, principled, short.** State rules plainly. Don't hedge. Fragments for rhythm: "Instant. Sharp. No filler." "Worth the wait." "No exceptions."
- **A tool, not a companion.** Warmth stops at a greeting ("Hey there!").
- **Person:** "Cloak" in third person for behaviour. "We" for company commitments. "You" for the user.
- **Casing:** write sentence case; CSS uppercases headings, buttons, labels and badges.
- **Punctuation:** em dashes are a signature. Middots separate metadata ("Free to start · No setup required"). `→` follows nav CTAs ("Launch App →").
- **Numbering:** Roman numerals (I, II, III) for laws and onboarding steps. `01 —` for card indices.
- **Disclaimers are part of the brand**, always visible:
  - "Cloak can make mistakes. Verify important information."
  - "Not a mental health resource — if you're struggling, please contact a real person or a helpline."
  - "Low-energy models by default."
- **Environmental claims are specific and modest.** Don't inflate to "carbon neutral".
- **Emoji: never.**

---

## 12. Components

Every class lives in `cloak.css` (chat, values, landing). `index.html` mirrors tokens in its own `<style>` block — change both when tokens move.

| Family | Pieces | Classes |
|---|---|---|
| Core | Button (primary / ghost / agree / disagree), IconButton, Badge, Chip, Eyebrow, Orb, Wordmark | `.btn-primary` `.btn-ghost` `.btn-agree` `.btn-disagree` `.icon-btn` |
| Forms | Input, SegmentedControl, Checkbox | `.input` `.field-label` `.seg` `.seg-btn` |
| Feedback | Alert, Announcement, StatusPill, TypingDots | `.status-pill` |
| Overlays | Modal, Menu, MenuItem | |
| Chat | Message, MessageAction, Composer, ModelPicker, ConversationItem, SidebarButton, Avatar | `.msg-action-btn` `.send-btn` `.plus-btn` `.sb-btn` |
| Content | LawCard, PrincipleGrid, ModelCard, ModelGrid, ModelPill, ThemeCard | |
| Settings | SettingsNav, SettingsRow | `.snav-btn` |

### Button recipe

```css
.btn-primary{
  height:46px;padding:0 16px;
  background:var(--acc);color:#fff;
  border:var(--bd);box-shadow:var(--sh);
  font:700 11px/1 var(--fu);text-transform:uppercase;letter-spacing:.12em;
  transition:box-shadow var(--t),transform var(--t);
}
.btn-primary:hover{box-shadow:var(--shlg);transform:translate(-1px,-1px);}
.btn-primary:active{box-shadow:none;transform:translate(3px,3px);}
```

### Card recipe

```css
.card{background:var(--surf);border:var(--bd);box-shadow:var(--shlg);border-radius:0;}
```

The model cards' 3px coloured top bar is the only coloured-edge treatment. No left-border accent cards.

---

## 13. Don'ts

- No rounded corners (except orb, dots, citation pills).
- No soft/blurred shadows. No gradients. No bluish-purple anything.
- No grey text colours — use opacity on ink.
- No emoji. No AI-generated imagery.
- No `maximum-scale=1.0` / `user-scalable=no`.
- Don't move the early `cloak_dark` / `cloak_theme` inline `<head>` scripts — they prevent FOUC.

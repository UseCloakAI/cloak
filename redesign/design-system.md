# Cloak Design System v3: Plain Sight

> **Status: prototype. Not live.** Nothing in `redesign/` is loaded by `chat.html`, `index.html` or any production page. The live spec is still `/design-system.md` (v2, neobrutalist) until this ships.
> Visual reference: `redesign/system.html` · Source of truth: `redesign/ds.css`

Cloak is honest AI, so the interface hides nothing. Calm surfaces, one accent, real hierarchy, and motion that only moves when something changed.

Kept from v2: the name, the orb, the rust accent, the three themes, the safety laws and principles, all copy and the whole IA (Chat / Brain / Settings / Values in one shell, the sidebar rail, `goPage`). Changed: the visual language.

---

## 1. Principles

1. **Calm, then clear.** Nothing moves on its own. Arrivals come into focus; the orb breathes only while Cloak is working; every animation answers a change.
2. **One accent.** Slate neutrals plus a single accent per theme. Models differ by **shape**, not color.
3. **Press round, hold square.** Controls are pills and circles. Containers are soft squares. Nested corners shrink by the padding.
4. **Real contrast.** Muted text is a real ink step, AA on every surface, in both modes. No opacity-on-ink.
5. **Same parts everywhere.** The landing page is built from the app's components. If it is on the marketing site, it exists in the product.

---

## 2. Color

### Neutrals (all themes)

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#F3F4F5` | `#0F1114` | Page, sidebar |
| `--surface` | `#FBFBFC` | `#15181C` | Cards, main app area, composer |
| `--raised` | `#FFFFFE` | `#1C2025` | Menus, popovers, switch knobs |
| `--surface-2` | `#EAECEF` | `#1B1F24` | Sunken: tracks, wells, code, user bubbles |
| `--surface-3` | `#DFE2E6` | `#242930` | Sunken hover, off-state switches |
| `--line` | ink at 9% | ink at 8% | 1px inner edges, dividers |
| `--line-2` | ink at 16% | ink at 15% | Input and chip edges |

### Ink

| Token | Light | Dark | Contrast on `--bg` |
|---|---|---|---|
| `--ink` | `#16181D` | `#ECEDEF` | 16:1 |
| `--ink-2` | `#4B515C` | `#A2A8B2` | 7.3:1 / 7.9:1 |
| `--ink-3` | `#646B77` | `#878E99` | 4.9:1 / 5.4:1 (captions, meta, placeholders) |

### Accent themes

Each theme is one accent with a light and a dark value. Neutrals never change.

| Theme | Light fill | Dark fill | Text on fill |
|---|---|---|---|
| **Rust** (default) | `#C2421F` (5.0:1 with `#FCFCFB`) | `#F06A42` (5.8:1 with `#16181D`) | off-white light / ink dark |
| **Moss** (was Eco) | `#2F6F3A` | `#5DBB6A` | same rule |
| **Tide** (was Aqua) | `#0A6F93` | `#38B3DB` | same rule |

Derived: `--accent-hi` (hover), `--accent-ink` (accent text on surfaces, AA), `--accent-soft` (9 to 12% tint), `--accent-line` (28% edge).

Status: `--danger` `#B42318` / `#F97066`, `--ok` `#1F7A45` / `#47CD89`. Used only for errors, destructive actions and log states.

### Rules

- One accent per page, used identically everywhere.
- Models are marked by shape (§9), never by their own color. v2's yellow Logos and blue Kairos are retired.
- No gradients except the skeleton shimmer. No glows. No pure black or pure white.

---

## 3. Type

| Role | Family | Weights | Notes |
|---|---|---|---|
| Display | **Bricolage Grotesque** (`--fd`) | 600 to 650 | Headlines, numerals, page titles. Tight tracking (-.018 to -.035em). `font-optical-sizing: auto` |
| Text + UI | **Geist** (`--fu`) | 400 / 500 / 550 | Body, labels, buttons |
| Mono | **Geist Mono** (`--fm`) | 400 to 500 | Code, file paths, memory files, logs |

Self-hosted variable woff2 in `redesign/fonts/` (OFL), preloaded. No Google Fonts link.

**Sentence case everywhere.** No uppercase headings, buttons or labels. The wordmark is lowercase.

| Class | Size / line-height | Where |
|---|---|---|
| `.t-hero` | 44 to 80px / 1.02 | Landing hero, closing |
| `.t-d1` | 36 to 56px / 1.05 | Section heads |
| `.t-d2` | 28 to 40px / 1.1 | Sub-heads, panel headlines |
| `.t-d3` | 24px / 1.2 | Settings groups, laws |
| `.t-title` | 18px / 1.35 | Page titles in the topbar, card titles |
| `.t-lead` | 18px / 1.6 | Intro paragraphs (60ch) |
| `.t-body` | 16px / 1.6 | Body (65ch). App base is 15px |
| `.t-small` | 14px | Rows, secondary |
| `.t-cap` | 13px / 1.5 | Meta, disclaimers |
| `.eyebrow` | 13px / 500, accent | The only label style. Max one per three sections |

---

## 4. Shape

| Token | Value | Use |
|---|---|---|
| `--r-ctl` | `999px` | Buttons, chips, switches, segmented, icon buttons (circles), tags |
| `--r-card` | `20px` | Cards, panels, composer (24px), menus (16px) |
| `--r-in` | `12px` | One level inside a card: fields, rows, wells, code |
| `--r-xs` | `8px` | Two levels in: kbd, tooltip |

Edges are a 1px **inner** line (`box-shadow: inset 0 0 0 1px var(--line)`), not a border, so they never shift layout.

## 5. Depth

| Token | Use |
|---|---|
| `--sh-1` | Rest: cards, secondary buttons, active nav pill |
| `--sh-2` | Hover, composer, popovers that sit close |
| `--sh-3` | Menus, panels, toasts, the hero demo |

Shadows are tinted to the neutral. In dark mode they get darker and every surface keeps its inner line.

---

## 6. Spacing and layout

4px grid: `4 8 12 16 20 24 32 40 48 64 80 96`.

| Thing | Size |
|---|---|
| Controls | 36 sm · 44 default · 52 lg |
| Fields | 46 |
| Marketing max width | 1200, gutter 16 to 40 |
| Reading column (chat) | 760 |
| Sidebar / rail / topbar | 272 / 72 / 60 |
| Section padding | 64 to 112 |

---

## 7. Motion

**Calm, then clear.** Every animation answers a change. Under `prefers-reduced-motion` everything is instant (one global override in `ds.css`).

| Token | Value | Use |
|---|---|---|
| `--d-1` | 120ms | Color, opacity |
| `--d-2` | 220ms | Hover, press, toggles |
| `--d-3` | 420ms | Menus, panels, page enters |
| `--d-4` | 760ms | Section reveals |
| `--ease-out` | `cubic-bezier(.16,1,.3,1)` | Entrances |
| `--ease-io` | `cubic-bezier(.65,0,.35,1)` | Theme grow, breath |
| `--ease-in` | `cubic-bezier(.5,0,.75,0)` | Exits |
| `--spring` | `linear()` spring, cubic-bezier fallback | Switch knobs, slider thumbs, segmented thumbs, menus |

Signature moves:

- **Focus.** Things arrive by coming into focus: opacity 0, 14px down, 6 to 8px blur, to sharp. Sections (`[data-reveal]`, IntersectionObserver), page enters, streamed words (`.tk`, blur 4px only).
- **Breath.** The orb scales gently (`.orb.is-working`) while Cloak is thinking or writing, and stops the moment it's done. It is the only looping animation, and it means something.
- **Grow.** Theme and mode changes grow out of the control that asked as a circle (View Transitions). The orb's shape, replacing v2's hard-edged wipe.
- **Press.** `scale(.97)` in 60ms. Hover lifts 1px with one shadow step. No hard-offset slams.
- **Glide.** The sidebar's current-page pill glides between Chat and Brain on the spring; segmented thumbs and the Effort thumb do the same.
- **Travel.** In an empty chat the composer sits in the middle under the greeting; on first send it travels to the bottom (FLIP).

Banned: scroll listeners (use IntersectionObserver / `animation-timeline: view()`), infinite decorative loops, custom cursors.

---

## 8. Backgrounds

Flat. One pattern only: a 16px dot grid, used on at most one tile per page. No hatch, no 48px grid, no noise.

---

## 9. Brand

- **Lockup:** the orb (flat accent disc, no outline) + lowercase **cloak** in Bricolage 700, -0.045em.
- **The big orb** is the page's one large shape: the hero sun behind the live demo, the closing sunrise (rises with scroll via `animation-timeline: view()`), the auth panel.
- **Tier marks** (`.tier-*`): Kairos = solid accent disc, Linus = ink rounded square, Pneuma = ring. Shape, not color.
- **Tagline:** "Honest AI, for human ends." **Hero line:** "AI that serves people. Not the other way around."
- No AI-generated imagery, ever (it's one of Cloak's principles). Product visuals are live components, not screenshots.

## 10. Icons

[Phosphor](https://phosphoricons.com) Regular (MIT), as an SVG sprite: `redesign/icons.svg`, used with `<svg class="icon"><use href="icons.svg#name"/></svg>`. 20px in controls, 16 to 18px in dense rows. Decorative icons get `aria-hidden="true"`; icon-only buttons get `aria-label`. To add one: copy the symbol from `@phosphor-icons/core/assets/regular/<name>.svg`. Don't hand-draw icons.

---

## 11. Voice

Unchanged from v2 except punctuation and casing:

- Blunt, principled, short. "Instant. Sharp. No filler."
- "Cloak" in third person for behavior, "we" for commitments, "you" for the user.
- **No em dashes.** Use a period, comma, colon or parentheses. (v2 used them as a signature; v3 retires them.)
- **Middots are rationed** to metadata (one per line).
- **Sentence case** in markup and in rendering.
- Roman numerals stay for the three laws, because the order is the point.
- Disclaimers stay visible: "Cloak can make mistakes. Verify important information." / "Not a mental health resource. If you're struggling, please contact a real person or a helpline." / "Low-energy models by default."
- Emoji: never.

---

## 12. Components (`ds.css`)

| Family | Classes |
|---|---|
| Buttons | `.btn` + `.btn-primary` `.btn-secondary` `.btn-ink` `.btn-ghost` `.btn-danger`, sizes `.btn-sm` `.btn-lg`, `.btn-icon`, `.is-loading`, `[disabled]` |
| Chips, tags | `.chip` (`.is-on`), `.tag` (`.tag-acc`), `.kbd`, `.cite` |
| Forms | `.field` > `.label` + `.input` + `.help` + `.err` (`.field.is-invalid`), `.input-wrap` |
| Toggles | `.switch[role=switch][aria-checked]`, `.seg` (sliding thumb via `DS.initSeg`) |
| Surfaces | `.card`, `.panel`, `.well`, `.hr` |
| Overlays | `.menu` (`.is-open`, `data-menu` triggers), `.menu-item`, `.toast` (`DS.toast`), `.tip` (`data-tip`) |
| Loading | `.skel` (shape of the content), `.orb.is-working` |
| Chat | `.msg` `.msg-user` `.bubble` `.msg-cloak` `.msg-head` `.prose` `.msg-actions` `.tk`, `.composer`, `.send` (`.is-stop`) |
| Product | `.effort` (`DS.effort(el,{onChange})`, values mirror `effort.js`), `.tier-kairos/-linus/-pneuma`, `.lockup`, `.orb` |

States every control has: rest, hover, press, focus-visible (2px accent ring, 2px offset), disabled, and where relevant loading, error, empty.

---

## 13. Don'ts

- No hard offset shadows, 2px ink borders or 0px radius (v2).
- No uppercase headings, buttons or labels.
- No second accent, no per-model colors, no gradients, no glows.
- No grey-by-opacity text: use `--ink-2` / `--ink-3`.
- No em dashes. No emoji. No AI-generated imagery.
- No `maximum-scale` / `user-scalable=no`.
- Keep the early theme script in `<head>` (prevents a flash).

---

## 14. Rollout plan (when we ship it)

1. Move `ds.css` tokens into `cloak.css` `:root` (replace v2 tokens) and mirror them into `index.html`, per the CLAUDE.md sync rule.
2. Map v2 themes: `default` to Rust, `eco` to Moss, `aqua` to Tide. Keep the `cloak_theme` / `cloak_dark` keys (the prototype uses `cloak_rd_*` so it never touches the live app).
3. Swap Syne / Space Grotesk for the self-hosted fonts; move `redesign/fonts` and `icons.svg` to the root, add them to `SHELL` in `sw.js`.
4. Restyle component by component in `cloak.css` / `brain.css` / `builds.css` / `search.css`, keeping every ID and `onclick` in `chat.html` (it's on the don't-touch list for structure).
5. Replace the `motion.js` uncloak / stamp / crop-cursor moves with focus / breath / grow.
6. Port `index.html`, `landing.html`, `values.html`, `design-system.html`. Point CTAs back at `https://chat.usecloak.org`.
7. Update `/design-system.md` from this file and delete `redesign/`.

# redesign/ (prototype, not live)

Cloak v3 "Plain Sight": a full redesign of the design system and the main surfaces, built as a standalone prototype. Nothing here is linked from or loaded by production pages, every page is `noindex`, and it uses its own localStorage keys (`cloak_rd_*`), so it can't affect the live app.

| File | What |
|---|---|
| `index.html` + `landing.css` + `landing.js` | Landing page redesign. Hero demo, models, effort, memory, laws and principles are live components with sample data |
| `app.html` + `app.css` + `app.js` | App shell: sidebar with icon rail (drawer on phones), Chat (empty, thread, streaming, stop), Brain (memories, context), Settings (general, appearance, security, console), Values, and the sign-in screen (`app.html#auth`) |
| `system.html` | Visual design system reference, live tokens and components |
| `design-system.md` | Written spec + rollout plan |
| `ds.css` / `ds.js` | The system: tokens, components, theme + mode, reveals, menus, toasts, Effort slider |
| `icons.svg` | Phosphor Regular sprite (MIT, `LICENSE-phosphor.txt`) |
| `fonts/` | Bricolage Grotesque, Geist, Geist Mono (OFL), self-hosted |

## View it

```bash
npx wrangler pages dev . --port 8788
```

Then open `/redesign/`. The "Prototype" pill switches between Landing, App, Sign in and System. In the prototype, "Open Cloak" links to `app.html`; on ship it goes back to `https://chat.usecloak.org`.

Sign-in demo: any email works; the password `wrong` shows the error state. Chat replies are canned.

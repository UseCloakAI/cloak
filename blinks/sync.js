/* Optional accounts for the preview. Signs in with an existing Cloak account
   (same Supabase project, publishable anon key, RLS) and keeps chats in the
   preview's own table, pv_chats. Production tables are never touched.
   If the table does not exist yet (migration not applied) or the library
   fails to load, the app simply stays local. */
(function () {
  "use strict";
  var SB_URL = "https://kdawsqrrmwirilyhcolk.supabase.co";
  var SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtkYXdzcXJybXdpcmlseWhjb2xrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5NjUxNjAsImV4cCI6MjA4OTU0MTE2MH0.cMN9V51J3042DrdaDmL7-ro-AMaw-IU47wQLnW2NMBE";
  var LIB = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js";
  var sb = null, user = null, hooks = null, ok = true, host = null;

  function lib() {
    return new Promise(function (resolve, reject) {
      if (window.supabase) return resolve();
      var s = document.createElement("script");
      s.src = LIB; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  function client() {
    if (sb) return Promise.resolve(sb);
    return lib().then(function () {
      sb = window.supabase.createClient(SB_URL, SB_KEY, { auth: { persistSession: true, autoRefreshToken: true, storageKey: "pv_auth" } });
      return sb;
    });
  }
  function row(c) { return { id: c.id, user_id: user.id, companion: c.companion, title: c.title || "", messages: c.messages, updated_at: new Date(c.updated).toISOString() }; }

  async function pull() {
    if (!user || !ok) return;
    var r = await sb.from("pv_chats").select("id, companion, title, messages, updated_at").order("updated_at", { ascending: false }).limit(40);
    if (r.error) { ok = false; return; }
    hooks.onChats(r.data.map(function (d) { return { id: d.id, companion: d.companion, title: d.title, messages: d.messages || [], updated: Date.parse(d.updated_at) }; }));
    // Anything made on this device before signing in goes up too.
    var local = hooks.local().filter(function (c) { return c.messages.length; });
    if (local.length) await sb.from("pv_chats").upsert(local.map(row));
  }

  function render() {
    if (!host) return;
    if (user) {
      host.innerHTML = '<p class="lbl">Account</p><p class="help" style="margin:0 0 10px">Signed in as ' + Kit.esc(user.email || "") + (ok ? ". Chats sync across your devices." : ". Sync is not set up on the server yet, so chats stay on this device.") + '</p><button type="button" class="btn btn-ghost btn-sm" id="pvOut">Sign out</button>';
      host.querySelector("#pvOut").addEventListener("click", function () { sb.auth.signOut().then(function () { user = null; render(); }); });
      return;
    }
    host.innerHTML =
      '<p class="lbl">Account (optional)</p><p class="help" style="margin:0 0 10px">Sign in with your Cloak account to keep chats across devices. Without it, everything stays on this device.</p>' +
      '<div style="display:grid;gap:10px"><div><label class="lbl" for="pvEmail">Email</label><input class="field" id="pvEmail" type="email" autocomplete="email"></div>' +
      '<div><label class="lbl" for="pvPass">Password</label><input class="field" id="pvPass" type="password" autocomplete="current-password"></div>' +
      '<p class="err" id="pvErr" hidden></p><div><button type="button" class="btn btn-ghost btn-sm" id="pvIn">Sign in</button></div></div>';
    host.querySelector("#pvIn").addEventListener("click", async function () {
      var err = host.querySelector("#pvErr"), btn = this;
      err.hidden = true; btn.disabled = true;
      try {
        await client();
        var r = await sb.auth.signInWithPassword({ email: host.querySelector("#pvEmail").value.trim(), password: host.querySelector("#pvPass").value });
        if (r.error) throw r.error;
        user = r.data.user; ok = true;
        await pull();
        render();
      } catch (e) {
        err.textContent = e && e.message ? e.message : "Could not sign in. Check your connection and try again.";
        err.hidden = false; btn.disabled = false;
      }
    });
  }

  window.Sync = {
    init: function (h) {
      hooks = h;
      // Only load the library up front if a session was saved earlier.
      if (!Kit.get("pv_auth")) return;
      client().then(function () { return sb.auth.getSession(); }).then(function (r) {
        user = r.data.session ? r.data.session.user : null;
        if (user) pull();
      }).catch(function () {});
    },
    push: function (c) { if (user && ok && sb) sb.from("pv_chats").upsert(row(c)).then(function (r) { if (r.error) ok = false; }); },
    remove: function (id) { if (user && ok && sb) sb.from("pv_chats").delete().eq("id", id).then(function () {}); },
    renderAccount: function (el) { host = el; render(); },
  };
})();

/* Accounts for Cloak Blinks. Blinks uses your Cloak account (same Supabase
   project, same email and password) and needs it: nothing works signed out.
   Chats live in pv_chats and your Blinks in pv_bots, both protected by row
   level security so each person only ever sees their own. The home-PC brain
   keeps its own copy of chats; Supabase is the main one.

   Sync.ready()            Promise<user | null> once the saved session is checked
   Sync.gate(onIn)         shows the sign-in screen, calls onIn(user) after
   Sync.token()            Promise<access token> (refreshed when needed)
   Sync.init(hooks)        pulls chats and Blinks after sign-in
   Sync.push(chat) / remove(id) / pushBots(list)
   Sync.renderAccount(el)  the Account block in Settings */
(function () {
  "use strict";
  var SB_URL = "https://kdawsqrrmwirilyhcolk.supabase.co";
  var SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtkYXdzcXJybXdpcmlseWhjb2xrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5NjUxNjAsImV4cCI6MjA4OTU0MTE2MH0.cMN9V51J3042DrdaDmL7-ro-AMaw-IU47wQLnW2NMBE";
  var LIB = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js";
  var RESET = "https://chat.usecloak.org";
  var sb = null, user = null, hooks = null, host = null;

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
      sb.auth.onAuthStateChange(function (ev, s) { user = s ? s.user : null; });
      return sb;
    });
  }
  function row(c) { return { id: c.id, user_id: user.id, companion: c.companion, title: c.title || "", messages: c.messages, updated_at: new Date(c.updated).toISOString() }; }

  async function pull() {
    if (!user || !hooks) return;
    var r = await sb.from("pv_chats").select("id, companion, title, messages, updated_at").order("updated_at", { ascending: false }).limit(60);
    if (!r.error) hooks.onChats(r.data.map(function (d) { return { id: d.id, companion: d.companion, title: d.title, messages: d.messages || [], updated: Date.parse(d.updated_at) }; }));
    // Anything made on this device before signing in goes up too.
    var local = hooks.local().filter(function (c) { return c.messages.length; });
    if (local.length) await sb.from("pv_chats").upsert(local.map(row));
    var b = await sb.from("pv_bots").select("bots, updated_at").maybeSingle();
    if (!b.error && hooks.onBots) hooks.onBots((b.data && b.data.bots) || []);
  }

  // ── The sign-in screen ──────────────────────────────────────────────
  function gate(onIn) {
    var el = document.getElementById("gate");
    el.hidden = false;
    document.documentElement.classList.add("gated");
    var fig = null;
    if (window.Creatures && !el.querySelector(".gate-fig svg")) fig = Creatures.mount(el.querySelector(".gate-fig"), "cloak", { mood: "listen", label: "Cloak" });
    var mode = "in";
    var f = function (id) { return el.querySelector("#" + id); };
    function draw() {
      f("gTitle").textContent = mode === "in" ? "Sign in to Blinks" : "Make your Cloak account";
      f("gSub").textContent = mode === "in" ? "Blinks uses your Cloak account. Same email, same password." : "One account for Cloak and Blinks. It takes a minute.";
      f("gNameRow").hidden = mode === "in";
      f("gGo").textContent = mode === "in" ? "Sign in" : "Create account";
      f("gSwap").textContent = mode === "in" ? "New to Cloak? Make an account" : "Already have an account? Sign in";
      f("gPw").autocomplete = mode === "in" ? "current-password" : "new-password";
      f("gErr").hidden = true;
    }
    function err(t) { f("gErr").textContent = t; f("gErr").hidden = false; if (fig) fig.nod(); }
    f("gSwap").onclick = function () { mode = mode === "in" ? "up" : "in"; draw(); };
    f("gReset").href = RESET;
    el.querySelector("form").onsubmit = async function (e) {
      e.preventDefault();
      var em = f("gEm").value.trim(), pw = f("gPw").value, nm = f("gName").value.trim();
      if (!em || !pw) return err("Enter your email and password.");
      if (mode === "up" && pw.length < 8) return err("Use at least 8 characters for your password.");
      f("gGo").disabled = true;
      if (fig) fig.set("think");
      try {
        await client();
        var r = mode === "in"
          ? await sb.auth.signInWithPassword({ email: em, password: pw })
          : await sb.auth.signUp({ email: em, password: pw, options: { data: { display_name: nm || em.split("@")[0] } } });
        if (r.error) throw r.error;
        if (!r.data.session) {
          f("gGo").disabled = false;
          if (fig) fig.set("happy");
          mode = "in"; draw();
          return err("Check your email to confirm your account, then sign in here.");
        }
        user = r.data.user;
        if (fig) fig.cheer();
        setTimeout(function () {
          el.hidden = true;
          document.documentElement.classList.remove("gated");
          if (fig) fig.destroy();
          onIn(user);
        }, 450);
      } catch (x) {
        f("gGo").disabled = false;
        if (fig) fig.set("listen");
        var m = x && x.message ? x.message : "";
        err(/invalid login/i.test(m) ? "That email and password don't match a Cloak account." : /already registered/i.test(m) ? "That email already has a Cloak account. Sign in instead." : m || "Could not reach Cloak. Check your connection and try again.");
      }
    };
    draw();
    setTimeout(function () { f("gEm").focus(); }, 60);
  }

  function render() {
    if (!host || !user) return;
    host.innerHTML = '<p class="lbl">Account</p><p class="help" style="margin:0 0 10px">Signed in as ' + Kit.esc(user.email || "") + ". Your chats and Blinks sync across your devices.</p>" +
      '<button type="button" class="btn btn-ghost btn-sm" id="pvOut">Sign out</button>';
    host.querySelector("#pvOut").addEventListener("click", function () {
      sb.auth.signOut().then(function () {
        // This device forgets everything that belonged to the account.
        ["pv_chats", "pv_bots", "pv_companion"].forEach(function (k) { try { localStorage.removeItem(k); } catch (e) {} });
        location.reload();
      });
    });
  }

  window.Sync = {
    ready: function () {
      return client().then(function () { return sb.auth.getSession(); }).then(function (r) {
        user = r.data.session ? r.data.session.user : null;
        return user;
      }).catch(function () { return null; });
    },
    gate: gate,
    user: function () { return user; },
    token: function () {
      if (!sb) return Promise.resolve(null);
      return sb.auth.getSession().then(function (r) { return r.data.session ? r.data.session.access_token : null; });
    },
    init: function (h) { hooks = h; if (user) pull().catch(function () {}); },
    push: function (c) { if (user && sb) sb.from("pv_chats").upsert(row(c)).then(function () {}); },
    remove: function (id) { if (user && sb) sb.from("pv_chats").delete().eq("id", id).then(function () {}); },
    pushBots: function (list) { if (user && sb) sb.from("pv_bots").upsert({ user_id: user.id, bots: list.slice(0, 12), updated_at: new Date().toISOString() }).then(function () {}); },
    renderAccount: function (el) { host = el; render(); },
    signOut: function () {
      return (sb ? sb.auth.signOut() : Promise.resolve()).then(function () {
        ["pv_chats", "pv_bots", "pv_companion", "pv_synced", "pv_unread"].forEach(function (k) { try { localStorage.removeItem(k); } catch (e) {} });
        location.reload();
      });
    },
  };
})();

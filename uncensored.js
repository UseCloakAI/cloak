/* ════════════════════════════════════════════════════════
   UNCENSORED MODE  (Settings → General)
   Locked behind an access code that only the Worker knows. A correct code
   (POST /v1/unlock) returns a signed token, kept in localStorage; while the
   toggle is on, streamChat (search-patch.js) sends it as `unlock` and the
   Worker routes the chat to the unfiltered models. Rotating UNCENSORED_CODE on
   the Worker locks every device again.
   ════════════════════════════════════════════════════════ */
window.CloakUncensored = (() => {
  const TOKEN = 'cloak_unlock', ON = 'cloak_uncensored';
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
    del(k) { try { localStorage.removeItem(k); } catch (_) {} },
  };
  const $ = (id) => document.getElementById(id);
  const toast = (m) => { const b = window.CloakBrain; if (b && b.toast) b.toast(m); };

  // The token's first part is its expiry (ms); the Worker is what really checks it.
  function unlocked() {
    const t = store.get(TOKEN);
    return !!t && Number(t.split('.')[0]) > Date.now();
  }
  function on() { return unlocked() && store.get(ON) === '1'; }
  // The token to send with chat requests, or null when the mode is off.
  function token() { return on() ? store.get(TOKEN) : null; }

  function render() {
    if (!unlocked()) { store.del(TOKEN); store.del(ON); }
    const open = unlocked(), active = on();
    const show = (id, v) => { const el = $(id); if (el) el.style.display = v ? '' : 'none'; };
    show('unc-locked', !open);
    show('unc-unlocked', open);
    const state = $('unc-state'); if (state) state.textContent = active ? 'On' : open ? 'Off' : 'Locked';
    const tg = $('unc-toggle'); if (tg) tg.textContent = active ? 'Turn off' : 'Turn on';
    const pill = $('unc-pill'); if (pill) pill.hidden = !active;
    document.documentElement.toggleAttribute('data-unc', active);
  }

  function reveal() {
    const f = $('unc-form'); if (!f) return;
    f.style.display = '';
    const c = $('unc-code'); if (c) c.focus();
  }

  function fail(msg) {
    const e = $('unc-err'); if (!e) return;
    e.textContent = msg; e.classList.add('show');
  }

  async function submit() {
    const err = $('unc-err'); if (err) err.classList.remove('show');
    const code = ($('unc-code') || {}).value || '';
    if (!($('unc-age') || {}).checked) return fail('Confirm you are 18 or older.');
    if (!code.trim()) return fail('Enter the access code.');
    const btn = $('unc-go'); if (btn) btn.disabled = true;
    try {
      const res = await fetch(CLOAK_API + '/v1/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim() }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d.token) return fail(d.error || 'Could not unlock right now.');
      store.set(TOKEN, d.token);
      store.set(ON, '1');
      $('unc-code').value = ''; $('unc-age').checked = false;
      const f = $('unc-form'); if (f) f.style.display = 'none';
      render();
      toast('Uncensored mode on');
    } catch (_) {
      fail('Could not reach Cloak. Try again.');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function toggle() {
    if (!unlocked()) return render();
    store.set(ON, on() ? '0' : '1');
    render();
    toast(on() ? 'Uncensored mode on' : 'Uncensored mode off');
  }

  function lock() {
    store.del(TOKEN); store.del(ON);
    render();
    toast('Uncensored mode locked');
  }

  // The Worker refused our token (expired or code rotated): lock and say so.
  function expired() {
    store.del(TOKEN); store.del(ON);
    render();
    toast('Uncensored access expired. Unlock it again in Settings.');
  }

  document.addEventListener('DOMContentLoaded', render);
  return { on, token, reveal, submit, toggle, lock, expired };
})();

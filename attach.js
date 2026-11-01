/* ════════════════════════════════════════════════════════
   CLOAK ATTACH — any file in, up to 25MB (CloakAttach)
   Turns a file into something a text model can read, and uploads the bytes
   so builds and agents can load the real file by URL (/v1/upload → /v1/blob).
     MIDI  → tempo, tracks, instruments and a note-by-note listing
     audio → duration, channels, sample rate, loudness over time
     PDF   → its text (pdf.js, lazy)
     zip / docx / xlsx / pptx / epub → file list + the text inside
     anything else → type, size, magic bytes, hex head
   Used by builds.js addFiles(). No deps; pdf.js loads only for PDFs.
   ════════════════════════════════════════════════════════ */
(function () {
  const API = 'https://api.usecloak.org';
  const MAX = 25 * 1024 * 1024;
  const kb = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
  const ext = (name) => (String(name).match(/\.([\w]+)$/) || [])[1]?.toLowerCase() || '';

  async function upload(file) {
    const r = await fetch(API + '/v1/upload', { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': file.name }, body: file });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.url) throw new Error(d.error || 'upload failed (' + r.status + ')');
    return d.url;
  }

  /* ── MIDI ── */
  const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const noteName = (n) => NOTE[n % 12] + (Math.floor(n / 12) - 1);
  const GM = ['Acoustic Grand Piano','Bright Piano','Electric Grand','Honky-tonk','E.Piano 1','E.Piano 2','Harpsichord','Clavinet','Celesta','Glockenspiel','Music Box','Vibraphone','Marimba','Xylophone','Tubular Bells','Dulcimer','Drawbar Organ','Perc. Organ','Rock Organ','Church Organ','Reed Organ','Accordion','Harmonica','Bandoneon','Nylon Guitar','Steel Guitar','Jazz Guitar','Clean Guitar','Muted Guitar','Overdrive Guitar','Distortion Guitar','Guitar Harmonics','Acoustic Bass','Finger Bass','Pick Bass','Fretless Bass','Slap Bass 1','Slap Bass 2','Synth Bass 1','Synth Bass 2','Violin','Viola','Cello','Contrabass','Tremolo Strings','Pizzicato','Harp','Timpani','Strings','Slow Strings','Synth Strings 1','Synth Strings 2','Choir Aahs','Voice Oohs','Synth Voice','Orchestra Hit','Trumpet','Trombone','Tuba','Muted Trumpet','French Horn','Brass','Synth Brass 1','Synth Brass 2','Soprano Sax','Alto Sax','Tenor Sax','Baritone Sax','Oboe','English Horn','Bassoon','Clarinet','Piccolo','Flute','Recorder','Pan Flute','Bottle','Shakuhachi','Whistle','Ocarina','Square Lead','Saw Lead','Calliope Lead','Chiff Lead','Charang','Voice Lead','Fifths Lead','Bass+Lead','New Age Pad','Warm Pad','Polysynth','Choir Pad','Bowed Pad','Metallic Pad','Halo Pad','Sweep Pad','Rain','Soundtrack','Crystal','Atmosphere','Brightness','Goblins','Echoes','Sci-fi','Sitar','Banjo','Shamisen','Koto','Kalimba','Bagpipe','Fiddle','Shanai','Tinkle Bell','Agogo','Steel Drums','Woodblock','Taiko','Melodic Tom','Synth Drum','Reverse Cymbal','Fret Noise','Breath','Seashore','Bird','Telephone','Helicopter','Applause','Gunshot'];
  function parseMidi(buf) {
    const d = new DataView(buf); let p = 0;
    const str = (n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(d.getUint8(p + i)); p += n; return s; };
    const u32 = () => { const v = d.getUint32(p); p += 4; return v; };
    const u16 = () => { const v = d.getUint16(p); p += 2; return v; };
    const vlq = () => { let v = 0, b; do { b = d.getUint8(p++); v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };
    if (str(4) !== 'MThd') throw new Error('not a MIDI file');
    const hl = u32(), format = u16(), ntr = u16(), div = u16(); p += hl - 6;
    const ppq = div & 0x8000 ? 480 : div;
    const tempos = [], sigs = [], tracks = [];
    for (let t = 0; t < ntr && p < d.byteLength; t++) {
      if (str(4) !== 'MTrk') break;
      const end = u32() + p;
      let tick = 0, run = 0; const tr = { name: '', programs: {}, notes: [], open: {} };
      while (p < end) {
        tick += vlq();
        let st = d.getUint8(p);
        if (st & 0x80) { p++; if (st < 0xf0) run = st; } else st = run;
        const type = st & 0xf0, ch = st & 0x0f;
        if (st === 0xff) {
          const mt = d.getUint8(p++), len = vlq(), at = p;
          if (mt === 0x03) tr.name = str(len); else p += len;
          if (mt === 0x51) tempos.push({ tick, bpm: Math.round(60000000 / ((d.getUint8(at) << 16) | (d.getUint8(at + 1) << 8) | d.getUint8(at + 2))) });
          if (mt === 0x58) sigs.push({ tick, sig: d.getUint8(at) + '/' + (1 << d.getUint8(at + 1)) });
          p = at + len;
        } else if (st === 0xf0 || st === 0xf7) { p += vlq(); }
        else if (type === 0x90 || type === 0x80) {
          const n = d.getUint8(p++), v = d.getUint8(p++), key = ch + ':' + n;
          if (type === 0x90 && v > 0) tr.open[key] = { tick, n, v, ch };
          else if (tr.open[key]) { const o = tr.open[key]; tr.notes.push({ t: o.tick, d: tick - o.tick, n: o.n, v: o.v, ch: o.ch }); delete tr.open[key]; }
        } else if (type === 0xc0) { tr.programs[ch] = d.getUint8(p++); }
        else if (type === 0xd0) p += 1;
        else p += 2;
      }
      p = end;
      tracks.push(tr);
    }
    const b = (tk) => +(tk / ppq).toFixed(2);
    const lines = ['MIDI format ' + format + ', ' + tracks.length + ' tracks, ' + ppq + ' ticks/beat',
      'Tempo: ' + (tempos.length ? tempos.slice(0, 8).map((x) => x.bpm + ' bpm @beat ' + b(x.tick)).join(', ') : '120 bpm (default)'),
      'Time signature: ' + (sigs.length ? sigs.slice(0, 4).map((x) => x.sig + ' @beat ' + b(x.tick)).join(', ') : '4/4 (default)')];
    let budget = 1500;
    tracks.forEach((tr, i) => {
      if (!tr.notes.length && !tr.name) return;
      tr.notes.sort((a, c) => a.t - c.t || a.n - c.n);
      const inst = Object.entries(tr.programs).map(([ch, pg]) => (ch == 9 ? 'Drums' : GM[pg] || 'program ' + pg) + ' (ch ' + (+ch + 1) + ')').join(', ') || (tr.notes.some((x) => x.ch === 9) ? 'Drums (ch 10)' : '');
      const lo = tr.notes.reduce((m, x) => Math.min(m, x.n), 127), hi = tr.notes.reduce((m, x) => Math.max(m, x.n), 0);
      lines.push('', '## Track ' + (i + 1) + (tr.name ? ' "' + tr.name + '"' : '') + (inst ? ' — ' + inst : '') + ': ' + tr.notes.length + ' notes' + (tr.notes.length ? ', range ' + noteName(lo) + '–' + noteName(hi) + ', beats ' + b(tr.notes[0].t) + '–' + b(tr.notes[tr.notes.length - 1].t + tr.notes[tr.notes.length - 1].d) : ''));
      if (tr.notes.length) lines.push('beat  note  dur  vel' + (tr.notes.some((x) => x.ch !== tr.notes[0].ch) ? '  ch' : ''));
      const take = Math.min(tr.notes.length, Math.max(40, budget));
      tr.notes.slice(0, take).forEach((x) => lines.push(b(x.t) + '  ' + noteName(x.n) + '  ' + b(x.d) + '  ' + x.v + (tr.notes.some((y) => y.ch !== tr.notes[0].ch) ? '  ' + (x.ch + 1) : '')));
      if (take < tr.notes.length) lines.push('… ' + (tr.notes.length - take) + ' more notes (grep/read this file for the rest)');
      budget -= take;
    });
    return lines.join('\n');
  }

  /* ── audio ── */
  async function inspectAudio(buf) {
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Ctx) return 'Audio file (this browser can\'t decode it for a summary).';
    const ctx = new Ctx(1, 1, 44100);
    const a = await ctx.decodeAudioData(buf.slice(0));
    const ch = a.getChannelData(0), N = 24, step = Math.floor(ch.length / N) || 1;
    const env = [];
    for (let i = 0; i < N; i++) { let s = 0; for (let j = i * step; j < (i + 1) * step && j < ch.length; j += 16) s += ch[j] * ch[j]; env.push(Math.sqrt(s / (step / 16))); }
    const pk = Math.max(...env) || 1;
    return 'Audio: ' + a.duration.toFixed(2) + ' s, ' + a.numberOfChannels + ' channel(s), ' + a.sampleRate + ' Hz\nLoudness over time (' + (a.duration / N).toFixed(2) + ' s steps, 0–9): ' + env.map((e) => Math.round(9 * e / pk)).join('');
  }

  /* ── PDF ── */
  async function inspectPdf(buf) {
    const lib = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs');
    lib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
    const doc = await lib.getDocument({ data: new Uint8Array(buf) }).promise;
    const out = ['PDF, ' + doc.numPages + ' pages'];
    for (let i = 1; i <= Math.min(doc.numPages, 200); i++) {
      const pg = await doc.getPage(i);
      const tc = await pg.getTextContent();
      out.push('\n--- page ' + i + ' ---\n' + tc.items.map((x) => x.str + (x.hasEOL ? '\n' : ' ')).join('').replace(/[ \t]+\n/g, '\n').trim());
      if (out.join('').length > 400000) { out.push('\n… (stopped at page ' + i + ')'); break; }
    }
    return out.join('\n');
  }

  /* ── zip family (zip, docx, xlsx, pptx, epub, jar…) ── */
  async function unzip(buf) {
    const d = new DataView(buf), u8 = new Uint8Array(buf);
    let e = buf.byteLength - 22;
    while (e >= 0 && d.getUint32(e, true) !== 0x06054b50) e--;
    if (e < 0) throw new Error('not a zip');
    const n = d.getUint16(e + 10, true); let p = d.getUint32(e + 16, true);
    const dec = new TextDecoder(), entries = [];
    for (let i = 0; i < n; i++) {
      const method = d.getUint16(p + 10, true), csize = d.getUint32(p + 20, true), size = d.getUint32(p + 24, true);
      const nl = d.getUint16(p + 28, true), xl = d.getUint16(p + 30, true), cl = d.getUint16(p + 32, true), off = d.getUint32(p + 42, true);
      entries.push({ name: dec.decode(u8.subarray(p + 46, p + 46 + nl)), method, csize, size, off });
      p += 46 + nl + xl + cl;
    }
    const read = async (en) => {
      const lp = en.off, s = lp + 30 + d.getUint16(lp + 26, true) + d.getUint16(lp + 28, true);
      const raw = u8.subarray(s, s + en.csize);
      if (en.method === 0) return raw;
      if (en.method !== 8 || !window.DecompressionStream) return null;
      const st = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(st).arrayBuffer());
    };
    return { entries, read };
  }
  const xmlText = (x) => x.replace(/<w:p[ >][\s\S]*?<\/w:p>/g, (m) => m + '\n').replace(/<a:p>|<\/a:p>/g, '\n').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\n{3,}/g, '\n\n').trim();
  async function inspectZip(buf, name) {
    const z = await unzip(buf);
    const files = z.entries.filter((x) => !x.name.endsWith('/'));
    const out = ['Archive (' + ext(name) + '), ' + files.length + ' files:', ...files.slice(0, 300).map((x) => '  ' + x.name + '  ' + x.size + 'B')];
    if (files.length > 300) out.push('  … ' + (files.length - 300) + ' more');
    const dec = new TextDecoder();
    // Office / ePub: pull the document text. Otherwise: small text files inside.
    const office = files.filter((x) => /^(word\/document|word\/footnotes|ppt\/slides\/slide\d+|xl\/sharedStrings)\.xml$|\.x?html?$/.test(x.name) && /^(docx|pptx|xlsx|epub|odt)$/.test(ext(name)) || /^content\.xml$/.test(x.name));
    const texty = office.length ? office : files.filter((x) => x.size < 200000 && /\.(txt|md|json|csv|js|ts|py|html?|css|xml|ya?ml|toml|ini|sh|c|h|cpp|java|go|rs|rb|php|sql)$/i.test(x.name)).slice(0, 25);
    let total = 0;
    for (const en of texty.sort((a, c) => a.name.localeCompare(c.name, undefined, { numeric: true }))) {
      const bytes = await z.read(en).catch(() => null);
      if (!bytes) continue;
      let t = dec.decode(bytes);
      if (office.length) t = xmlText(t);
      out.push('\n--- ' + en.name + ' ---\n' + t);
      total += t.length;
      if (total > 400000) { out.push('\n… (stopped)'); break; }
    }
    return out.join('\n');
  }

  /* ── anything else ── */
  const MAGIC = [[[0x25, 0x50, 0x44, 0x46], 'PDF'], [[0x50, 0x4b, 0x03, 0x04], 'ZIP'], [[0x4d, 0x54, 0x68, 0x64], 'MIDI'], [[0x52, 0x49, 0x46, 0x46], 'RIFF (WAV/AVI/WebP)'], [[0x49, 0x44, 0x33], 'MP3 (ID3)'], [[0x4f, 0x67, 0x67, 0x53], 'Ogg'], [[0x66, 0x4c, 0x61, 0x43], 'FLAC'], [[0x1f, 0x8b], 'gzip'], [[0x7f, 0x45, 0x4c, 0x46], 'ELF binary'], [[0x4d, 0x5a], 'Windows executable'], [[0x00, 0x61, 0x73, 0x6d], 'WebAssembly'], [[0x53, 0x51, 0x4c, 0x69], 'SQLite database'], [[0x1a, 0x45, 0xdf, 0xa3], 'Matroska/WebM'], [[0x67, 0x6c, 0x54, 0x46], 'glTF binary (3D)']];
  function generic(buf) {
    const u8 = new Uint8Array(buf, 0, Math.min(64, buf.byteLength));
    const kind = (MAGIC.find(([m]) => m.every((b, i) => u8[i] === b)) || [])[1];
    const hex = [...u8].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = [...u8].map((b) => b >= 32 && b < 127 ? String.fromCharCode(b) : '.').join('');
    return (kind ? 'Detected: ' + kind + '\n' : '') + 'First bytes: ' + hex + '\nAs text: ' + ascii;
  }

  function isText(buf) {
    const u8 = new Uint8Array(buf, 0, Math.min(8000, buf.byteLength));
    if (u8.includes(0)) return false;
    try { new TextDecoder('utf-8', { fatal: true }).decode(u8.subarray(0, u8.length - 4 > 0 ? u8.length - 4 : u8.length)); return true; } catch (_) { return false; }
  }

  // → { text (what the model reads), kind, size, url (Promise) }
  async function read(file) {
    if (file.size > MAX) throw new Error(file.name + ' is over 25 MB');
    const buf = await file.arrayBuffer();
    const e = ext(file.name), t = file.type || '';
    let kind = 'file', text;
    try {
      if (/^(mid|midi|kar)$/.test(e) || /midi/.test(t)) { kind = 'midi'; text = parseMidi(buf); }
      else if (/^audio\//.test(t) || /^(mp3|wav|ogg|oga|m4a|aac|flac|opus|weba)$/.test(e)) { kind = 'audio'; text = await inspectAudio(buf); }
      else if (e === 'pdf' || t === 'application/pdf') { kind = 'pdf'; text = await inspectPdf(buf); }
      else if (/^(zip|docx|xlsx|pptx|epub|odt|ods|odp|jar|apk|ipa|sketch|xd)$/.test(e) || /zip/.test(t)) { kind = 'archive'; text = await inspectZip(buf, file.name); }
      else if (isText(buf)) { kind = 'text'; text = new TextDecoder().decode(buf).replace(/\r\n/g, '\n'); }
      else text = generic(buf);
    } catch (err) {
      text = 'Could not read inside it (' + err.message + ').\n' + generic(buf);
    }
    return { kind, text, size: file.size, type: t || 'application/octet-stream', url: upload(file) };
  }

  window.CloakAttach = { read, upload, parseMidi, kb, MAX };
})();

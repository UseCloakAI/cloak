/* The code canvas for Cloak Blinks (CodeCanvas). Code a Blink writes never
   sits in the chat: each fenced file (```js title="app.js"```) becomes a
   small card in the message and lives in the canvas, a side panel with file
   tabs, versions, copy, download and a sandboxed preview for web pages.

   Files are not stored separately: they are replayed from the chat's own
   messages, in order, so they sync wherever the chat does. An edit block
   (```edit title="app.js"``` with SEARCH/REPLACE pairs) makes the next
   version of a file from the latest one, exactly or ignoring indentation.

   CodeCanvas.replay(messages)  -> state { files: {name: {lang, versions:[{code, at, edit}]}}, order }
   CodeCanvas.chipify(text, state) -> text with fences swapped for placeholders, and the chips
   CodeCanvas.latest(state)     -> [{name, code}] for the request (grep_files / read_file) */
(function () {
  "use strict";
  var FENCE = /```([^\n`]*)\n([\s\S]*?)```/g;
  var EXT = { js: "js", javascript: "js", jsx: "jsx", ts: "ts", typescript: "ts", tsx: "tsx", py: "py", python: "py", html: "html", css: "css", json: "json", sh: "sh", bash: "sh", shell: "sh", md: "md", markdown: "md", svg: "svg", sql: "sql", java: "java", c: "c", cpp: "cpp", go: "go", rs: "rs", rust: "rs", rb: "rb", ruby: "rb", php: "php", swift: "swift", kotlin: "kt", yaml: "yml", yml: "yml", xml: "xml", txt: "txt" };

  function head(info) {
    info = String(info || "").trim();
    var t = /title\s*=\s*"([^"]+)"/.exec(info) || /title\s*=\s*'([^']+)'/.exec(info);
    var lang = (info.split(/\s+/)[0] || "").toLowerCase();
    var name = t ? t[1] : "";
    if (!name) { var w = info.split(/\s+/).slice(1).find(function (x) { return /\.[a-z0-9]{1,6}$/i.test(x); }); if (w) name = w; }
    if (!name && /\.[a-z0-9]{1,6}$/i.test(lang)) { name = lang; lang = lang.split(".").pop(); }
    return { lang: lang === "title" ? "" : lang, name: name.replace(/[^\w.\-\/ ]/g, "").slice(0, 80) };
  }
  function hash(s) { var h = 5381; for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36).slice(0, 4); }
  // Which fences go to the canvas: named files, edits, and anything longer than a few lines.
  function canvasFence(h, code) { return !!h.name || h.lang === "edit" || code.split("\n").length >= 4; }
  function nameFor(h, code) { return h.name || "snippet-" + hash(code) + "." + (EXT[h.lang] || h.lang || "txt"); }

  // SEARCH/REPLACE pairs, applied exactly, then ignoring indentation.
  function applyEdit(src, body) {
    var re = /<<<<<<<\s*SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>>\s*REPLACE/g, m, out = src, n = 0, failed = 0;
    while ((m = re.exec(body))) {
      var find = m[1], rep = m[2];
      if (find && out.indexOf(find) !== -1) { out = out.replace(find, function () { return rep; }); n++; continue; }
      var lines = out.split("\n"), want = find.split("\n").map(function (l) { return l.trim(); });
      var at = -1;
      for (var i = 0; i + want.length <= lines.length && at < 0; i++) {
        var ok = true;
        for (var j = 0; j < want.length && ok; j++) if (lines[i + j].trim() !== want[j]) ok = false;
        if (ok) at = i;
      }
      if (at < 0) { failed++; continue; }
      var indent = (/^\s*/.exec(lines[at]) || [""])[0], base = (/^\s*/.exec(find.split("\n")[0]) || [""])[0];
      var repl = rep.split("\n").map(function (l) { return l.indexOf(base) === 0 ? indent + l.slice(base.length) : l; });
      lines.splice.apply(lines, [at, want.length].concat(repl));
      out = lines.join("\n");
      n++;
    }
    return { code: out, applied: n, failed: failed };
  }

  function replay(messages) {
    var st = { files: {}, order: [], seen: {} };
    (messages || []).forEach(function (m) {
      if (m.role !== "assistant" || !m.content) return;
      var re = new RegExp(FENCE.source, "g"), x;
      while ((x = re.exec(m.content))) {
        var h = head(x[1]), code = x[2].replace(/\n$/, "");
        if (!canvasFence(h, code)) continue;
        if (h.lang === "edit") {
          var f = st.files[h.name];
          if (!f) continue;
          var r = applyEdit(f.versions[f.versions.length - 1].code, code);
          if (!r.applied) { st.seen["e:" + h.name + ":" + hash(code)] = { name: h.name, v: f.versions.length, failed: true }; continue; }
          f.versions.push({ code: r.code, at: m.at || 0, edit: r.applied });
          st.seen["e:" + h.name + ":" + hash(code)] = { name: h.name, v: f.versions.length, changes: r.applied, failed: r.failed };
          continue;
        }
        var name = nameFor(h, code);
        if (!st.files[name]) { st.files[name] = { lang: h.lang || name.split(".").pop(), versions: [] }; st.order.push(name); }
        var vs = st.files[name].versions;
        if (!vs.length || vs[vs.length - 1].code !== code) vs.push({ code: code, at: m.at || 0 });
        st.seen["f:" + name + ":" + hash(code)] = { name: name, v: vs.length };
      }
    });
    return st;
  }

  // Swaps canvas fences for one-word placeholders (so markdown leaves them
  // alone) and returns what each one is, to draw as a card afterwards.
  function chipify(text, st) {
    var chips = [];
    var out = String(text || "").replace(new RegExp(FENCE.source, "g"), function (all, info, body) {
      var h = head(info), code = body.replace(/\n$/, "");
      if (!canvasFence(h, code)) return all;
      var key = h.lang === "edit" ? "e:" + h.name + ":" + hash(code) : "f:" + nameFor(h, code) + ":" + hash(code);
      var s = (st && st.seen[key]) || { name: h.lang === "edit" ? h.name : nameFor(h, code), v: 0 };
      chips.push({ name: s.name, v: s.v, edit: h.lang === "edit", changes: s.changes || 0, failed: !!s.failed, lines: code.split("\n").length, lang: h.lang });
      return "\n\nCODECHIP" + (chips.length - 1) + "\n\n";
    });
    return { text: out, chips: chips };
  }
  function latest(st) {
    return (st ? st.order : []).map(function (n) { var vs = st.files[n].versions; return { name: n, code: vs[vs.length - 1].code }; });
  }
  window.CodeCanvas = { replay: replay, chipify: chipify, latest: latest, applyEdit: applyEdit, head: head };
})();

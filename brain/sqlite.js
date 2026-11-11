// A tiny adapter so MindCore (written for a Durable Object's SQLite) runs on
// Node's built-in node:sqlite. Same call shape: sql.exec(query, ...args)
// returns { toArray(), one() }.

import { DatabaseSync } from "node:sqlite";

export function openSql(file) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 3000;");
  const cache = new Map();
  const rows = (list) => ({ toArray: () => list, one: () => list[0] });
  return {
    db,
    exec(query, ...args) {
      const q = String(query).trim();
      // Several statements and no parameters: run them as a script.
      if (!args.length && /;\s*\S/.test(q.replace(/;\s*$/, ""))) {
        db.exec(q);
        return rows([]);
      }
      let st = cache.get(q);
      if (!st) {
        st = db.prepare(q);
        if (cache.size > 200) cache.clear();
        cache.set(q, st);
      }
      return rows(st.all(...args.map((a) => (typeof a === "boolean" ? Number(a) : a ?? null))));
    },
    close() { db.close(); },
  };
}

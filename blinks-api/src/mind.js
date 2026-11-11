// Mind: the Cloudflare Durable Object around MindCore (mind-core.js), one per
// person. Its SQLite storage and alarm are the core's storage and timer. The
// home-PC brain runs the same core on node:sqlite instead.

import { DurableObject } from "cloudflare:workers";
import { MindCore } from "./mind-core.js";

export class Mind extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.core = new MindCore(ctx.storage.sql, { set: (t) => ctx.storage.setAlarm(t), clear: () => ctx.storage.deleteAlarm() }, env, (p) => ctx.waitUntil(p));
  }
  alarm() { return this.core.alarm(); }
}

// Every public method of the core is callable over RPC, unchanged.
for (const name of Object.getOwnPropertyNames(MindCore.prototype)) {
  if (name === "constructor" || name === "alarm") continue;
  Mind.prototype[name] = function (...args) { return this.core[name](...args); };
}

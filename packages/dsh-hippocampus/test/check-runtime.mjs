// 实证：检查对话运行时记忆是否被真正调用（inject_log 留痕 + 活动记录）
import Database from "better-sqlite3";
import { getLoadablePath } from "sqlite-vec";
import os from "node:os";
import path from "node:path";

const f = path.join(os.homedir(), ".dsh", "storages", "hippocampus", "memory.db");
const db = new Database(f, { readonly: true });
db.loadExtension(getLoadablePath());
const q = (sql, ...a) => db.prepare(sql).all(...a);
const one = (sql, ...a) => db.prepare(sql).get(...a);

console.log("=== inject_log（对话前注入留痕）最近 8 条 ===");
for (const r of q("SELECT * FROM inject_log ORDER BY id DESC LIMIT 8")) {
  console.log(
    "  [" + r.mode + "] " + new Date(r.ts).toLocaleString("zh-CN") +
    " | " + r.count + " 条记忆 | " + r.chars + " 字" +
    (r.workstate ? " | 含工作状态" : "") +
    " | " + String(r.title ?? "").slice(0, 60)
  );
}
console.log("inject_log 总条数:", one("SELECT COUNT(*) c FROM inject_log").c);
console.log();
console.log("=== meta 最近活动 ===");
const m = q("SELECT key, value FROM meta WHERE key IN ('lastActivityAt','feedAt','lastAutoEvolveAt','lastPurgeAt','lastCrossAt','crossCreated','lastEvolveAt')");
for (const r of m) {
  const n = Number(r.value);
  console.log("  " + r.key + " = " + (isNaN(n) || r.value.includes(":") ? r.value : new Date(n).toLocaleString("zh-CN")));
}
console.log();
console.log("=== ⟡ 联想交汇分支数 ===");
console.log("  " + one("SELECT COUNT(*) c FROM branches WHERE title LIKE '⟡%'").c);
console.log();
console.log("=== 最近活跃分支（对话是否在写入/更新记忆）===");
for (const r of q("SELECT title, kind, strength, updated_at FROM branches WHERE status='active' ORDER BY updated_at DESC LIMIT 6")) {
  console.log("  [" + r.kind + "|" + r.strength.toFixed(2) + "] " + String(r.title).slice(0, 50) + " — " + new Date(r.updated_at).toLocaleString("zh-CN"));
}
db.close();

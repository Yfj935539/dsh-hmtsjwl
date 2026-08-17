// 记忆库健康检查（只读）：用于优化前基线 + 优化后验证
import Database from "better-sqlite3";
import { getLoadablePath } from "sqlite-vec";
import os from "node:os";
import path from "node:path";

const f = path.join(os.homedir(), ".dsh", "storages", "hippocampus", "memory.db");
const db = new Database(f, { readonly: true });
db.loadExtension(getLoadablePath());
const q = (sql, ...args) => db.prepare(sql).all(...args);
const one = (sql, ...args) => db.prepare(sql).get(...args);

console.log("=== 记忆库基线检查 ===");
console.log("文件:", f);
console.log("branches 总数:", one("SELECT COUNT(*) c FROM branches").c);
console.log("活跃:", one("SELECT COUNT(*) c FROM branches WHERE status='active'").c);
console.log("归档:", one("SELECT COUNT(*) c FROM branches WHERE status='archived'").c);
console.log("种类分布:", JSON.stringify(q("SELECT kind, COUNT(*) c FROM branches WHERE status='active' GROUP BY kind")));
console.log("强度均值:", one("SELECT ROUND(AVG(strength),3) a FROM branches WHERE status='active'").a);
console.log("links 总数:", one("SELECT COUNT(*) c FROM links").c);
console.log("memories 向量数:", one("SELECT COUNT(*) c FROM memories").c);
console.log("孤儿向量:", one("SELECT COUNT(*) c FROM memories WHERE rowid NOT IN (SELECT id FROM branches)").c);
console.log("无向量活跃分支:", one("SELECT COUNT(*) c FROM branches b WHERE b.status='active' AND NOT EXISTS (SELECT 1 FROM memories m WHERE m.rowid=b.id)").c);
console.log("workstate:", q("SELECT uid, substr(content,1,40) content, strength, updated_at FROM branches WHERE kind='workstate' AND status='active' ORDER BY updated_at DESC LIMIT 3"));
console.log("meta:", JSON.stringify(q("SELECT key, value FROM meta WHERE key IN ('epoch','generation','fitness','feedAt','learningRate','staleCleaned','lastAutoEvolveAt')")));
console.log("inject_log 条数:", one("SELECT COUNT(*) c FROM inject_log").c);
console.log("evolog 条数:", one("SELECT COUNT(*) c FROM evolog").c);
console.log("标题重复(活跃):", JSON.stringify(q("SELECT title, COUNT(*) c FROM branches WHERE status='active' GROUP BY title HAVING c>1 ORDER BY c DESC LIMIT 5")));
db.close();

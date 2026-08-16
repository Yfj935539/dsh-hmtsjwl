import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { HippocampusDb } from "../lib/index.js";

const DSH = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const rand = Math.random().toString(36).slice(2, 8);
const project = "C:/__hp_dbg_" + rand;
const storeDir = path.join(DSH, "storages", "hippocampus", "projects",
  crypto.createHash("md5").update(project).digest("hex"));

const db = new HippocampusDb("project", project);
const a = await db.writeBranch({ title: "用户偏好中文交流", content: "用户偏好使用中文交流，代码注释与交付说明默认使用中文。", kind: "preference", strength: 0.9, source: "user" });
console.log("A:", a.branch.id, "dedup=" + a.dedup);
const vecCount = db.db.prepare("SELECT COUNT(*) c FROM memories").get().c;
console.log("memories rows:", vecCount);
// 手动 embed 并查询
const emb = await (async () => {
  const { pipeline, env } = await import("@xenova/transformers");
  env.cacheDir = path.join(DSH, "storages", "hippocampus", "models");
  env.allowLocalModels = false;
  const ex = await pipeline("feature-extraction", "Xenova/bge-small-zh-v1.5");
  const out = await ex("用户偏好使用中文交流，代码注释与交付说明默认使用中文。", { pooling: "mean", normalize: true });
  return Float32Array.from(out.data);
})();
const buf = Buffer.from(emb.buffer, emb.byteOffset, emb.byteLength);
const hits = db.db.prepare("SELECT rowid, distance FROM memories WHERE embedding MATCH ? ORDER BY distance LIMIT 3").all(buf);
console.log("MATCH hits:", hits.map((h) => ({ rowid: h.rowid, dist: h.distance })));
const sim = await db.findSimilar(buf, { limit: 3 });
console.log("findSimilar:", sim.map((s) => s.b.id + "@" + s.s.toFixed(3)));

const b = await db.writeBranch({ title: "用户偏好中文交流", content: "用户偏好使用中文交流，代码注释与交付说明默认使用中文。", kind: "preference", source: "user" });
console.log("B dedup=" + b.dedup, "mergedInto=" + b.mergedInto);
console.log("links:", db.linksOf(a.branch.id));

db.close();
try { fs.rmSync(storeDir, { recursive: true, force: true }); } catch {}

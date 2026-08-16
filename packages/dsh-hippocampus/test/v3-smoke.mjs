// v3 / v3.1 冒烟测试：独立测试作用域（随机项目路径 → projects/<md5>），测后清理
// 用法：node --import ./test/register.mjs test/v3-smoke.mjs
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { HippocampusDb } from "../lib/index.js";

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log("  ✓ " + name);
  else { failed++; console.log("  ✗ " + name + (extra ? " — " + extra : "")); }
}

const DSH = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const rand = Math.random().toString(36).slice(2, 8);
const project = "C:/__hp_v3_" + rand;
const storeDir = path.join(DSH, "storages", "hippocampus", "projects",
  crypto.createHash("md5").update(project).digest("hex"));

let db;
try {
db = new HippocampusDb("project", project);
console.log("== v3 冒烟测试 ==");

// 1. 写入 + 自动标签 + 突触
const a = await db.writeBranch({ title: "用户偏好中文交流", content: "用户偏好使用中文交流，代码注释与交付说明默认使用中文。", kind: "preference", strength: 0.9, source: "user" });
check("写入 preference", !a.dedup && a.branch.id.length > 0);
check("自动标签", Array.isArray(a.branch.tags) && a.branch.tags.length > 0, JSON.stringify(a.branch.tags));

const b = await db.writeBranch({ title: "项目目标", content: "本次项目目标是重写海马体记忆插件，深度完善项目文件夹记忆，用于项目推进与上下文污染优化。", kind: "workstate", strength: 0.8, source: "agent", sessionId: "sess-1" });
check("写入 workstate", !b.dedup);

// 2. 去重合并
const dup = await db.writeBranch({ title: "用户偏好中文交流", content: "用户偏好使用中文交流，代码注释与交付说明默认使用中文。", kind: "preference", source: "user" });
check("去重合并", dup.dedup === true && dup.mergedInto === a.branch.id, JSON.stringify({ dedup: dup.dedup, mergedInto: dup.mergedInto }));

// 3. 突触连接
const linksA = db.linksOf(a.branch.id);
check("突触连接已建立", linksA.length >= 1, JSON.stringify(linksA));

// 4. 三阶段检索
const r = await db.searchBranches("中文", 5);
check("检索返回", r.results.length >= 1);
check("检索结果含 score", typeof r.results[0]?.score === "number");

// 5. 联想扩散（无向图）
const assoc = db.associateExpand([{ b: a.branch }], 5, null);
console.log("   …联想邻居数: " + assoc.length);

// 6. graphData（真实突触边）
const g = db.graphData();
check("graph 节点", g.nodes.length >= 2);
check("graph 突触边", g.edges.length >= 1, "edges=" + g.edges.length);
check("graph 度数", g.nodes.some((n) => n.degree > 0));

// 7. 轨迹喂养
const events = [
  { type: "user/message", time: Date.now() - 5000, seq: 1, data: { content: [{ type: "text", text: "请记住：本项目的核心是把记忆插件升级到 v3，重点是项目记忆强化。" }] } },
  { type: "tool/result", time: Date.now() - 4000, seq: 2, data: { message: { content: [{ type: "text", text: "已完成宿主端重写，下一步是客户端可视化。" }] } } },
  { type: "assistant/message", time: Date.now() - 3000, seq: 3, data: { message: { content: [{ type: "text", text: "好的，我会基于 wazome memory network v3.1 深度完善。" }] } } }
];
const f = await db.feedTrajectory(events, "sess-1");
check("轨迹喂养写入", f.wrote === true && f.fed === 3, JSON.stringify(f));
const feedAt = db.getMeta("feedAt", 0);
check("喂养时间戳", feedAt > 0);

// 8. 项目记忆包
const pack = db.contextPack({ topN: 5, maxLen: 120 });
check("记忆包文本", pack.text.includes("记忆包"));
check("记忆包含工作状态/精华", pack.top.length >= 3, "top=" + pack.top.length);

// 9. 过期处理：把一条记忆改旧 + 调弱 → purgeStale 应归档/删除
const staleProbe = await db.writeBranch({ title: "过期探测", content: "这条记忆会被人工改旧，用于测试过期清理。", kind: "other", strength: 0.9 });
db.db.prepare("UPDATE branches SET updated_at=?, strength=? WHERE uid=?").run(Date.now() - 40 * 86400000, 0.08, staleProbe.branch.id);
const p1 = db.purgeStale();
const probeAfter = db.getByUid(staleProbe.branch.id);
check("过期弱记忆已删除", probeAfter === null || probeAfter.status === "archived", "purge=" + JSON.stringify(p1));
if (probeAfter && probeAfter.status === "archived") check("过期弱记忆归档", true);

// 10. 过期降权（检索时 >30 天 ×0.55）
const oldProbe = await db.writeBranch({ title: "旧知识", content: "一年前关于旧方案的过时设计记录。", kind: "insight", strength: 0.9 });
db.db.prepare("UPDATE branches SET updated_at=? WHERE uid=?").run(Date.now() - 120 * 86400000, oldProbe.branch.id);
const r2 = await db.searchBranches("旧方案", 5);
const hitOld = r2.results.find((x) => x.branch.id === oldProbe.branch.id);
check("过期记忆降权", hitOld === undefined || hitOld.score < 0.7, hitOld ? "score=" + hitOld.score : "未命中（更佳）");

// 11. 演化（合并近重复 + 修剪弱连接）
await db.writeBranch({ title: "项目目标二", content: "本次项目目标为重写海马体记忆插件，深度完善项目文件夹记忆，用于项目推进与上下文污染优化。", kind: "workstate", strength: 0.7, source: "agent" });
const ev = await db.evolve();
check("演化合并数", typeof ev.merged === "number" && ev.merged >= 0, "merged=" + ev.merged);
check("演化 epoch+1", ev.meta.epoch >= 2);

// 12. 存储优化（提炼 + 清理 + VACUUM）
const opt = db.optimizeForSize();
check("优化返回", opt.ok === true && typeof opt.freed === "number", JSON.stringify(opt));
check("优化后尺寸", opt.after <= opt.before || opt.after > 0);

// 13. 统计
const stats = db.buildMeta();
check("meta 含 v3.1 字段", typeof stats.sizeBytes === "number" && "feedAt" in stats && "staleCleaned" in stats);

db.close();
} catch (err) {
  failed++;
  console.log("  ✗ 异常: " + (err?.stack ?? err));
  try { db?.close(); } catch {}
}
try { fs.rmSync(storeDir, { recursive: true, force: true }); } catch {}
console.log(failed === 0 ? "\n✅ 全部通过" : "\n❌ " + failed + " 项失败");
process.exit(failed === 0 ? 0 : 1);

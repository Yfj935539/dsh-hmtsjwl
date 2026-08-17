// v5.4 专项：神经网络协作机制验证
//  1. AnchorBank 激活/加权/TTL/容量淘汰
//  2. 检索锚点加权 + 激活返回
//  3. 写入归纳连线（同会话时序 / 同项目 / 共享标签）
//  4. 两轮联想扩散（联想链）
//  5. related 相关记忆提示
//  6. 消息预检索缓存（factory.recall）
// 用法：$env:DSH_HOME="<临时目录>"; node --import ./test/register.mjs test/v54-smoke.mjs
import path from "node:path";
import os from "node:os";
import { HippocampusDb, HippocampusDbFactory, AnchorBank } from "../lib/index.js";

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log("  ✓ " + name);
  else { failed++; console.log("  ✗ " + name + (extra ? " — " + extra : "")); }
}

const DSH = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const WD = "C:/__hp_v54_ws__";

console.log("== v5.4 神经网络协作机制测试 ==");

// 1. AnchorBank 单元
const bank = new AnchorBank({ ttlMs: 60000, max: 4 });
bank.activate(["m1", "m2"], 0.5);
bank.activate(["m2"], 0.4); // 叠加
check("锚点叠加强度", bank.weight("m2") > bank.weight("m1") && bank.weight("m2") > 0.8, "m2=" + bank.weight("m2").toFixed(3));
bank.activate(["m3", "m4", "m5", "m6", "m7", "m8"], 0.3);
check("容量淘汰生效", bank.list(20).length <= 4, "size=" + bank.list(20).length);
bank.activate(["m9"], 0.5);
// TTL：手动把 m9 时间改旧 → weight 0
const raw = bank.map.get("m9");
if (raw) raw.at = Date.now() - 120000;
check("TTL 过期归零", bank.weight("m9") === 0);

// 2. 检索锚点加权 + 激活
const factory = new HippocampusDbFactory();
const db = factory.getDb("unified");
const a1 = await db.writeBranch({ title: "v54 用户偏好：简洁", content: "用户偏好直接简洁的回答，不冗余。", kind: "preference", strength: 0.9, source: "user" });
const a2 = await db.writeBranch({ title: "v54 工作状态：开发中", content: "当前正在开发 v5.4 神经网络协作机制。", kind: "workstate", strength: 0.8, source: "agent", scopePath: WD });
factory.anchors.activate([a1.branch.id], 0.9);
const sr = await db.searchBranches("用户偏好", 5);
check("检索返回锚点列表", Array.isArray(sr.anchors) && sr.anchors.some((x) => x.id === a1.branch.id), JSON.stringify(sr.anchors?.slice(0, 2)));
const sr2 = await db.searchBranches("v5.4 工作状态", 5);
check("检索激活命中锚点", (sr2.anchors ?? []).some((x) => x.id === a2.branch.id), JSON.stringify(sr2.anchors?.slice(0, 2)));

// 3. 归纳连线：同会话时序 + 同项目 + 共享标签（内容差异大，避免触发语义去重合并）
const s3 = await db.writeBranch({ title: "v54 会话记忆甲", content: "今天完成了模块 A 的开发，接口联调通过，性能达标。", kind: "other", source: "user", sessionId: "sess-v54", scopePath: WD, tags: ["神经网络", "v54"] });
await new Promise((r) => setTimeout(r, 5));
const s4 = await db.writeBranch({ title: "v54 会话记忆乙", content: "模块 B 的技术方案评审通过，下周进入编码阶段。", kind: "other", source: "user", sessionId: "sess-v54", scopePath: WD, tags: ["神经网络", "协作"] });
const s5 = await db.writeBranch({ title: "v54 标签相关记忆", content: "模块 C 的测试策略已确定，覆盖单元与集成两层。", kind: "other", source: "user", scopePath: WD, tags: ["神经网络", "协作"] });
const linkRows = db.db.prepare("SELECT a,b,weight FROM links WHERE a=? OR b=? OR a=? OR b=?").all(s4.branch.id, s4.branch.id, s5.branch.id, s5.branch.id);
const linkW = (x, y) => linkRows.find((l) => (l.a === x && l.b === y) || (l.a === y && l.b === x))?.weight ?? 0;
check("同会话时序连线", linkW(s3.branch.id, s4.branch.id) >= 0.3, "w=" + linkW(s3.branch.id, s4.branch.id).toFixed(2));
check("共享标签连线", linkW(s4.branch.id, s5.branch.id) >= 0.25, "w=" + linkW(s4.branch.id, s5.branch.id).toFixed(2));

// 4. related 提示（0.5~0.9 相似不合并）
const rel = await db.writeBranch({ title: "v54 偏好相关记忆", content: "用户偏好相关话题：回答时提及简洁风格相关内容。", kind: "other", source: "user" });
check("返回结构含 related 字段", "related" in rel && Array.isArray(rel.related));

// 5. 两轮联想扩散（至少不崩且返回数组）
const exp = db.associateExpand(
  [{ b: (await db.getByUid(s3.branch.id)) }],
  8, null, db.activeBranches()
);
check("两轮联想扩散返回数组", Array.isArray(exp));

// 6. 消息预检索缓存
factory.setRecall("agent-x", { q: "测试预检索", results: [{ id: a1.branch.id, title: a1.branch.title, kind: "preference", content: "x", score: 0.9 }], anchors: [], at: Date.now() });
const peek = factory.peekRecall(60000);
check("recall 缓存可读取", !!peek && peek.q === "测试预检索", JSON.stringify(peek && peek.q));

db.close();
console.log(failed === 0 ? "\n✅ 全部通过" : "\n❌ " + failed + " 项失败");
process.exit(failed === 0 ? 0 : 1);

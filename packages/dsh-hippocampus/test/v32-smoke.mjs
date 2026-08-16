// v3.2 统一记忆库 + 节点上限 专项测试
// 用法：$env:DSH_HIPPOCAMPUS_MAX_NODES="5"; node --import ./test/register.mjs test/v32-smoke.mjs
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
const projectA = "C:/__hp_v32_a_" + rand;
const projectB = "C:/__hp_v32_b_" + rand;

console.log("== v3.2 统一记忆库测试（MAX_NODES=" + process.env.DSH_HIPPOCAMPUS_MAX_NODES + "）==");

// 1. 不同目录（scope）指向同一记忆库 —— 跨工作区目录打通
const dbA = new HippocampusDb("project", projectA);
const dbB = new HippocampusDb("global", null);
const sameFile = path.join(DSH, "storages", "hippocampus", "memory.db");
check("A/B 使用同一库文件", dbA.db.name === dbB.db.name && dbA.db.name.includes(sameFile), dbA.db.name + " vs " + dbB.db.name);

const w1 = await dbA.writeBranch({ title: "目录A的记忆", content: "这是工作区 A 写入的记忆，验证跨目录打通。", kind: "other", source: "user" });
const w2 = await dbB.writeBranch({ title: "目录B的记忆", content: "工作区 B 的独立记忆：记录 B 目录下的技术选型结论与部署细节。", kind: "other", source: "user" });
const listB = dbB.listBranches({}).branches;
check("B 能看到 A 写入的记忆（打通）", listB.some((b) => b.id === w1.branch.id), "B 有 " + listB.length + " 条");
check("A 能看到 B 写入的记忆（打通）", dbA.listBranches({}).branches.some((b) => b.id === w2.branch.id));

// 2. 节点上限：写 5 条主题各异的低强度记忆，活跃应 ≤ 5（最弱/最旧被归档）
const topics = [
  "后端技术选型：采用 Node.js + SQLite 组合，轻量可靠",
  "前端布局：三栏式工作台，左树右编辑器",
  "部署方案：Windows 本机部署，托盘常驻",
  "数据库设计：三张核心表，外键关联",
  "测试策略：单元测试 + 冒烟测试双覆盖"
];
for (let i = 0; i < topics.length; i++) {
  await dbA.writeBranch({ title: "技术要点" + i, content: topics[i], kind: "other", strength: 0.25, source: "system" });
}
const stats = dbA.buildMeta();
check("活跃节点不超过上限 5", stats.counts.active <= 5, "active=" + stats.counts.active);
const capRemoved = dbA.getMeta("cappedRemoved", 0);
check("上限淘汰计数>0", Number(capRemoved) > 0, "cappedRemoved=" + capRemoved);

// 3. 工作状态/会话精华豁免淘汰
await dbA.writeBranch({ title: "工作状态", content: "当前工作状态：v3.2 测试中。", kind: "workstate", strength: 0.9, source: "agent" });
const wsExists = dbA.listBranches({}).branches.some((b) => b.kind === "workstate");
check("工作状态分支保留（豁免）", wsExists);

// 4. 统一库检索跨目录内容
const r = await dbA.searchBranches("工作区 B 目录的部署细节", 5);
check("检索命中跨目录记忆", r.results.some((x) => x.branch.title.includes("目录B")), JSON.stringify(r.results.map((x) => x.branch.title)));

dbA.close();
dbB.close();
try { fs.rmSync(path.join(DSH, "storages", "hippocampus", "memory.db" + "-wal"), { force: true }); } catch {}
try { fs.rmSync(path.join(DSH, "storages", "hippocampus", "memory.db" + "-shm"), { force: true }); } catch {}
// 注意：统一库 memory.db 保留（生产库），测试分支会被上限淘汰/归档清理；此处不删主库文件
console.log(failed === 0 ? "\n✅ 全部通过" : "\n❌ " + failed + " 项失败");
process.exit(failed === 0 ? 0 : 1);

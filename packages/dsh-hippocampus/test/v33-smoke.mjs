// v3.3 专项：3D 球形坐标 / 工作区永久连接 / TTL 断连 / 归档工作区
// 用法：$env:DSH_HOME="<临时目录>"; node --import ./test/register.mjs test/v33-smoke.mjs
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { HippocampusDb } from "../lib/index.js";

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log("  ✓ " + name);
  else { failed++; console.log("  ✗ " + name + (extra ? " — " + extra : "")); }
}

const DSH = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const db = new HippocampusDb("global", null);
const WD = "C:/__hp_v33_ws__";

console.log("== v3.3 球形神经网络测试 ==");

// 1. 写入核心 + 工作区记忆
const pref = await db.writeBranch({ title: "用户偏好：中文", content: "用户偏好中文交流，代码注释用中文。", kind: "preference", strength: 0.95, source: "user" });
const comm = await db.writeBranch({ title: "交流方式：直接高效", content: "用户喜欢直接高效、结构化的交流方式。", kind: "communication", strength: 0.9, source: "user" });
const ws1 = await db.writeBranch({ title: "工作状态：v3.3 开发中", content: "正在开发 3D 球形神经网络可视化。", kind: "workstate", strength: 0.8, source: "agent", scopePath: WD });
const ws2 = await db.writeBranch({ title: "技术洞察：WebGL 可选", content: "Canvas 2D 手写 3D 投影即可满足球形可视化需求。", kind: "insight", strength: 0.7, source: "agent", scopePath: WD });

// 2. 工作区目录节点 + 永久连接
const wdId = db.workdirId(WD);
const wdInfo = db.activeWorkdirs().find((w) => w.path === WD);
check("工作区目录已登记", !!wdInfo, JSON.stringify(wdInfo));
const permP = db.db.prepare("SELECT weight FROM links WHERE a=? AND b=?").get(wdId < pref.branch.id ? wdId : pref.branch.id, wdId < pref.branch.id ? pref.branch.id : wdId);
check("核心↔工作区永久连接已建立", !!permP && permP.weight > 0, JSON.stringify(permP));
check("isPermanentLink 判定", db.isPermanentLink(wdId, pref.branch.id) && db.isPermanentLink(comm.branch.id, wdId));

// 3. graphData 3D 坐标 + 节点类型
const g = db.graphData();
const wdNode = g.nodes.find((n) => n.type === "workdir");
const coreNode = g.nodes.find((n) => n.type === "core");
const leafNode = g.nodes.find((n) => n.type === "leaf");
check("核心节点带 3D 坐标", coreNode && typeof coreNode.x0 === "number" && typeof coreNode.z0 === "number");
check("工作区节点带 3D 坐标", wdNode && typeof wdNode.x0 === "number" && typeof wdNode.y0 === "number" && typeof wdNode.z0 === "number");
check("衍生节点带 3D 坐标", leafNode && typeof leafNode.z0 === "number");
check("边含永久连接", g.edges.some((e) => db.isPermanentLink(e.a, e.b)));

// 4. TTL：非永久连接 3 天无传输 → 断开；永久连接保留
const leafA = g.nodes.find((n) => n.type === "leaf");
const linkRows = db.db.prepare("SELECT a,b,updated_at FROM links").all();
const normal = linkRows.find((l) => !db.isPermanentLink(l.a, l.b));
check("存在非永久连接", !!normal, JSON.stringify(linkRows));
if (normal) {
  db.db.prepare("UPDATE links SET updated_at=? WHERE a=? AND b=?").run(Date.now() - 4 * 86400000, normal.a, normal.b);
}
const permRow = linkRows.find((l) => db.isPermanentLink(l.a, l.b));
if (permRow) {
  db.db.prepare("UPDATE links SET updated_at=? WHERE a=? AND b=?").run(Date.now() - 10 * 86400000, permRow.a, permRow.b);
}
const p = db.purgeStale();
check("TTL 断开非永久连接", p.ttlBroken >= 1, JSON.stringify(p));
const permAfter = db.db.prepare("SELECT weight FROM links WHERE a=? AND b=?").get(permRow.a, permRow.b);
check("永久连接 3 天+ 仍保留", !!permAfter);

// 5. 归档工作区 → 连接全断
const arc = db.archiveWorkdir(WD);
const permAfterArc = db.db.prepare("SELECT COUNT(*) c FROM links WHERE a=? OR b=?").get(wdId, wdId);
check("归档工作区后连接清空", arc.archived && permAfterArc.c === 0, "links=" + permAfterArc.c);
const g2 = db.graphData();
check("归档后不再显示工作区节点", !g2.nodes.some((n) => n.type === "workdir"));

// 6. 偏好/交流强度永不自动衰减
db.db.prepare("UPDATE branches SET last_access_at=? WHERE uid=?").run(Date.now() - 60 * 86400000, pref.branch.id);
db.applyDecay();
const prefAfter = db.getByUid(pref.branch.id);
check("偏好强度未衰减", Math.abs(prefAfter.strength - 0.95) < 1e-9, "strength=" + prefAfter.strength);

db.close();
console.log(failed === 0 ? "\n✅ 全部通过" : "\n❌ " + failed + " 项失败");
process.exit(failed === 0 ? 0 : 1);

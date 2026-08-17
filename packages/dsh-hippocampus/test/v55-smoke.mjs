// v5.5 专项：数据驱动神经网络 —— 联想交汇（连线交叉 → 真实微弱新想法分支）
//  1. segSegDist3 3D 线段距离单元测试
//  2. upsertCrossBranch 直接生成交汇分支（确定性）
//  3. 去重：同组合只强化不新建
//  4. 交汇分支真实进入记忆库（可检索）
//  5. crossLink 全链路（布局交叉检测，不崩且返回结构正确）
// 用法：$env:DSH_HOME="<临时目录>"; node --import ./test/register.mjs test/v55-smoke.mjs
import path from "node:path";
import os from "node:os";
import { HippocampusDb, HippocampusDbFactory } from "../lib/index.js";
import { segSegDist3 } from "../lib/index.js";

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log("  ✓ " + name);
  else { failed++; console.log("  ✗ " + name + (extra ? " — " + extra : "")); }
}

console.log("== v5.5 数据驱动神经网络测试 ==");

// 1. segSegDist3 单元
// 交叉线段（X 形，xy 平面）距离 ≈ 0
const d1 = segSegDist3({ x: -1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: -1, z: 0 }, { x: 0, y: 1, z: 0 });
check("交叉线段距离≈0", d1 < 0.01, "d=" + d1.toFixed(4));
// 平行线段距离 = 间距
const d2 = segSegDist3({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 1, y: 1, z: 0 });
check("平行线段距离=1", Math.abs(d2 - 1) < 0.01, "d=" + d2.toFixed(4));
// 共线同向不相交
const d3 = segSegDist3({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }, { x: 4, y: 0, z: 0 });
check("共线不相交距离=2", Math.abs(d3 - 2) < 0.01, "d=" + d3.toFixed(4));

// 2. upsertCrossBranch 直接生成（确定性构造）
const factory = new HippocampusDbFactory();
const db = factory.getDb("unified");
const n1 = { id: "mem_a1", title: "记忆甲：模型 A 的训练", kind: "workstate" };
const n2 = { id: "mem_b1", title: "记忆乙：数据集清洗", kind: "insight" };
const n3 = { id: "mem_c1", title: "记忆丙：评估指标设计", kind: "insight" };
const n4 = { id: "mem_d1", title: "记忆丁：部署架构方案", kind: "other" };
// 先真实写入这 4 条（供链接与检索验证）
for (const n of [n1, n2, n3, n4]) {
  await db.writeBranch({ title: n.title, content: n.title + "的详细内容描述，用于联想交汇测试。", kind: n.kind, source: "user" });
}
db.setMeta("lastCrossAt", 0); // 绕过冷却
const made = await db.upsertCrossBranch(n1, n2, n3, n4, 0.03);
check("交汇分支新建", made === 1, "made=" + made);
const rows = db.db.prepare("SELECT * FROM branches WHERE title LIKE '⟡%' AND status='active'").all().map((r) => db.rowToBranch(r));
check("交汇分支真实入库", rows.length >= 1, "count=" + rows.length);
if (rows.length) {
  check("内容含 KEY 去重标记", String(rows[0].content).startsWith("KEY:"), String(rows[0].content).slice(0, 20));
  // 与 4 个源节点建了弱连接
  const links = db.db.prepare("SELECT a, b, weight FROM links WHERE a=? OR b=?").all(rows[0].id, rows[0].id);
  check("与 4 源节点弱连接", links.length >= 4, "links=" + links.length + " " + JSON.stringify(links.map((l) => l.weight.toFixed(2))));
  // 3. 去重：再次调用同组合 → 不新建
  const made2 = await db.upsertCrossBranch(n1, n2, n3, n4, 0.02);
  const rows2 = db.db.prepare("SELECT COUNT(*) c FROM branches WHERE title LIKE '⟡%' AND status='active'").get().c;
  check("同组合去重不新建", made2 === 0 && rows2 === 1, "made2=" + made2 + " count=" + rows2);
  // 4. 交汇分支可检索（词法命中标题）
  const sr = await db.searchBranches("联想交汇", 5);
  check("交汇分支可检索", sr.results.some((x) => x.branch.title.includes("⟡")), JSON.stringify(sr.results.map((x) => x.branch.title)));
}

// 5. crossLink 全链路（布局交叉检测，不崩且返回结构正确）
db.setMeta("lastCrossAt", 0);
const cl = await db.crossLink({ cooldownMs: 0, maxCreated: 1 });
check("crossLink 返回结构", typeof cl.created === "number" && ("skipped" in cl || cl.created >= 0), JSON.stringify(cl));

db.close();
console.log(failed === 0 ? "\n✅ 全部通过" : "\n❌ " + failed + " 项失败");
process.exit(failed === 0 ? 0 : 1);

// 海马体记忆核心逻辑独立测试
// 运行：node --import ./test/loader.mjs test/run.mjs
// 说明：
//   - 通过 loader.mjs 将 @deepseek-ai/* 宿主包替换为本地桩，从而在无 DSH 环境独立加载 lib/index.js
//   - 复用真实 DSH_HOME 的模型缓存（bge-small-zh），写入用一次性临时项目作用域，测后清理
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { HippocampusDb } from "../lib/index.js";

const DSH = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const rand = Math.random().toString(36).slice(2, 8);
const project = "C:/__hp_test_" + rand;
const storeDir = path.join(DSH, "storages", "hippocampus", "projects",
  crypto.createHash("md5").update(project).digest("hex"));

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log("  ✔ " + name); }
  else { failed++; console.log("  ✘ " + name + (extra ? "  → " + extra : "")); }
}
function t0() { return Date.now(); }
function ms(t) { return Date.now() - t; }

let db;
const started = t0();
try {
  console.log("· 初始化 HippocampusDb（临时项目作用域）");
  db = new HippocampusDb("project", project);
  check("建库 + 加载 sqlite-vec 扩展成功", true);

  console.log("· writeBranch（写入 + 语义向量）");
  const a = await db.writeBranch({ title: "用户偏好：中文交流", content: "用户偏好使用中文交流，代码注释与交付说明均使用中文。", kind: "preference", tags: ["偏好", "中文"], strength: 0.8 });
  const b = await db.writeBranch({ title: "当前任务：海马体插件", content: "正在实现 sqlite-vec 向量存储、bge 编码与三阶段检索。", kind: "workstate", tags: ["任务"], strength: 0.7 });
  const c = await db.writeBranch({ title: "技术洞察", content: "Transformers.js 可在纯 JS 环境运行 bge-small-zh 中文编码模型，输出 512 维归一化向量。", kind: "insight", tags: ["技术", "模型"], strength: 0.9 });
  check("三条记忆已写入", db.listBranches({}).branches.length === 3);
  check("自动生成 mem_ 前缀 id", [a, b, c].every((x) => typeof x.id === "string" && x.id.startsWith("mem_")));
  check("写入即建向量（embed 表有 3 行）", db.db.prepare("SELECT COUNT(*) c FROM memories").get().c === 3);

  console.log("· listBranches（词法过滤）");
  const lex = db.listBranches({ q: "中文" }).branches;
  check("词法命中「中文」", lex.some((x) => x.title.includes("中文")), JSON.stringify(lex.map((x) => x.title)));

  console.log("· searchBranches（三阶段：词法+语义+联想）");
  const tSearch = t0();
  const res = await db.searchBranches("用户平时习惯用哪种语言交流", 5);
  check("返回结果非空", res.results.length > 0);
  check("首条命中中文偏好记忆", res.results[0]?.branch?.title?.includes("中文") || res.results[0]?.branch?.title?.includes("偏好"),
    JSON.stringify(res.results.map((r) => r.branch.title + "(" + r.score + ")")));
  check("结果均带 0..1 分数", res.results.every((r) => typeof r.score === "number" && r.score >= 0 && r.score <= 1));
  console.log("     语义检索耗时 " + ms(tSearch) + "ms");

  console.log("· updateBranch（修正 + 历史 + 重嵌入）");
  const upd = await db.updateBranch(a.id, { strength: 0.95, content: "用户偏好使用中文交流，注释与交付说明均使用中文（全局规则）。" }, "user");
  check("修正后强度=0.95", upd.strength === 0.95, "strength=" + upd.strength);
  check("修正历史已记录", (upd.history ?? []).length >= 1);

  console.log("· getBranch（读取触发再巩固）");
  const g = db.getBranch(b.id);
  check("读取后强度提升(0.7→0.75)", Math.abs(g.branch.strength - 0.75) < 1e-9, "strength=" + g.branch.strength);

  console.log("· graphData / evolve");
  const g1 = db.graphData();
  check("图中 3 个节点", g1.nodes.length === 3, "nodes=" + g1.nodes.length);
  const g2 = db.evolve();
  check("演化后 epoch 递增", g2.meta.epoch > g1.meta.epoch, g1.meta.epoch + "→" + g2.meta.epoch);

  console.log("· removeBranch（归档 / 彻底删除）");
  const soft = db.removeBranch(c.id, false);
  check("归档成功（活跃 2 条）", soft.removed && !soft.hard && db.listBranches({}).branches.length === 2);
  check("归档可见于 includeArchived", db.listBranches({ includeArchived: true }).branches.length === 3);
  const hard = db.removeBranch(c.id, true);
  check("彻底删除（含向量，共 2 条）", hard.hard && db.listBranches({ includeArchived: true }).branches.length === 2
    && db.db.prepare("SELECT COUNT(*) c FROM memories").get().c === 2);

  console.log("· 作用域隔离（另一项目互不影响）");
  const other = new HippocampusDb("project", "C:/__hp_test_other_" + rand);
  check("其他项目为空库", other.listBranches({}).branches.length === 0);
  other.close();

  db.close();
  console.log("总耗时 " + ms(started) + "ms");
} catch (err) {
  failed++;
  console.log("  ✘ 异常: " + (err?.stack ?? err));
  try { db?.close(); } catch {}
}

// 清理临时项目存储
try { fs.rmSync(storeDir, { recursive: true, force: true }); } catch {}
try { fs.rmSync(path.join(DSH, "storages", "hippocampus", "projects",
  crypto.createHash("md5").update("C:/__hp_test_other_" + rand).digest("hex")), { recursive: true, force: true }); } catch {}

console.log("· 结果: " + passed + " 通过 / " + failed + " 失败");
process.exit(failed > 0 ? 1 : 0);

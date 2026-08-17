// 海马体记忆核心逻辑独立测试
// 运行：node --import ./test/register.mjs test/run.mjs
// 说明：
//   - 通过 loader.mjs 将 @deepseek-ai/* 宿主包替换为本地桩，从而在无 DSH 环境独立加载 lib/index.js
//   - v3.2 统一库后 project scope 也连统一 memory.db：为不污染真实记忆库，
//     测试使用隔离的临时 DSH_HOME（复用真实 DSH_HOME 的 bge 模型缓存），跑完整体删除
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { HippocampusDb } from "../lib/index.js";

// 隔离临时 DSH_HOME（复用真实库的模型缓存路径，通过 lib 的 modelCacheDir 逻辑决定）
const REAL_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hp-test-"));
process.env.DSH_HOME = tmpHome;
const DSH = tmpHome;
// 模型缓存仍指向真实 DSH_HOME（避免重新下载 bge-small-zh）
process.env.DSH_HIPPOCAMPUS_MODELS = path.join(REAL_HOME, "storages", "hippocampus", "models");
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
  check("自动生成 mem_ 前缀 id", [a, b, c].every((x) => typeof x.branch?.id === "string" && x.branch.id.startsWith("mem_")));
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
  const upd = await db.updateBranch(a.branch.id, { strength: 0.95, content: "用户偏好使用中文交流，注释与交付说明均使用中文（全局规则）。" }, "user");
  check("修正后强度=0.95", upd.strength === 0.95, "strength=" + upd.strength);
  check("修正历史已记录", (upd.history ?? []).length >= 1);

  console.log("· getBranch（读取触发再巩固）");
  const g = db.getBranch(b.branch.id);
  check("读取后强度提升(0.7→0.75)", Math.abs(g.branch.strength - 0.75) < 1e-9, "strength=" + g.branch.strength);

  console.log("· graphData / evolve");
  const g1 = db.graphData();
  check("图中 3 个节点", g1.nodes.length === 3, "nodes=" + g1.nodes.length);
  const g2 = await db.evolve();
  check("演化后 epoch 递增", g2.meta.epoch > g1.meta.epoch, g1.meta.epoch + "→" + g2.meta.epoch);

  console.log("· removeBranch（归档 / 彻底删除）");
  const soft = db.removeBranch(c.branch.id, false);
  check("归档成功（活跃 2 条）", soft.removed && !soft.hard && db.listBranches({}).branches.length === 2);
  check("归档可见于 includeArchived", db.listBranches({ includeArchived: true }).branches.length === 3);
  const hard = db.removeBranch(c.branch.id, true);
  check("彻底删除（含向量，共 2 条）", hard.hard && db.listBranches({ includeArchived: true }).branches.length === 2
    && db.db.prepare("SELECT COUNT(*) c FROM memories").get().c === 2);

  console.log("· 统一记忆库（项目作用域共享同一库，跨项目打通）");
  const other = new HippocampusDb("project", "C:/__hp_test_other_" + rand);
  check("统一库跨项目打通（另一项目可见同库 2 条）", other.listBranches({}).branches.length === 2);
  other.close();

  db.close();
  console.log("总耗时 " + ms(started) + "ms");

  // ---- v4：深度加工新增测试 ----
  console.log("");
  console.log("=== v4 深度加工专项测试 ===");
  const db2 = new HippocampusDb("project", "C:/__hp_v4test_" + rand);
  try {
    // 写入测试数据（含高相似重复，触发冗余检测）
    await db2.writeBranch({ title: "用户偏好：中文交流", content: "用户偏好使用中文交流", kind: "preference", strength: 0.8 });
    await db2.writeBranch({ title: "用户偏好：中文沟通", content: "用户偏好使用中文沟通", kind: "preference", strength: 0.7 });
    await db2.writeBranch({ title: "项目任务：海马体插件", content: "正在实现海马体插件 v4", kind: "workstate", strength: 0.7 });
    await db2.writeBranch({ title: "技术洞察：sqlite-vec", content: "sqlite-vec 支持 512 维向量检索", kind: "insight", strength: 0.9 });
    await db2.writeBranch({ title: "技术洞察：bge 模型", content: "bge-small-zh 输出 512 维归一化向量", kind: "insight", strength: 0.85 });

    // 1. analyze() 非破坏分析
    console.log("· analyze() 非破坏分析");
    const ana = await db2.analyze();
    check("analyze 返回 nodes", ana.nodes >= 4, "nodes=" + ana.nodes);
    check("analyze 返回 links", typeof ana.links === "number", "links=" + ana.links);
    check("analyze 返回 entropy", ana.entropy > 0, "entropy=" + ana.entropy);
    check("analyze 返回 health", ana.health >= 0 && ana.health <= 1, "health=" + ana.health);
    check("analyze 返回 decayCurve 三字段", typeof ana.decayCurve.weak === "number" && typeof ana.decayCurve.mid === "number" && typeof ana.decayCurve.strong === "number");
    check("analyze 返回冗余检测", typeof ana.redundancy.pairs === "number", "pairs=" + ana.redundancy.pairs);
    check("analyze 返回 meta", typeof ana.meta?.epoch === "number", "epoch=" + ana.meta?.epoch);
    console.log("     健康度 " + ana.health + " 熵 " + ana.entropy + " 冗余 " + ana.redundancy.pairs + " 强度弱/中/强 " + ana.decayCurve.weak + "/" + ana.decayCurve.mid + "/" + ana.decayCurve.strong);

    // 2. drill() 演化演练
    console.log("· drill() 演化演练");
    const dr = await db2.drill();
    check("drill 包含 simulation", typeof dr.simulation === "object", JSON.stringify(dr.simulation));
    check("drill simulation 有 mergeCandidates", typeof dr.simulation.mergeCandidates === "number");
    check("drill simulation 有 recommended", typeof dr.simulation.recommended === "boolean");
    if (dr.simulation) console.log("     演练建议：推荐演化=" + dr.simulation.recommended + " 可合并冗余=" + dr.simulation.mergeCandidates);

    // 3. evolog 表创建
    console.log("· evolog 演化日志表");
    const evoMeta = db2.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='evolog'").get();
    check("evolog 表存在", !!evoMeta, JSON.stringify(evoMeta));

    // 4. evolve() 应写入 evolog
    console.log("· evolve() 写入 evolog");
    const evoRes = await db2.evolve();
    const evoLogRow = db2.db.prepare("SELECT COUNT(*) c FROM evolog").get();
    check("evolve 后 evolog 有记录", evoLogRow.c >= 1, "count=" + evoLogRow.c);
    check("evolve 返回 fitnessAfter", typeof evoRes.fitnessAfter === "number", "fitness=" + evoRes.fitnessAfter);
    check("evolve 返回 lr", typeof evoRes.lr === "number", "lr=" + evoRes.lr);
    check("evolve 返回 drift", typeof evoRes.drift === "number", "drift=" + evoRes.drift);
    console.log("     fitness " + evoRes.fitnessAfter + " lr " + evoRes.lr + " drift " + evoRes.drift);

    // 5. learningRate()
    console.log("· learningRate() 自适应学习率");
    const lr = db2.learningRate();
    check("learningRate 在有界范围内", lr >= 0.002 && lr <= 0.08, "lr=" + lr);

    // 6. searchBranches 返回 signals
    console.log("· searchBranches 真实共激活 signals");
    const sr = await db2.searchBranches("用户平时用什么语言", 5);
    check("search 返回 signals", typeof sr.signals === "object", JSON.stringify(sr.signals));
    check("signals 含 hits 数组", Array.isArray(sr.signals?.hits), "hits=" + JSON.stringify(sr.signals?.hits));
    check("signals 含 edges 数组", Array.isArray(sr.signals?.edges), "edges=" + JSON.stringify(sr.signals?.edges));
    check("signals 含 transmitted 计数", typeof sr.signals?.transmitted === "number", "tx=" + sr.signals?.transmitted);
    if (sr.signals?.edges?.length > 0) {
      console.log("     共激活边 " + sr.signals.edges.length + " 条");
    }

    // 7. feedTrajectory + autoRefineWorkstate
    console.log("· feedTrajectory + autoRefineWorkstate");
    const events = [
      { type: "user/message", time: Date.now() - 60000, content: [{ type: "text", text: "请帮我完成海马体 v4 深度加工" }] },
      { type: "assistant/message", time: Date.now() - 30000, content: [{ type: "text", text: "好的，正在实现架构稳定与读取速率优化" }] },
      { type: "tool/result", time: Date.now() - 10000, content: [{ type: "text", text: "代码已修改，运行测试通过" }] }
    ];
    const feedRes = await db2.feedTrajectory(events, "test_session_1", project);
    check("喂养返回 fed 计数", feedRes.fed > 0, "fed=" + feedRes.fed);
    check("喂养返回 writes 状态", feedRes.wrote !== undefined, "wrote=" + feedRes.wrote);
    // 检查自动工作状态
    const ws = db2.db.prepare("SELECT * FROM branches WHERE kind='workstate' AND status='active'").all().map((r) => db2.rowToBranch(r));
    const hasAutoState = ws.some((b) => String(b.content).includes("海马体 v4"));
    check("autoRefineWorkstate 提炼了当前工作状态", hasAutoState, "workstate count=" + ws.length + " content=" + ws.map((x) => x.content?.slice(0, 30)).join("|"));

    // 8. 查询向量 LRU
    console.log("· getQvec 查询向量 LRU");
    const qv1 = await db2.getQvec("用户中文交流");
    check("getQvec 返回 vec 对象", !!qv1 && !!qv1.vec, "qv=" + !!qv1);
    if (qv1) {
      const qv2 = await db2.getQvec("用户中文交流");
      check("LRU 缓存命中（同一查询返回同一对象）", qv2 && qv2.vec === qv1.vec, "identical=" + (qv2?.vec === qv1.vec));
    }

    // 9. 完整性检查
    console.log("· checkIntegrity 启动完整性检查");
    db2.checkIntegrity();
    const integrityOk = db2.getMeta("integrityOk", true);
    check("完整性检查通过", integrityOk === true, "integrityOk=" + integrityOk);

    // 10. 间隔重复衰减检查
    console.log("· applyDecay 间隔重复衰减");
    // 手动设置一个旧节点使其触发衰减
    db2.db.prepare("UPDATE branches SET last_access_at=?, strength=? WHERE title=?").run(Date.now() - 5 * 86400000, 0.5, "技术洞察：sqlite-vec");
    const decayRes = db2.applyDecay();
    check("applyDecay 返回 updated 对象", typeof decayRes.updated === "number", "updated=" + decayRes.updated);

    // 11. v4.1 项目精准度：检索项目聚焦 + 去重/合并不跨项目误并
    console.log("· v4.1 项目精准度（检索项目聚焦 + 同项目去重）");
    const v4testProj = "C:/__hp_v4test_" + rand;     // 即 db2.projectPath（当前项目）
    const v4otherProj = "C:/__hp_v4other_" + rand;    // 另一项目
    const dupText = "项目Alpha 缓存方案：采用 Redis + 预热缓存键";
    // A 项目写入
    const wA = await db2.writeBranch({ title: "缓存方案", content: dupText, kind: "insight", scopePath: v4testProj, strength: 0.8 });
    // 再写一条跨项目的高相似记忆 —— 不应被误合并
    const wB = await db2.writeBranch({ title: "缓存方案", content: dupText, kind: "insight", scopePath: v4otherProj, strength: 0.8 });
    check("跨项目高相似记忆不合并（两边 dedup=false）", wA.dedup === false && wB.dedup === false,
      "wA.dedup=" + wA.dedup + " wB.dedup=" + wB.dedup);
    const prjDupCnt = db2.db.prepare("SELECT COUNT(*) c FROM branches WHERE kind='insight' AND content LIKE ? AND status='active'").get("%项目Alpha 缓存方案%");
    check("两条跨项目记忆均保留", prjDupCnt.c === 2, "c=" + prjDupCnt.c);
    // 当前项目(项目A=db2.projectPath)检索：A 记忆应优先于 B
    const prjSr = await db2.searchBranches("项目Alpha 缓存方案", 5);
    const prjFirst = prjSr.results[0]?.branch;
    check("检索时当前项目(A)记忆优先召回", prjFirst?.scopePath === v4testProj,
      "first.scope=" + prjFirst?.scopePath + " (期望 " + v4testProj + ")");
    const prjAHit = prjSr.results.find((r) => r.branch?.scopePath === v4testProj);
    const prjBHit = prjSr.results.find((r) => r.branch?.scopePath === v4otherProj);
    check("同查询下 A 命中分 > B 命中分", prjAHit && prjBHit && prjAHit.score > prjBHit.score,
      "A=" + prjAHit?.score + " B=" + prjBHit?.score);

    db2.close();
  } catch (err) {
    failed++;
    console.log("  ✘ v4 异常: " + (err?.stack ?? err));
    try { db2?.close(); } catch {}
  }

  console.log("v4 测试完成");
  console.log("");
} catch (err) {
  failed++;
  console.log("  ✘ 异常: " + (err?.stack ?? err));
  try { db?.close(); } catch {}
}

// 清理临时项目存储
try { fs.rmSync(storeDir, { recursive: true, force: true }); } catch {}
try { fs.rmSync(path.join(DSH, "storages", "hippocampus", "projects",
  crypto.createHash("md5").update("C:/__hp_test_other_" + rand).digest("hex")), { recursive: true, force: true }); } catch {}
try { fs.rmSync(path.join(DSH, "storages", "hippocampus", "projects",
  crypto.createHash("md5").update("C:/__hp_v4test_" + rand).digest("hex")), { recursive: true, force: true }); } catch {}

console.log("· 结果: " + passed + " 通过 / " + failed + " 失败");
process.exit(failed > 0 ? 1 : 0);

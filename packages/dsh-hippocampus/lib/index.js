// 海马体记忆 Agent —— 服务端半边（node half）v4（Wazome Memory Network v4.0）
// ---------------------------------------------------------------------------
// SQLite-vec 向量存储 + Transformers.js(bge) 语义编码 + 遗忘衰减 + 三阶段检索
// v3 深度完善（作为 Agent 的辅助插件，强化项目文件夹记忆、缓解上下文污染）：
//   1. 修复 v2 工具输出 schema 过窄导致 memory_* 全部校验失败的问题
//   2. 修复 v2 语义检索 rowid 映射 bug（vec0 MATCH 返回数字 rowid，而分支以
//      uid 为键，导致语义阶段从未命中）——去重/链接/语义检索全部恢复真实命中
//   3. 持久化「突触」links 表：写入建立连接（Hebbian）、检索共激活强化、
//      联想扩散同时走向量与突触连接、弱连接可修剪 —— 可视化边为真实数据
//   4. 去重合并：写入时检测高相似记忆（≥0.9 同种类）→ 强化原记忆而非重复入库；
//      evolve 演化跨分支合并近重复（≥0.9）
//   5. 自动标签：写入时按高频词 + 种类默认标签生成 tags
//   6. 项目记忆（绑定工作区文件夹）：project 作用域按 session cwd MD5 隔离，
//      每个工作区文件夹一个独立记忆网络，存储上限 1GB（超限自动优化）；
//      global 全局记忆仅用于偏好/性格/需求信息（workstate 强制走项目）
//   7. v3.1 每小时自动「轨迹喂养」：读取活跃项目最近会话事件 → 自动提炼
//      关键句与高频词 → upsert 会话精华分支 → 过期清理 → 超限检查
//   8. 过期记忆（>30 天）：检索降权（×0.55）聚焦当前项目与进度；弱过期
//      自动归档/删除；超限优化时「先提炼精华喂养，再删除过期无效记忆」
//   9. 新工具：memory_stats / memory_context / memory_evolve
// v4 深度加工（架构稳定 × 读取速率 × 训练效果 × 自循环进化演练）：
//   10. 架构稳定：预编译语句缓存、查询索引、PRAGMA 调优（synchronous/cache/
//       mmap/temp_store）、多写事务包裹、启动 quick_check 完整性校验、
//       注册表写入防抖（避免每次 touch 同步写盘）
//   11. 读取速率：遗忘衰减单条 SQL 批量更新（替代逐行循环）；buildMeta
//       短时缓存（2s）；查询向量 LRU 缓存（重复搜索免重编码）；检索/联想
//       复用活动快照，避免同一检索多次全表查询
//   12. 训练效果：间隔重复衰减（强度越高衰减越慢）；自适应再巩固（命中越
//       相关强化越多）；自适应学习率（依 fitness 趋势涨跌）；喂养跨小时
//       窗口去重合并（修复「会话精华 22时/00时 相似度 1.00」重复分支）；
//       喂养自动提炼工作状态分支
//   13. 自循环进化演练：evolog 演化日志表；analyze()/drill() 非破坏分析
//       （冗余/熵/衰减曲线/漂移/可合并候选）；memory_analyze 工具；
//       定时自动演化（按漂移门控，默认 6h）
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { getLoadablePath } from "sqlite-vec";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { defineTool } from "@deepseek-ai/dsh-tools";

/** Cordis 插件元信息 */
export const name = "hippocampus";
export const inject = ["tools"];

// ---------------------------------------------------------------------------
// 常量与工具函数
// ---------------------------------------------------------------------------

/** 记忆分支的种类（顺序即可视化图层顺序） */
export const KINDS = ["preference", "communication", "workstate", "insight", "other"];
export const KIND_LABELS = {
  preference: "偏好",
  communication: "交流方式",
  workstate: "工作状态",
  insight: "洞察",
  other: "其他"
};
/** 中文种类标签 → 种类 key（Markdown 导入用） */
const KIND_BY_LABEL = {
  偏好: "preference",
  交流方式: "communication",
  工作状态: "workstate",
  洞察: "insight",
  其他: "other"
};
/** 解析 Markdown 导出格式（## 标题 / _种类·标签·强度_ / 正文）为分支列表 */
function parseMarkdownExport(text) {
  const out = [];
  let cur = null;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const h = /^##\s+(.+)$/.exec(line);
    if (h) {
      if (cur) out.push(cur);
      cur = { title: h[1].trim(), content: "", kind: "other", tags: [], strength: 0.6 };
      continue;
    }
    const meta = /^_种类:\s*(.+?)\s*·\s*标签:\s*(.*?)\s*·\s*强度:\s*([\d.]+)/.exec(line);
    if (meta && cur) {
      cur.kind = KIND_BY_LABEL[meta[1].trim()] ?? "other";
      cur.tags = meta[2].split(/[,，]/).map((t) => t.trim()).filter(Boolean);
      cur.strength = clamp(Number(meta[3]) || 0.6, 0, 1);
      continue;
    }
    if (cur && line.trim() && !/^---$/.test(line.trim())) {
      cur.content += (cur.content ? "\n" : "") + line;
    }
  }
  if (cur) out.push(cur);
  return out;
}

const DAY_MS = 86400000;
/** 每日遗忘系数：强度每天衰减到 0.995（艾宾浩斯式遗忘曲线） */
const DECAY_PER_DAY = 0.995;
/** 读取/搜索时的再巩固增量 */
const RECONSOLIDATE_BOOST = 0.05;
/** 强度下限 */
const STRENGTH_FLOOR = 0.05;
/** 历史记录条数上限 */
const HISTORY_LIMIT = 20;
/** bge-small-zh-v1.5 输出维度 */
const EMBED_DIM = 512;
/** 语义检索 top-k / 词法检索 top-k */
const VEC_TOP_K = 24;
const LEX_TOP_K = 24;
/** 融合权重：语义 0.65 / 词法 0.35 */
const W_SEM = 0.65;
const W_LEX = 0.35;
/** 联想展开：从命中点沿相似图扩散的深度 */
const ASSOC_DEPTH = 2;
const ASSOC_TOP_K = 8;
// ---- v4.1 项目精准度：统一库内区分「当前项目记忆」与「跨项目记忆」 ----
// 目标：既保留统一库跨项目沉淀价值，又把「掌握当前项目」提回第一优先级——
// 检索当前项目记忆加分优先召回，其他项目记忆降权但不隔离；去重/合并不做跨项目误并。
/** 命中「当前项目」记忆的项目相关性倍率（>1，检索加分） */
const PROJECT_HIT_W = 1.3;
/** 命中「其他项目」记忆的项目相关性倍率（<1，检索降权；偏好/交流/无项目全局记忆不降权） */
const PROJECT_MISS_W = 0.55;
/** 写入去重阈值（同种类相似度 ≥ 该值 → 合并强化原记忆） */
const DEDUP_THRESHOLD = 0.9;
/** 演化合并阈值（跨分支近重复） */
const MERGE_THRESHOLD = 0.9;
/** 弱连接修剪阈值 */
const LINK_PRUNE_THRESHOLD = 0.12;
/** 修剪弱记忆：强度下限 + 年龄下限（天） */
const PRUNE_STRENGTH = 0.15;
const PRUNE_AGE_DAYS = 14;
// ---- v3.1：自动喂养 / 存储上限 / 过期清理 ----
/** 轨迹自动喂养间隔（默认 1 小时；可用环境变量 DSH_HIPPOCAMPUS_FEED_MS 覆盖，便于测试） */
const FEED_INTERVAL_MS = Number(process.env.DSH_HIPPOCAMPUS_FEED_MS) || 3600000;
/** 单个工作区文件夹项目记忆库存储上限（默认 1GB；可用 DSH_HIPPOCAMPUS_SIZE_LIMIT 覆盖，单位字节） */
const SIZE_LIMIT_BYTES = Number(process.env.DSH_HIPPOCAMPUS_SIZE_LIMIT) || 1024 * 1024 * 1024;
/** 过期阈值：超过该天数的记忆视为过期信息（检索降权 / 弱记忆自动清理） */
const STALE_DAYS = 30;
/** 过期且强度低于该值 → 自动归档（保留历史） */
const STALE_ARCHIVE_STRENGTH = 0.35;
/** 过期且强度低于该值 → 彻底删除（含向量） */
const STALE_DELETE_STRENGTH = 0.1;
/** 归档超过该天数 → 彻底删除（含向量） */
const STALE_RETENTION_DAYS = 90;
/** 单次喂养提炼的轨迹文本上限（字符） */
const FEED_TEXT_LIMIT = 6000;
/** 喂养时注册的项目活跃窗口（毫秒，默认 48h） */
const REGISTRY_ACTIVE_WINDOW_MS = 48 * 3600000;
/** 记忆网络活跃节点上限（默认 1000；可用 DSH_HIPPOCAMPUS_MAX_NODES 覆盖）—— 超出自动淘汰最弱 */
const MAX_NODES = Number(process.env.DSH_HIPPOCAMPUS_MAX_NODES) || 1000;
// ---- v3.3：球形神经网络 / 动态连接 / 永久核心 ----
/** 连接 TTL：两个节点超过该天数没有交互传输则断开连接（默认 3 天） */
const LINK_TTL_DAYS = 3;
/** 偏好/交流 ↔ 工作区目录 的永久连接权重 */
const PERM_LINK_WEIGHT = 0.55;
/** 工作区目录节点的 id 前缀（与记忆分支 uid 区分） */
const WORKDIR_PREFIX = "wd:";
/** 信号句关键词（自动提炼用） */
const SIGNAL_WORDS = ["记住", "偏好", "喜欢", "不喜欢", "决定", "结论", "下一步", "计划", "注意", "问题", "完成", "修复", "实现", "新增", "重构", "目标", "进度", "阶段", "卡住", "阻塞", "建议", "需要", "改为", "使用"];
/** 停止词（自动标签用） */
const STOP_WORDS = new Set(["的", "了", "是", "我", "你", "他", "她", "它", "我们", "你们", "他们", "在", "和", "与", "或", "一个", "这个", "那个", "进行", "使用", "可以", "需要", "没有", "已经", "正在", "工作", "任务", "项目", "记忆", "海马体", "状态", "偏好", "交流", "洞察", "其他", "中", "上", "下", "里", "后", "前", "时", "会", "要", "能", "被", "把", "让", "对", "从", "到", "去", "说", "做", "看"]);
// ---- v4：深度加工参数 ----
/** 间隔重复衰减：强度越高衰减越慢 —— 指数缩放范围（k = clamp(1/(0.4+strength), MIN, MAX)） */
const SPACE_DECAY_MIN = 0.25;
const SPACE_DECAY_MAX = 1.4;
/** 自适应学习率上下界（随 fitness 趋势涨跌，参与合并/巩固的增量缩放） */
const LR_MIN = 0.002;
const LR_MAX = 0.08;
const LR_DEFAULT = 0.01;
/** 自循环自动演化间隔（默认 6h；可用 DSH_HIPPOCAMPUS_EVOLVE_MS 覆盖，便于测试） */
const EVOLVE_INTERVAL_MS = Number(process.env.DSH_HIPPOCAMPUS_EVOLVE_MS) || 6 * 3600000;
/** 触发自动演化的最小漂移：距上次演化的新增/修改分支数低于该值则跳过（免无谓演化） */
const EVOLVE_MIN_DRIFT = 3;
/** 查询向量 LRU 缓存上限（重复检索免重编码，显著提升读取速率） */
const QVEC_CACHE_MAX = 64;
/** buildMeta 统计缓存毫秒（list/stats/context 高频调用时降低重复查询） */
const META_CACHE_MS = 2000;
/** 演化日志保留条数 */
const EVOLOG_KEEP = 30;
/** 注入日志保留条数（对话前自动 / 工具 / 界面刷新的留痕） */
const INJECT_LOG_KEEP = 100;
/** 自分析冗余扫描采样条数（按强度取 top N） */
const ANALYZE_SAMPLE = 40;
/** 喂养自动提炼工作状态（默认开；DSH_HIPPOCAMPUS_AUTO_STATE=0 关闭） */
const AUTO_STATE = process.env.DSH_HIPPOCAMPUS_AUTO_STATE !== "0";

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}
/**
 * v3.2 统一记忆库：所有信息内容记忆在同一记录中（同一 memory.db），
 * 不再按工作区文件夹分目录隔离 —— 实现不同工作区目录间的记忆打通。
 * scope/scopePath 参数保留仅为向后兼容，读写均落到统一库。
 */
function storeDir(scope, projectPath) {
  return path.join(dshHome(), "storages", "hippocampus");
}
function dbFile(scope, projectPath) {
  return path.join(storeDir(scope, projectPath), "memory.db");
}
function legacyJsonFile(scope, projectPath) {
  return path.join(storeDir(scope, projectPath), "memory.json");
}
function modelCacheDir() {
  // v4：支持 DSH_HIPPOCAMPUS_MODELS 覆盖（测试复用真实模型缓存、自定义缓存目录）
  return process.env.DSH_HIPPOCAMPUS_MODELS || path.join(dshHome(), "storages", "hippocampus", "models");
}
function now() {
  return Date.now();
}
function newId() {
  return "mem_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}
function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
/** 字符串哈希 → 0..1（3D 球形坐标的稳定随机源） */
function hashOf(str) {
  let x = 0;
  for (let i = 0; i < str.length; i++) x = (x * 31 + str.charCodeAt(i)) >>> 0;
  return x / 4294967296;
}

/**
 * v5.5 3D 线段间最短距离（参数化钳制法）：
 * 用于检测两条「联想连线」在球坐标空间是否交汇 —— 交汇即「思维路径交叉」。
 */
function segSegDist3(a, b, c, d) {
  const ax = b.x - a.x, ay = b.y - a.y, az = b.z - a.z;
  const cx = d.x - c.x, cy = d.y - c.y, cz = d.z - c.z;
  const rx = a.x - c.x, ry = a.y - c.y, rz = a.z - c.z;
  const A = ax * ax + ay * ay + az * az;
  const E = cx * cx + cy * cy + cz * cz;
  const F = cx * rx + cy * ry + cz * rz;
  const C = ax * rx + ay * ry + az * rz;
  const B = ax * cx + ay * cy + az * cz;
  const D = A * E - B * B;
  let s, t;
  if (D > 1e-9) {
    s = Math.min(1, Math.max(0, (B * F - C * E) / D));
  } else {
    s = 0;
  }
  t = (B * s + F) / (E || 1e-9);
  if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -C / (A || 1e-9))); }
  else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (B - C) / (A || 1e-9))); }
  const px = a.x + ax * s, py = a.y + ay * s, pz = a.z + az * s;
  const qx = c.x + cx * t, qy = c.y + cy * t, qz = c.z + cz * t;
  const dx = px - qx, dy = py - qy, dz = pz - qz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
/** 简单 LRU 缓存（有界；读取速率优化的基础设施） */
class LruCache {
  constructor(max = 64) {
    this.max = max;
    this.map = new Map();
  }
  get(key) {
    const v = this.map.get(key);
    if (v === void 0) return void 0;
    // 命中即移到末尾（LRU）
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }
  clear() {
    this.map.clear();
  }
}
/** 安全解析 JSON 数组（数据损坏时回退默认值，避免崩溃） */
function safeJsonArray(raw, def) {
  try {
    const v = JSON.parse(raw ?? def);
    return Array.isArray(v) ? v : JSON.parse(def);
  } catch {
    return JSON.parse(def);
  }
}

/**
 * v5.4 激活锚点（工作记忆延续）：
 * 人脑的「工作记忆」—— 当前任务中被激活的记忆在短时内保持高可用（priming 效应）。
 * 检索/读取/对话注入命中某记忆 → 该记忆成为激活锚点；随后检索按锚点加权
 * （提高「接着上次想」的召回）、注入优先携带锚点记忆，形成跨轮的思考连续性。
 * 锚点带强度与 TTL（默认 10 分钟），容量受限，最弱/最旧自动淘汰。
 */
class AnchorBank {
  constructor({ ttlMs = 10 * 60000, max = 24 } = {}) {
    this.map = new Map(); // id -> { weight, at }
    this.ttlMs = ttlMs;
    this.max = max;
  }
  /** 激活一批记忆（增量合并强度、刷新时间） */
  activate(ids, base = 0.5) {
    if (!Array.isArray(ids)) return;
    const nowMs = now();
    for (const id of ids) {
      if (typeof id !== "string" || !id) continue;
      const cur = this.map.get(id);
      const w = clamp((cur ? cur.weight : 0) + base, 0, 1);
      this.map.set(id, { weight: w, at: nowMs });
    }
    this._evict(nowMs);
  }
  /** 是否锚定 */
  has(id) {
    const a = this.map.get(id);
    return !!a && now() - a.at < this.ttlMs;
  }
  /** 锚点当前强度（随时间线性衰减到 50%；过期 0） */
  weight(id) {
    const a = this.map.get(id);
    if (!a) return 0;
    const age = (now() - a.at) / this.ttlMs;
    if (age >= 1) return 0;
    return a.weight * (1 - age * 0.5);
  }
  /** 当前锚点列表（按强度排序，限 limit） */
  list(limit = 16) {
    const nowMs = now();
    return [...this.map.entries()]
      .map(([id, a]) => ({ id, weight: a.weight, at: a.at, alive: nowMs - a.at < this.ttlMs }))
      .filter((x) => x.alive)
      .sort((a, b) => b.weight - a.weight || a.at - b.at)
      .slice(0, limit);
  }
  /** 超过容量 1.5 倍时淘汰最弱/最旧 */
  _evict(nowMs) {
    if (this.map.size <= this.max * 1.5) return;
    const items = [...this.map.entries()].sort((a, b) =>
      (b[1].weight - a[1].weight) || (a[1].at - b[1].at));
    while (this.map.size > this.max && items.length) {
      const [id] = items.pop();
      this.map.delete(id);
    }
  }
  /** 清理过期锚点（定时/注入前调用） */
  purge(nowMs = now()) {
    for (const [id, a] of this.map) {
      if (nowMs - a.at > this.ttlMs) this.map.delete(id);
    }
  }
  clear() {
    this.map.clear();
  }
}
/** 简单分词：拉丁词 + 中文单字与二元组 */
function tokensOf(text) {
  const s = String(text ?? "");
  const latin = (s.toLowerCase().match(/[a-z0-9_]+/g) ?? []);
  const cjk = (s.match(/[\u4e00-\u9fff]+/g) ?? []).flatMap((seg) => {
    const out = [];
    for (let i = 0; i < seg.length; i++) out.push(seg[i]);
    for (let i = 0; i < seg.length - 1; i++) out.push(seg.slice(i, i + 2));
    return out;
  });
  return [...latin, ...cjk];
}

/** 词法评分：查询词 × 字段权重，归一化到 0..1 */
function scoreQuery(branch, queryTokens) {
  if (queryTokens.length === 0) return 0;
  const title = String(branch.title ?? "").toLowerCase();
  const content = String(branch.content ?? "").toLowerCase();
  const tags = (branch.tags ?? []).join(" ").toLowerCase();
  let score = 0;
  for (const tok of queryTokens) {
    let best = 0;
    if (title === tok) best = Math.max(best, 1.0);
    if (title.includes(tok)) best = Math.max(best, 0.7);
    if (tags.includes(tok)) best = Math.max(best, 0.85);
    if (content.includes(tok)) best = Math.max(best, 0.45);
    score += best;
  }
  return score / queryTokens.length;
}

/** 自动标签：高频词（跳过停止词/单字噪声）+ 种类默认标签 */
function autoTags(title, content, kind) {
  const text = String((title ?? "") + " " + (content ?? "")).toLowerCase();
  const freq = new Map();
  const latin = (text.match(/[a-z0-9_]{2,}/g) ?? []);
  const bigrams = (text.match(/[\u4e00-\u9fff]+/g) ?? []).flatMap((seg) => {
    const out = [];
    for (let i = 0; i < seg.length - 1; i++) out.push(seg.slice(i, i + 2));
    return out;
  });
  for (const tok of [...latin, ...bigrams]) {
    if (STOP_WORDS.has(tok)) continue;
    freq.set(tok, (freq.get(tok) ?? 0) + 1);
  }
  const picked = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tok]) => tok);
  const kindDefaults = {
    preference: ["偏好"],
    communication: ["交流"],
    workstate: ["状态"],
    insight: ["洞察"],
    other: []
  }[kind] ?? [];
  return [...new Set([...kindDefaults, ...picked])].slice(0, 8);
}

// ---------------------------------------------------------------------------
// v3.1：轨迹文本自动提炼（无 LLM 启发式：关键句 + 高频词 + 角色时间线）
// ---------------------------------------------------------------------------

/** 防御性提取消息 content 块中的文本 */
function extractBlocks(content, out) {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") out.push(block.text);
    else if (block.type === "image") out.push("（图片）");
    else if (Array.isArray(block.content)) extractBlocks(block.content, out);
  }
}

/** 提取消息文本（兼容 user/message、assistant/message、tool/result、UserMessage 各种 data 形状） */
function messageTextOf(ev) {
  const out = [];
  const data = ev?.data ?? ev;
  if (Array.isArray(data?.content)) extractBlocks(data.content, out);
  if (data?.message && Array.isArray(data.message.content)) extractBlocks(data.message.content, out);
  if (typeof data?.text === "string") out.push(data.text);
  if (typeof data?.content === "string") out.push(data.content); // UserMessage 的 content 可能是纯文本
  return out.join(" ").replace(/\s+/g, " ").trim();
}

/** 切句：按中文句号/感叹号/问号/换行 */
function splitSentences(text) {
  return String(text ?? "").split(/[。！？!?\n]+/).map((s) => s.trim()).filter((s) => s.length >= 4);
}

/** 信号句：包含信号词的句子，最多 n 句 */
function extractSignalSentences(text, n = 5) {
  const hits = [];
  for (const sent of splitSentences(text)) {
    if (SIGNAL_WORDS.some((w) => sent.includes(w))) {
      hits.push(sent.length > 160 ? sent.slice(0, 160) + "…" : sent);
      if (hits.length >= n) break;
    }
  }
  return hits;
}

/** 高频词：top n（跳过停止词/纯数字/单字噪声） */
function extractKeywords(text, n = 8) {
  const freq = new Map();
  const latin = (text.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []).filter((t) => !/^\d+$/.test(t));
  const bigrams = (text.match(/[\u4e00-\u9fff]+/g) ?? []).flatMap((seg) => {
    const out = [];
    for (let i = 0; i < seg.length - 1; i++) out.push(seg.slice(i, i + 2));
    return out;
  });
  for (const tok of [...latin, ...bigrams]) {
    if (STOP_WORDS.has(tok)) continue;
    freq.set(tok, (freq.get(tok) ?? 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([tok]) => tok);
}

/** 将最近事件序列提炼为喂养文本（全部内容扫信号句/高频词，时间线保留最新部分） */
function distillTrajectory(events, limit = FEED_TEXT_LIMIT) {
  const lines = [];
  for (const ev of events) {
    const role = ev.type === "user/message" ? "用户"
      : ev.type === "assistant/message" ? "助手"
        : ev.type === "tool/result" ? "工具" : null;
    if (!role) continue;
    const text = messageTextOf(ev);
    if (!text) continue;
    const time = ev.time ? new Date(ev.time).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "";
    const line = "[" + role + " " + time + "] " + (text.length > 600 ? text.slice(0, 600) + "…" : text);
    lines.push(line);
  }
  if (lines.length === 0) return "";
  // 信号句 / 高频词来自全部内容（长对话也不会漏掉关键信息）
  const fullText = lines.join("\n");
  const signals = extractSignalSentences(fullText, 6);
  const keywords = extractKeywords(fullText, 10);
  // 时间线保留【最新】部分（最新进度最有价值）
  let kept = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (total + line.length + 1 > limit) break;
    kept.push(line);
    total += line.length + 1;
  }
  kept.reverse();
  const head = ["【轨迹自动喂养】",
    signals.length ? "◆ 关键句：\n" + signals.map((s) => "· " + s).join("\n") : "",
    keywords.length ? "◇ 高频词：" + keywords.join("、") : ""
  ].filter(Boolean).join("\n");
  return (head + "\n\n" + kept.join("\n")).slice(0, limit * 2);
}

// ---------------------------------------------------------------------------
// 语义编码器（Transformers.js + bge-small-zh-v1.5）
// ---------------------------------------------------------------------------

let extractorPromise = null;
let extractorOk = false;
// v5.2 稳定性：模型加载失败冷却（毫秒）—— 失败风暴时避免每次调用都重试下载/加载
let extractorFailAt = 0;
const EXTRACTOR_FAIL_COOLDOWN_MS = 60000;
/** 单次推理超时：超出视为失败降级词法（防模型卡死阻塞写/检索路径） */
const EMBED_TIMEOUT_MS = 20000;

async function getExtractor() {
  if (extractorOk && extractorPromise) return extractorPromise;
  if (extractorPromise) return extractorPromise;
  // 失败冷却期内直接抛错（调用方降级词法），不重复加载
  if (extractorFailAt && now() < extractorFailAt) {
    const err = new Error("embedding 模型加载冷却中");
    err.cooldown = true;
    throw err;
  }
  extractorPromise = (async () => {
    const { pipeline, env } = await import("@xenova/transformers");
    env.remoteHost = process.env.HF_ENDPOINT || "https://hf-mirror.com/";
    env.cacheDir = modelCacheDir();
    env.allowLocalModels = false;
    return await pipeline("feature-extraction", "Xenova/bge-small-zh-v1.5");
  })();
  try {
    await extractorPromise;
    extractorOk = true;
    extractorFailAt = 0;
  } catch (err) {
    extractorPromise = null;
    extractorFailAt = now() + EXTRACTOR_FAIL_COOLDOWN_MS;
    throw err;
  }
  return extractorPromise;
}

// v5.2 并发队列：Transformers.js 单线程推理，多路并发嵌入会互相争抢甚至卡死。
// 串行化 + 超时兜底，保证写/检索路径无论并发多少都稳定且有序。
// 模型未就绪（首次下载/加载可能耗时）时快速降级，不阻塞写/检索主流程。
let embedChain = Promise.resolve();
const EMBED_READY = { ok: false };
/**
 * 将文本编码为 512 维归一化向量（失败/超时/模型未就绪返回 null，调用方回退词法）。
 * 同一时刻只跑一次推理；排队任务按到达顺序执行。
 */
async function embedText(text) {
  const run = async () => {
    const input = String(text ?? "").replace(/\s+/g, " ").slice(0, 4000);
    if (!input) return null;
    const extractor = await getExtractor();
    const out = await Promise.race([
      extractor(input, { pooling: "mean", normalize: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("embed 超时")), EMBED_TIMEOUT_MS))
    ]);
    return Float32Array.from(out.data);
  };
  const p = embedChain.then(run, run);
  // 链上吞错：单个失败不影响后续排队任务
  embedChain = p.catch(() => null);
  try {
    return await p;
  } catch {
    return null;
  }
}

function vecToBuffer(vec) {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}
/** 余弦相似度（输入为归一化向量） */
function cosineSim(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}

// ---------------------------------------------------------------------------
// SQLite 存储（每作用域一个 .db；项目记忆绑定工作区文件夹）
// ---------------------------------------------------------------------------

function seedBranch(title, content, kind, tags, strength) {
  const ts = now();
  return {
    uid: newId(),
    title,
    content,
    kind: KINDS.includes(kind) ? kind : "other",
    tags: tags ?? [],
    strength: clamp(strength ?? 0.6, 0, 1),
    status: "active",
    source: "system",
    parentId: null,
    sessionId: null,
    createdAt: ts,
    updatedAt: ts,
    lastAccessAt: ts,
    history: []
  };
}

class HippocampusDb {
  constructor(scope, projectPath, anchorBank = null) {
    // v3.2：统一记忆库 —— 所有信息内容记忆在同一记录中，跨工作区目录打通
    this.scope = "unified";
    this.projectPath = projectPath ?? null;
    // v5.4：激活锚点（工作记忆延续）—— 由工厂注入，统一库单例共享
    this.anchors = anchorBank;
    fs.mkdirSync(storeDir(scope, projectPath), { recursive: true });
    this.db = new Database(dbFile(scope, projectPath));
    this.db.loadExtension(getLoadablePath());
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA busy_timeout=5000;");
    // v4 读取速率：降 fsync 压力、扩大页缓存、内存映射、临时表入内存
    this.db.exec("PRAGMA synchronous=NORMAL;");
    this.db.exec("PRAGMA cache_size=-20000;");
    this.db.exec("PRAGMA mmap_size=268435456;");
    this.db.exec("PRAGMA temp_store=MEMORY;");
    // v4：预编译语句 / 统计缓存 / 查询向量 LRU
    this.s = new Map();
    this.metaCache = null;
    this.qvecCache = new LruCache(QVEC_CACHE_MAX);
    // v5.2：活动分支快照缓存（检索热路径免重复全表扫描）+ 库大小缓存
    this.activeCache = null;
    this.sizeCache = { at: 0, bytes: 0 };
    this.initSchema();
    // v4：预编译语句预热需在 schema 就绪后进行，否则新库会报 no such table
    this.initStmts();
    this.migrateLegacy();
    // v3.2：一次性合并旧「按项目分库」的数据进统一库（跨目录打通，保留历史记忆）
    this.migrateProjectStores();
    this.checkIntegrity();
    this.applyDecay();
    this.enforceNodeCap();
  }

  /** v4：按 SQL 缓存编译语句（避免热路径重复编译） */
  stmt(sql) {
    let s = this.s.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.s.set(sql, s);
    }
    return s;
  }
  initStmts() {
    // 预热最热路径
    this.stmt("SELECT * FROM branches WHERE status='active'");
    this.stmt("SELECT * FROM branches WHERE uid=?");
    this.stmt("SELECT * FROM branches WHERE title=? AND status='active'");
    this.stmt("SELECT rowid, distance FROM memories WHERE embedding MATCH ? ORDER BY distance LIMIT ?");
    this.stmt("SELECT embedding FROM memories WHERE rowid=?");
    this.stmt("DELETE FROM memories WHERE rowid=?");
    this.stmt("INSERT INTO memories(rowid, embedding) VALUES (?,?)");
    this.stmt("SELECT a, b, weight FROM links WHERE a=? OR b=?");
  }

  /**
   * v4 启动完整性校验：quick_check 快速体检，损坏时记录到 meta（integrityOk=false）
   * 并清理孤儿向量（branches 已不存在的向量行），保证后续检索不因脏数据报错。
   */
  checkIntegrity() {
    try {
      const qc = this.db.pragma("quick_check", { simple: true });
      const ok = qc === "ok";
      if (!ok) this.setMeta("integrityOk", false);
      else this.setMeta("integrityOk", true);
      if (ok) {
        // 清理孤儿向量（幂等，代价低）
        const r = this.db.prepare(
          "DELETE FROM memories WHERE rowid NOT IN (SELECT id FROM branches)"
        ).run();
        if (r.changes > 0) this.setMeta("orphanVecsCleaned", Number(this.getMeta("orphanVecsCleaned", 0)) + r.changes);
      }
    } catch { /* 校验失败不阻断插件挂载 */ }
  }

  initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS branches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uid TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        kind TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        strength REAL NOT NULL DEFAULT 0.5,
        status TEXT NOT NULL DEFAULT 'active',
        source TEXT NOT NULL DEFAULT 'agent',
        parent_id TEXT,
        session_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_access_at INTEGER NOT NULL,
        history TEXT NOT NULL DEFAULT '[]'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memories USING vec0(embedding float[${EMBED_DIM}]);
      -- v3：持久化突触连接（a<b 字典序，无向；节点可为记忆 uid 或工作区目录 wd:path）
      CREATE TABLE IF NOT EXISTS links (
        a TEXT NOT NULL,
        b TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 0.1,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (a, b)
      );
      -- v3.3：工作区目录节点（记忆所属项目目录；球形网络的第一环）
      CREATE TABLE IF NOT EXISTS workdirs (
        path TEXT PRIMARY KEY,
        name TEXT,
        created_at INTEGER NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      -- v4：演化日志（自循环进化演练的历史留痕，用于趋势分析）
      CREATE TABLE IF NOT EXISTS evolog (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        epoch INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        merged INTEGER NOT NULL DEFAULT 0,
        pruned_links INTEGER NOT NULL DEFAULT 0,
        fitness_before REAL NOT NULL DEFAULT 0,
        fitness_after REAL NOT NULL DEFAULT 0,
        lr REAL NOT NULL DEFAULT 0.01,
        added_since INTEGER NOT NULL DEFAULT 0,
        nodes INTEGER NOT NULL DEFAULT 0,
        drift INTEGER NOT NULL DEFAULT 0
      );
      -- v5：注入留痕（对话前自动 / 工具调取 / 界面刷新，供「注入日志」面板）
      CREATE TABLE IF NOT EXISTS inject_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        mode TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        workstate INTEGER NOT NULL DEFAULT 0,
        chars INTEGER NOT NULL DEFAULT 0,
        title TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_inject_ts ON inject_log(ts);
      -- v4：查询索引（读取速率）
      CREATE INDEX IF NOT EXISTS idx_branches_status ON branches(status);
      CREATE INDEX IF NOT EXISTS idx_branches_kind ON branches(kind);
      CREATE INDEX IF NOT EXISTS idx_branches_updated ON branches(updated_at);
      CREATE INDEX IF NOT EXISTS idx_branches_created ON branches(created_at);
      CREATE INDEX IF NOT EXISTS idx_branches_access ON branches(last_access_at);
      CREATE INDEX IF NOT EXISTS idx_links_a ON links(a);
      CREATE INDEX IF NOT EXISTS idx_links_b ON links(b);
    `);
    // v3.3：branches 增加所属工作区目录列（旧库幂等迁移）
    try {
      this.db.exec("ALTER TABLE branches ADD COLUMN scope_path TEXT");
    } catch { /* 已存在则忽略 */ }
  }

  /** 旧版 memory.json 迁移到 SQLite（仅当 DB 为空时） */
  migrateLegacy() {
    const cnt = this.db.prepare("SELECT COUNT(*) AS c FROM branches").get().c;
    if (cnt > 0) return;
    let raw = null;
    try {
      raw = fs.readFileSync(legacyJsonFile(this.scope, this.projectPath), "utf8");
    } catch { return; }
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { return; }
    if (!parsed || !Array.isArray(parsed.branches)) return;
    const insert = this.db.prepare(
      "INSERT INTO branches (uid,title,content,kind,tags,strength,status,source,parent_id,session_id,created_at,updated_at,last_access_at,history) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    );
    const insVec = this.db.prepare("INSERT INTO memories(rowid, embedding) VALUES (?,?)");
    const tx = this.db.transaction((branches) => {
      for (const b of branches) {
        try {
          const r = insert.run(
            b.uid ?? newId(), b.title ?? "未命名", b.content ?? "", b.kind ?? "other",
            JSON.stringify(b.tags ?? []), clamp(Number(b.strength) || 0.5, 0, 1),
            b.status === "archived" ? "archived" : "active", b.source ?? "system",
            b.parentId ?? null, b.sessionId ?? null, b.createdAt ?? now(), b.updatedAt ?? now(),
            b.lastAccessAt ?? now(), JSON.stringify(b.history ?? [])
          );
          try { insVec.run(BigInt(r.lastInsertRowid), new Uint8Array(EMBED_DIM * 4)); } catch {}
        } catch { /* 单条迁移失败不影响其余 */ }
      }
    });
    tx(parsed.branches);
    this.embedAll().catch(() => {});
  }

  /**
   * v3.2：一次性合并旧版「按项目分库」数据（storages/hippocampus/projects/<md5>/memory.db）
   * 进统一记忆库 —— 各工作区目录的历史记忆因此全部打通。uid 冲突忽略（保留主库），
   * 合并后后台补嵌入向量。仅执行一次（meta 标记）。
   */
  migrateProjectStores() {
    const projectsRoot = path.join(dshHome(), "storages", "hippocampus", "projects");
    if (!fs.existsSync(projectsRoot) || this.getMeta("projectStoresMerged", 0)) {
      return { merged: 0 };
    }
    let mergedBranches = 0;
    let mergedLinks = 0;
    for (const dir of fs.readdirSync(projectsRoot)) {
      const f = path.join(projectsRoot, dir, "memory.db");
      if (!fs.existsSync(f)) continue;
      let sub = null;
      try {
        sub = new Database(f, { readonly: true });
        const rows = sub.prepare("SELECT * FROM branches").all();
        const insert = this.db.prepare(
          "INSERT OR IGNORE INTO branches (uid,title,content,kind,tags,strength,status,source,parent_id,session_id,scope_path,created_at,updated_at,last_access_at,history) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
        );
        const tx = this.db.transaction((items) => {
          for (const r of items) {
            try {
              insert.run(
                r.uid, r.title ?? "未命名", r.content ?? "", r.kind ?? "other",
                r.tags ?? "[]", Number(r.strength) || 0.5, r.status ?? "active", r.source ?? "system",
                r.parent_id ?? null, r.session_id ?? null, null,
                r.created_at ?? now(), r.updated_at ?? now(),
                r.last_access_at ?? now(), r.history ?? "[]"
              );
              mergedBranches++;
            } catch { /* uid 冲突（已存在）忽略 */ }
          }
        });
        tx(rows);
        const links = sub.prepare("SELECT a, b, weight FROM links").all();
        for (const l of links) {
          try { this.setLink(l.a, l.b, Number(l.weight) || 0.1); mergedLinks++; } catch { /* 忽略坏连接 */ }
        }
        sub.close();
        sub = null;
      } catch { /* 单个旧库损坏不影响整体 */ }
      if (sub) { try { sub.close(); } catch {} }
    }
    this.setMeta("projectStoresMerged", 1);
    if (mergedBranches > 0) {
      // 合并进来的分支需要向量：后台补嵌入
      this.embedAll().catch(() => {});
    }
    return { mergedBranches, mergedLinks };
  }

  /**
   * v3.2 节点上限：活跃分支超过 MAX_NODES（默认 1000）时，按
   * 「非豁免（workstate/会话精华优先保留）→ 强度升序 → 最近更新升序」淘汰最弱节点，
   * 归档（保留历史与向量记录，不再出现在活跃网络/可视化中）。
   */
  enforceNodeCap() {
    const cap = MAX_NODES;
    const activeCount = this.db.prepare("SELECT COUNT(*) c FROM branches WHERE status='active'").get().c;
    if (activeCount <= cap) return { removed: 0, cap };
    const rows = this.db.prepare(`
      SELECT * FROM branches WHERE status='active'
      ORDER BY
        CASE WHEN kind='workstate' OR title LIKE '会话精华%' OR title LIKE '历史记忆精华%' THEN 1 ELSE 0 END,
        strength ASC, updated_at ASC
    `).all();
    let removed = 0;
    for (const r of rows) {
      if (activeCount - removed <= cap) break;
      try {
        this.removeBranch(r.uid, false);
        removed++;
      } catch { /* 竞态忽略 */ }
    }
    if (removed > 0) {
      this.setMeta("cappedRemoved", Number(this.getMeta("cappedRemoved", 0)) + removed);
    }
    return { removed, cap };
  }

  getMeta(key, def = null) {
    const row = this.stmt("SELECT value FROM meta WHERE key = ?").get(key);
    if (!row) return def;
    try { return JSON.parse(row.value); } catch { return row.value; }
  }
  setMeta(key, value) {
    this.stmt(
      "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    ).run(key, JSON.stringify(value));
    // v4：写入 meta 使统计缓存失效（保持新鲜度）
    this.metaCache = null;
  }

  rowToBranch(row) {
    if (!row) return null;
    return {
      id: row.uid,
      // 内部数字主键（memories vec0 表 MATCH 返回 rowid=该值，用于映射命中）
      rowId: row.id,
      title: row.title,
      content: row.content,
      kind: row.kind,
      tags: safeJsonArray(row.tags, "[]"),
      strength: Number(row.strength) || 0,
      status: row.status,
      source: row.source,
      parentId: row.parent_id,
      sessionId: row.session_id,
      scopePath: row.scope_path ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastAccessAt: row.last_access_at,
      history: safeJsonArray(row.history, "[]")
    };
  }

  /**
   * 遗忘曲线（v4 间隔重复）：按距上次访问天数批量衰减，单条 SQL 完成（替代逐行循环）。
   * 指数 k = clamp(1/(0.4+strength), MIN, MAX)：强度越高衰减越慢（艾宾浩斯间隔重复）。
   * v3.3：偏好/交流核心永不自动降强。
   */
  applyDecay() {
    const ts = now();
    try {
      const info = this.db.prepare(
        `UPDATE branches SET strength = MAX(?, strength * POWER(?, (((? - last_access_at) * 1.0) / ?) * clamp((1.0 / (0.4 + strength)), ?, ?)))
         WHERE status='active' AND kind NOT IN ('preference','communication') AND (? - last_access_at) >= ?`
      ).run(STRENGTH_FLOOR, DECAY_PER_DAY, ts, DAY_MS, SPACE_DECAY_MIN, SPACE_DECAY_MAX, ts, DAY_MS);
      return { updated: info.changes };
    } catch {
      // 极端旧 SQLite 缺 POWER/clamp：回退逐行计算（行为一致）
      const rows = this.db.prepare(
        "SELECT id, strength, last_access_at, updated_at FROM branches WHERE status='active' AND kind NOT IN ('preference','communication')"
      ).all();
      const upd = this.db.prepare("UPDATE branches SET strength=? WHERE id=?");
      const tx = this.db.transaction((items) => {
        for (const r of items) {
          const base = r.last_access_at || r.updated_at || ts;
          const days = Math.max(0, (ts - base) / DAY_MS);
          if (days >= 1) {
            const k = clamp(1 / (0.4 + r.strength), SPACE_DECAY_MIN, SPACE_DECAY_MAX);
            upd.run(Math.max(STRENGTH_FLOOR, r.strength * Math.pow(DECAY_PER_DAY, days * k)), r.id);
          }
        }
      });
      tx(rows);
      return { updated: 0 };
    }
  }

  /** v4 自适应学习率：随 fitness 趋势在 evolve 中涨跌，参与巩固/合并增量缩放 */
  learningRate() {
    return clamp(Number(this.getMeta("learningRate", LR_DEFAULT)), LR_MIN, LR_MAX);
  }

  /**
   * v4 查询向量 LRU：重复检索同一查询免重编码（读取速率）。
   * 返回归一化 Float32Array；内部缓存 Buffer 以便直接喂 MATCH。
   */
  async getQvec(q) {
    const key = "q:" + String(q ?? "").trim();
    const hit = this.qvecCache.get(key);
    if (hit) return { vec: hit.vec, buf: hit.buf };
    const vec = await embedText(String(q ?? ""));
    if (!vec) return null;
    const buf = vecToBuffer(vec);
    this.qvecCache.set(key, { vec, buf });
    return { vec, buf };
  }

  /**
   * 为全部活跃分支补充/刷新向量（写入时调用，幂等）。
   * v5.2：只补缺失/全零向量的分支（embedFor 判定），已有有效向量的跳过；
   * 每批之间让出事件循环（yield），避免长时间独占主线程拖慢对话/检索。
   */
  async embedAll() {
    const rows = this.db.prepare(
      "SELECT b.id, b.title, b.content, b.tags FROM branches b WHERE b.status='active'"
    ).all();
    let done = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (this.embedFor(r.id)) continue; // 已有有效向量（非全零）跳过
      try {
        const text = [r.title, safeJsonArray(r.tags, "[]").join(" "), r.content].filter(Boolean).join("。");
        const vec = await embedText(text);
        if (vec) { this.storeEmbedding(r.id, vec); done++; }
      } catch { /* 单条补嵌入失败不中断 */ }
      // 每 4 条让出一次事件循环（模型推理本身异步，但解析/写库需要让位）
      if ((i & 3) === 3) await new Promise((res) => setTimeout(res, 0));
    }
    return { done, total: rows.length };
  }

  /** 写入/替换某分支的向量（delete + insert 幂等；v4 事务包裹防半写） */
  storeEmbedding(branchId, vec) {
    const tx = this.db.transaction((id, buf) => {
      this.stmt("DELETE FROM memories WHERE rowid=?").run(BigInt(id));
      this.stmt("INSERT INTO memories(rowid, embedding) VALUES (?,?)").run(BigInt(id), buf);
    });
    tx(branchId, vecToBuffer(vec));
  }

  embedFor(branchId) {
    const row = this.stmt("SELECT embedding FROM memories WHERE rowid=?").get(BigInt(branchId));
    if (!row || !row.embedding) return null;
    const buf = row.embedding;
    if (buf.length !== EMBED_DIM * 4) return null;
    let zero = true;
    for (let i = 0; i < buf.length; i += 64) {
      if (buf[i] !== 0) { zero = false; break; }
    }
    return zero ? null : buf;
  }

  // -------------------------------------------------------------------------
  // v5.2：活动分支快照缓存 —— 检索/联想/去重/图 热路径共享一次全表扫描
  // -------------------------------------------------------------------------

  /** 活动分支快照（1s TTL；写操作经 invalidateActiveCache 失效） */
  activeBranches() {
    const nowMs = now();
    if (this.activeCache && nowMs - this.activeCache.at < 1000) return this.activeCache.rows;
    const rows = this.db.prepare("SELECT * FROM branches WHERE status='active'").all().map((r) => this.rowToBranch(r));
    this.activeCache = { rows, at: nowMs };
    return rows;
  }

  /** 写操作后调用：活动快照与图缓存一并失效 */
  invalidateActiveCache() {
    this.activeCache = null;
    this.invalidateGraphCache();
  }

  // -------------------------------------------------------------------------
  // v3：突触连接（links 表）
  // -------------------------------------------------------------------------

  /** 无向键规范化 */
  linkKey(a, b) {
    return a < b ? [a, b] : [b, a];
  }

  /** 设置连接（取更大权重） */
  setLink(a, b, weight) {
    if (!a || !b || a === b) return;
    const [x, y] = this.linkKey(a, b);
    const row = this.db.prepare("SELECT weight FROM links WHERE a=? AND b=?").get(x, y);
    const w = clamp(Math.max(weight, row ? row.weight : 0), 0, 1);
    this.db.prepare(
      "INSERT INTO links(a,b,weight,updated_at) VALUES(?,?,?,?) ON CONFLICT(a,b) DO UPDATE SET weight=excluded.weight, updated_at=excluded.updated_at"
    ).run(x, y, w, now());
  }

  /** Hebbian 强化：共激活的连接增加权重 */
  strengthenLink(a, b, delta) {
    if (!a || !b || a === b) return;
    const [x, y] = this.linkKey(a, b);
    const row = this.db.prepare("SELECT weight FROM links WHERE a=? AND b=?").get(x, y);
    const w = clamp((row ? row.weight : 0) + delta, 0, 1);
    this.db.prepare(
      "INSERT INTO links(a,b,weight,updated_at) VALUES(?,?,?,?) ON CONFLICT(a,b) DO UPDATE SET weight=excluded.weight, updated_at=excluded.updated_at"
    ).run(x, y, w, now());
  }

  /** 某节点的全部连接 */
  linksOf(uid) {
    return this.db.prepare("SELECT a, b, weight FROM links WHERE a=? OR b=?").all(uid, uid)
      .map((r) => ({ other: r.a === uid ? r.b : r.a, weight: r.weight }));
  }

  /** 删除某节点的全部连接 */
  unlinkAll(uid) {
    this.db.prepare("DELETE FROM links WHERE a=? OR b=?").run(uid, uid);
  }

  // -------------------------------------------------------------------------
  // v3.3：工作区目录节点（球形神经网络第一环）
  // -------------------------------------------------------------------------

  /** 工作区目录节点的统一 id */
  workdirId(workdirPath) {
    return WORKDIR_PREFIX + workdirPath;
  }

  /** 分支是否为核心节点（偏好/交流 —— 永久保留、永不自动降强） */
  isCoreBranch(branch) {
    return !!branch && (branch.kind === "preference" || branch.kind === "communication");
  }

  /** 目录归属归一化（统一分隔符 + 去尾部斜杠），用于项目归属比较 */
  normProj(p) {
    if (!p) return "";
    return String(p).replace(/[/\\]+/g, "/").replace(/\/+$/, "");
  }

  /** 两项目路径是否属同一项目（精确匹配或互为父目录前缀，兼容 DSH 多窗口衍生于同一工作区） */
  sameProject(a, b) {
    const A = this.normProj(a), B = this.normProj(b);
    if (!A || !B) return false;
    if (A === B) return true;
    return A.startsWith(B + "/") || B.startsWith(A + "/");
  }

  /**
   * v4.1 项目相关性权重：根据记忆所属项目与「项目上下文」的关系打分，参与检索融合。
   *  - 无项目上下文，或记忆为偏好/交流/无项目的全局记忆 → 1（不降权，本就全局适用）
   *  - 命中项目上下文的记忆 → 加分（PROJECT_HIT_W）；其他项目记忆 → 降权（PROJECT_MISS_W）
   *  注意：项目路径通过参数显式传入（而非 this 状态），避免统一库单例在多会话间并发互相覆盖。
   */
  projectWeight(branch, projectPath) {
    const ctx = projectPath || this.projectPath || null;
    if (!ctx || !branch) return 1;
    if (this.isCoreBranch(branch)) return 1;
    if (!branch.scopePath) return 1;
    return this.sameProject(branch.scopePath, ctx) ? PROJECT_HIT_W : PROJECT_MISS_W;
  }

  /** 节点 id 是否为核心分支（偏好/交流） */
  isCoreId(id) {
    if (typeof id !== "string" || !id.startsWith("mem_")) return false;
    const b = this.getByUid(id);
    return this.isCoreBranch(b);
  }

  /** 节点 id 是否为工作区目录 */
  isWorkdirId(id) {
    return typeof id === "string" && id.startsWith(WORKDIR_PREFIX);
  }

  /** 永久连接：偏好/交流 与 工作区目录 之间的连接（永不 TTL 断开、永不降权） */
  isPermanentLink(a, b) {
    return (this.isCoreId(a) && this.isWorkdirId(b)) || (this.isWorkdirId(a) && this.isCoreId(b));
  }

  /** 登记工作区目录（写入记忆时自动调用），并建立与所有偏好/交流核心的永久连接 */
  upsertWorkdir(workdirPath) {
    if (typeof workdirPath !== "string" || !workdirPath) return null;
    const name = workdirPath.split(/[/\\]+/).filter(Boolean).pop() ?? workdirPath;
    this.db.prepare(
      "INSERT INTO workdirs(path,name,created_at,archived) VALUES(?,?,?,0) ON CONFLICT(path) DO UPDATE SET name=excluded.name"
    ).run(workdirPath, name, now());
    const id = this.workdirId(workdirPath);
    // 与所有偏好/交流核心建立永久连接
    const cores = this.db.prepare(
      "SELECT uid FROM branches WHERE status='active' AND kind IN ('preference','communication')"
    ).all();
    for (const c of cores) {
      this.setLink(id, c.uid, PERM_LINK_WEIGHT);
    }
    this.invalidateActiveCache();
    return { id, name, path: workdirPath };
  }

  /** 活跃工作区目录列表 */
  activeWorkdirs() {
    return this.db.prepare("SELECT path, name, created_at FROM workdirs WHERE archived=0 ORDER BY created_at").all();
  }

  /** 用户主动归档工作区：断开其全部连接（偏好/交流的永久连接随之断开） */
  archiveWorkdir(workdirPath) {
    if (typeof workdirPath !== "string" || !workdirPath) {
      throw new Error("hippocampus.archiveWorkdir: 缺少工作区路径");
    }
    const row = this.db.prepare("SELECT * FROM workdirs WHERE path=?").get(workdirPath);
    if (!row) throw new Error("hippocampus.archiveWorkdir: 工作区不存在: " + workdirPath);
    this.db.prepare("UPDATE workdirs SET archived=1 WHERE path=?").run(workdirPath);
    this.unlinkAll(this.workdirId(workdirPath));
    this.setMeta("archivedWorkdirs", Number(this.getMeta("archivedWorkdirs", 0)) + 1);
    this.invalidateActiveCache();
    return { archived: true, path: workdirPath };
  }

  // -------------------------------------------------------------------------
  // 写入 / 更新 / 遗忘
  // -------------------------------------------------------------------------

  async writeBranch(input) {
    const ts = now();
    const branch = {
      uid: input.uid ?? newId(),
      title: typeof input.title === "string" ? input.title.trim() : "",
      content: typeof input.content === "string" ? input.content : "",
      kind: KINDS.includes(input.kind) ? input.kind : "other",
      tags: Array.isArray(input.tags) ? input.tags.map(String).slice(0, 12) : autoTags(input.title, input.content, input.kind),
      strength: clamp(typeof input.strength === "number" ? input.strength : 0.6, 0, 1),
      status: input.status === "archived" ? "archived" : "active",
      source: input.source === "user" || input.source === "agent" ? input.source : "system",
      parentId: typeof input.parentId === "string" ? input.parentId : null,
      sessionId: typeof input.sessionId === "string" ? input.sessionId : null,
      scopePath: typeof input.scopePath === "string" && input.scopePath ? input.scopePath : null,
      createdAt: ts,
      updatedAt: ts,
      lastAccessAt: ts,
      history: []
    };
    // v3.3：登记记忆所属工作区目录（球形网络第一环），建立与偏好/交流的永久连接
    if (branch.scopePath) this.upsertWorkdir(branch.scopePath);
    // v3 去重：先编码，与已有同种类记忆比较；≥0.9 则合并强化原记忆
    // v4.1 项目精准度：对「项目归属明确」的记忆（insight/workstate/other），只允许与【同一项目】的记忆去重合并，
    // 避免两个不同项目里语义相似但内容独立的记忆被错误合并、导致各项目细节互相污染/丢失。
    const text = [branch.title, branch.tags.join(" "), branch.content].filter(Boolean).join("。");
    const vec = await embedText(text);
    let relatedList = [];
    if (vec) {
      const sim = await this.findSimilar(vec, { limit: 5 });
      // v5.4 相关记忆提示：0.5~0.9 相似（未达合并阈值）的记忆标记为「相关」，
      // 随写入结果返回 —— Agent 可感知「新记忆与哪些旧记忆存在关联」
      for (const s of sim) {
        if (s.s >= 0.5 && s.s < DEDUP_THRESHOLD) {
          relatedList.push({ id: s.b.id, title: s.b.title, score: Number(s.s.toFixed(2)) });
        }
      }
      const top = sim.find((s) =>
        s.s >= DEDUP_THRESHOLD && s.b.kind === branch.kind && s.b.status === "active"
        && (this.isCoreBranch(branch) || this.isCoreBranch(s.b) || !branch.scopePath || !s.b.scopePath
          || this.sameProject(branch.scopePath, s.b.scopePath))
      );
      if (top) {
        const existing = this.getByUid(top.b.id);
        const history = safeJsonArray(
          this.db.prepare("SELECT history FROM branches WHERE uid=?").get(existing.id)?.history, "[]"
        );
        history.push({ at: ts, by: "agent", summary: "检测到相似记忆（相似度 " + top.s.toFixed(2) + "），自动合并强化" });
        // v5.2 合并质量：新内容明显更详细（且不是原有内容的子串）时，把差异部分并入原记忆
        // （限制总长，避免内容无限膨胀）—— 让去重合并不丢信息
        const oldC = String(existing.content ?? "");
        const newC = String(branch.content ?? "");
        let mergedContent = oldC;
        if (newC && newC.length > 40 && newC.length - oldC.length > 20 && oldC.length + newC.length <= 4000) {
          if (!oldC.includes(newC.slice(0, 60))) {
            const tail = newC.slice(oldC.includes(newC) ? newC.length : 0, newC.length);
            const add = tail.trim();
            if (add) mergedContent = oldC ? oldC + "\n" + add : add;
          }
        }
        this.db.prepare(
          "UPDATE branches SET strength=?, content=?, last_access_at=?, updated_at=?, history=? WHERE uid=?"
        ).run(
          clamp(existing.strength + 0.06, 0, 1), mergedContent, ts, ts,
          JSON.stringify(history.slice(-HISTORY_LIMIT)), existing.id
        );
        // 内容变了 → 重嵌入向量（保持语义检索命中最新内容）
        if (mergedContent !== oldC) {
          const nv = await embedText([existing.title, (existing.tags ?? []).join(" "), mergedContent].filter(Boolean).join("。"));
          if (nv) this.storeEmbedding(existing.rowId, nv);
        }
        this.invalidateActiveCache();
        return { branch: this.getByUid(existing.id), dedup: true, mergedInto: existing.id, related: relatedList.slice(0, 3) };
      }
      // 建立突触：与新记忆最相似的 top3 连接（权重=相似度）
      for (const s of sim) {
        if (s.s >= 0.5) this.setLink(branch.uid, s.b.id, s.s);
      }
    }
    const r = this.db.prepare(
      "INSERT INTO branches (uid,title,content,kind,tags,strength,status,source,parent_id,session_id,scope_path,created_at,updated_at,last_access_at,history) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).run(
      branch.uid, branch.title, branch.content, branch.kind, JSON.stringify(branch.tags),
      branch.strength, branch.status, branch.source, branch.parentId, branch.sessionId, branch.scopePath,
      branch.createdAt, branch.updatedAt, branch.lastAccessAt, JSON.stringify(branch.history)
    );
    if (vec) this.storeEmbedding(r.lastInsertRowid, vec);
    // v5.4 归纳连线：像人脑一样把「同时出现 / 同主题 / 同项目」的记忆关联起来 ——
    // ① 同会话近 24h 记忆（时序经历）② 同项目近 24h 记忆 ③ 同项目同种类 ④ 共享 ≥2 标签
    try {
      const tsCut = now() - 24 * 3600000;
      const recent = this.db.prepare(
        "SELECT uid, session_id, scope_path, tags, kind FROM branches WHERE status='active' AND created_at > ? AND uid != ? LIMIT 40"
      ).all(tsCut, branch.uid);
      for (const rw of recent) {
        let w = 0;
        if (branch.sessionId && rw.session_id && rw.session_id === branch.sessionId) w = Math.max(w, 0.5);
        if (branch.scopePath && rw.scope_path && this.sameProject(branch.scopePath, rw.scope_path)) {
          w = Math.max(w, rw.kind === branch.kind ? 0.4 : 0.3);
        }
        if (w === 0 && branch.tags.length) {
          const shared = safeJsonArray(rw.tags, "[]").filter((t) => branch.tags.includes(t)).length;
          if (shared >= 2) w = 0.3;
        }
        if (w > 0) this.setLink(branch.uid, rw.uid, w);
      }
    } catch { /* 归纳连线失败不影响写入 */ }
    this.invalidateActiveCache();
    // v3.2：节点上限检查（超过 1000 自动淘汰最弱）
    try { this.enforceNodeCap(); } catch { /* 淘汰失败不影响写入 */ }
    return { branch: this.getByUid(branch.uid), dedup: false, mergedInto: null, related: relatedList.slice(0, 3) };
  }

  async updateBranch(uid, patch, by) {
    const row = this.db.prepare("SELECT * FROM branches WHERE uid=?").get(uid);
    if (!row) throw new Error("hippocampus.update: 记忆不存在: " + uid);
    const before = { title: row.title, content: row.content, kind: row.kind, tags: safeJsonArray(row.tags, "[]"), strength: row.strength, status: row.status };
    const fields = {};
    if (typeof patch.title === "string" && patch.title.trim()) fields.title = patch.title.trim();
    if (typeof patch.content === "string") fields.content = patch.content;
    if (KINDS.includes(patch.kind)) fields.kind = patch.kind;
    if (Array.isArray(patch.tags)) fields.tags = JSON.stringify(patch.tags.map(String).slice(0, 12));
    if (typeof patch.strength === "number") fields.strength = clamp(patch.strength, 0, 1);
    if (patch.status === "active" || patch.status === "archived") fields.status = patch.status;
    if (patch.source === "user" || patch.source === "agent") fields.source = patch.source;
    // v5.2 稳定性：patch 全部无效时直接返回原分支（此前会生成空 SET 导致 SQL 崩溃）
    if (Object.keys(fields).length === 0) return this.getByUid(uid);
    let history = safeJsonArray(row.history, "[]");
    history = [...history, { at: now(), by: by === "agent" ? "agent" : "user", summary: "修正: " + JSON.stringify(before) }].slice(-HISTORY_LIMIT);
    fields.updated_at = now();
    fields.last_access_at = now();
    fields.history = JSON.stringify(history);
    const sets = Object.keys(fields).map((k) => `${k}=?`).join(",");
    this.db.prepare(`UPDATE branches SET ${sets} WHERE uid=?`).run(...Object.values(fields), uid);
    if (patch.title !== void 0 || patch.content !== void 0 || patch.tags !== void 0) {
      const upd = this.db.prepare("SELECT * FROM branches WHERE uid=?").get(uid);
      const vec = await embedText([upd.title, safeJsonArray(upd.tags, "[]").join(" "), upd.content].filter(Boolean).join("。"));
      if (vec) this.storeEmbedding(upd.id, vec);
    }
    this.invalidateActiveCache();
    return this.getByUid(uid);
  }

  /** 遗忘：归档（默认）或彻底删除；v5.2：归档同样移除向量行（防孤儿向量堆积/检索索引膨胀） */
  removeBranch(uid, hard) {
    const row = this.db.prepare("SELECT * FROM branches WHERE uid=?").get(uid);
    if (!row) throw new Error("hippocampus.forget: 记忆不存在: " + uid);
    if (hard === true) {
      this.db.prepare("DELETE FROM memories WHERE rowid=?").run(BigInt(row.id));
      this.db.prepare("DELETE FROM branches WHERE id=?").run(row.id);
      this.unlinkAll(uid);
      this.invalidateActiveCache();
      return { removed: true, hard: true };
    }
    this.db.prepare("UPDATE branches SET status='archived', updated_at=? WHERE uid=?").run(now(), uid);
    // 归档分支不再参与检索：删除其向量，避免 vec0 MATCH 索引携带不可命中数据
    this.db.prepare("DELETE FROM memories WHERE rowid=?").run(BigInt(row.id));
    this.unlinkAll(uid);
    this.invalidateActiveCache();
    return { removed: true, hard: false };
  }

  getByUid(uid) {
    return this.rowToBranch(this.db.prepare("SELECT * FROM branches WHERE uid=?").get(uid));
  }

  /** 按标题精确查找（自动喂养 upsert 用） */
  findByTitle(title) {
    return this.rowToBranch(this.db.prepare("SELECT * FROM branches WHERE title=? AND status='active'").get(title));
  }

  /** 记忆库文件总大小（db + wal + shm；v5.2：10s 缓存，避免高频 statSync 磁盘 IO） */
  dbSizeBytes() {
    const nowMs = now();
    if (this.sizeCache && nowMs - this.sizeCache.at < 10000 && this.sizeCache.bytes > 0) {
      return this.sizeCache.bytes;
    }
    let total = 0;
    for (const f of [dbFile(this.scope, this.projectPath), dbFile(this.scope, this.projectPath) + "-wal", dbFile(this.scope, this.projectPath) + "-shm"]) {
      try { total += fs.statSync(f).size; } catch { /* 文件可能不存在 */ }
    }
    this.sizeCache = { at: nowMs, bytes: total };
    return total;
  }

  /** 与某向量最相似的活跃分支（排除自身可选）；v5.2 复用活动快照缓存 */
  async findSimilar(vec, opts = {}) {
    if (!vec) return [];
    const { limit = 3, excludeUid = null, minScore = 0.4 } = opts;
    const active = this.activeBranches();
    const byId = new Map(active.map((b) => [b.rowId ?? b.id, b]));
    const hits = this.db.prepare(
      "SELECT rowid, distance FROM memories WHERE embedding MATCH ? ORDER BY distance LIMIT ?"
    ).all(vecToBuffer(vec), limit + 5);
    const out = [];
    for (const h of hits) {
      const b = byId.get(h.rowid);
      if (!b) continue;
      if (excludeUid && b.id === excludeUid) continue;
      const s = clamp(1 - (h.distance * h.distance) / 2, 0, 1);
      if (s < minScore) continue;
      out.push({ b, s });
      if (out.length >= limit) break;
    }
    return out;
  }

  listBranches({ kind, q, includeArchived }) {
    const qTokens = tokensOf(q ?? "");
    // v5.2：复用活动快照（含归档时仍需全量查询）
    let rows = includeArchived
      ? this.db.prepare("SELECT * FROM branches").all().map((r) => this.rowToBranch(r))
      : this.activeBranches();
    if (typeof kind === "string" && KINDS.includes(kind)) rows = rows.filter((b) => b.kind === kind);
    if (qTokens.length > 0) {
      rows = rows
        .map((b) => ({ b, s: scoreQuery(b, qTokens) }))
        .filter((x) => x.s > 0)
        .sort((x, y) => y.s - x.s)
        .map((x) => x.b);
    } else {
      rows.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    return {
      branches: rows.map((b) => this.sanitize(b)),
      meta: this.buildMeta()
    };
  }

  /** 读取单条（触发再巩固 + 激活锚点） */
  getBranch(uid) {
    const b = this.getByUid(uid);
    if (!b) throw new Error("hippocampus.get: 记忆不存在: " + uid);
    b.strength = clamp(b.strength + RECONSOLIDATE_BOOST, 0, 1);
    b.lastAccessAt = now();
    this.db.prepare("UPDATE branches SET strength=?, last_access_at=? WHERE uid=?").run(b.strength, b.lastAccessAt, uid);
    // v5.4：精确读取同样激活锚点（人脑「聚焦回忆」= 工作记忆置顶）
    if (this.anchors) this.anchors.activate([uid], 0.6);
    this.invalidateActiveCache();
    return { branch: this.sanitize(b), anchors: this.anchors ? this.anchors.list(16).map((a) => ({ id: a.id, weight: Number(a.weight.toFixed(3)) })) : [] };
  }

  /** 三阶段检索：词法 + 语义(向量) + 联想(图扩散)，共激活 Hebbian 强化；projectPath 为当前项目上下文 */
  async searchBranches(q, limit, projectPath) {
    if (typeof q !== "string" || !q.trim()) throw new Error("hippocampus.search: 缺少查询词 q");
    const n = typeof limit === "number" ? clamp(Math.floor(limit), 1, 50) : 8;
    const qTokens = tokensOf(q);
    // v5.2：一次全表扫描的活动快照，词法/语义映射/联想扩散共享
    const active = this.activeBranches();

    // 阶段 1：词法
    const lex = active
      .map((b) => ({ b, s: scoreQuery(b, qTokens) }))
      .filter((x) => x.s > 0)
      .sort((x, y) => y.s - x.s)
      .slice(0, LEX_TOP_K);

    // 阶段 2：语义向量（rowid ↔ 分支映射：vec0 MATCH 返回数字 rowid）
    // v4：查询向量 LRU —— 同一查询重复检索免重编码
    let sem = [];
    const qv = await this.getQvec(q);
    if (qv) {
      const hits = this.db.prepare(
        "SELECT rowid, distance FROM memories WHERE embedding MATCH ? ORDER BY distance LIMIT ?"
      ).all(qv.buf, VEC_TOP_K);
      const byId = new Map(active.map((b) => [b.rowId ?? b.id, b]));
      sem = hits
        .map((h) => {
          const b = byId.get(h.rowid);
          return b ? { b, s: clamp(1 - (h.distance * h.distance) / 2, 0, 1) } : null;
        })
        .filter(Boolean);
      const semIds = new Set(sem.map((x) => x.b.id));
      for (const x of lex) if (!semIds.has(x.b.id)) sem.push({ b: x.b, s: x.s * 0.5 });
    } else {
      sem = lex.map((x) => ({ ...x }));
    }

    // 融合排序
    const lexScore = new Map(lex.map((x) => [x.b.id, x.s]));
    const semScore = new Map(sem.map((x) => [x.b.id, x.s]));
    const union = new Map();
    for (const x of lex) union.set(x.b.id, x.b);
    for (const x of sem) union.set(x.b.id, x.b);
    let fused = [...union.values()].map((b) => {
      const s = (semScore.get(b.id) ?? 0) * W_SEM + (lexScore.get(b.id) ?? 0) * W_LEX;
      return { b, s };
    }).filter((x) => x.s > 0.01).sort((x, y) => y.s - x.s);

    // v3.1 过期降权：超过 STALE_DAYS 的记忆视为过期信息，检索分 ×0.55 ——
    // 让匹配更聚焦当前项目与进度状态；v3.3：偏好/交流核心永不降权
    const staleCut = now() - STALE_DAYS * DAY_MS;
    fused = fused.map((x) => {
      if (x.b.updatedAt < staleCut && !this.isCoreBranch(x.b)) return { b: x.b, s: x.s * 0.55 };
      return x;
    }).sort((x, y) => y.s - x.s);

    // v4.1 项目精准度：统一库内按「项目上下文」加权 —— 当前项目记忆优先召回，
    // 其他项目记忆降权但不隔离；偏好/交流/无项目的全局记忆不降权。
    fused = fused.map((x) => ({ b: x.b, s: x.s * this.projectWeight(x.b, projectPath) })).sort((x, y) => y.s - x.s);

    // v5.4 锚点加权：当前工作记忆中已激活的记忆优先召回（人脑 priming 效应 ——
    // 「接着上次想的继续想」）。锚点强度越高加成越大（最高 ×1.25）。
    if (this.anchors) {
      fused = fused.map((x) => {
        const aw = this.anchors.weight(x.b.id);
        return aw > 0 ? { b: x.b, s: x.s * (1 + aw * 0.25) } : x;
      }).sort((x, y) => y.s - x.s);
    }

    // 阶段 3：联想扩散 —— 从 top5 沿相似图（向量 + 突触连接）取邻居
    if (fused.length > 0) {
      const seeds = fused.slice(0, 5);
      const expanded = this.associateExpand(seeds, n, qv ? qv.vec : null, active);
      const seen = new Set(fused.map((x) => x.b.id));
      for (const e of expanded) {
        if (!seen.has(e.b.id)) {
          fused.push(e);
          seen.add(e.b.id);
        }
      }
    }
    fused = fused.slice(0, Math.max(n, 12)).sort((x, y) => y.s - x.s).slice(0, n);

    // 再巩固（v4 自适应）：命中前 3 条按相关度增量强化（命中越相关强化越多）
    // + Hebbian 共激活强化（top6 两两连接 +0.02·s·s）—— 这些「真实传输事件」
    // 通过 signals 返回前端，画布上的脉冲即本次检索真实共激活的边
    const topHits = fused.slice(0, 6);
    const signalEdges = [];
    for (let i = 0; i < topHits.length; i++) {
      for (let j = i + 1; j < topHits.length; j++) {
        const delta = 0.02 * topHits[i].s * topHits[j].s;
        if (delta > 0) {
          this.strengthenLink(topHits[i].b.id, topHits[j].b.id, delta);
          signalEdges.push({ a: topHits[i].b.id, b: topHits[j].b.id, delta, weight: Number(clamp(topHits[i].s * topHits[j].s, 0, 1).toFixed(3)) });
        }
      }
    }
    const lr = this.learningRate();
    for (const { b, s } of topHits.slice(0, 3)) {
      const boost = clamp(RECONSOLIDATE_BOOST * (0.5 + s), 0.025, 0.1) * (1 + lr);
      b.strength = clamp(b.strength + boost, 0, 1);
      b.lastAccessAt = now();
      this.db.prepare("UPDATE branches SET strength=?, last_access_at=? WHERE id=?").run(b.strength, b.lastAccessAt, b.id);
    }
    // v5.4 激活锚点：检索命中前 5 条成为工作记忆锚点（下次检索/注入优先，人脑延续性）
    if (this.anchors) {
      this.anchors.activate(fused.slice(0, 5).map((x) => x.b.id), 0.5);
      this.anchors.purge();
    }
    // v5.5 联想交汇：检索是「思维活动」，命中后检测连线交叉 → 真实生成微弱新想法分支
    // （fire-and-forget：不阻塞检索返回；内部有 5 分钟冷却与去重）
    if (process.env.DSH_HIPPOCAMPUS_CROSSLINK !== "0") {
      this.crossLink({ maxCreated: 1 }).catch(() => {});
    }
    return {
      results: fused.map(({ b, s }) => ({ branch: this.sanitize(b), score: Number(clamp(s, 0, 1).toFixed(3)) })),
      signals: {
        hits: fused.map(({ b, s }) => ({ id: b.id, score: Number(clamp(s, 0, 1).toFixed(3)) })),
        edges: signalEdges,
        transmitted: signalEdges.length
      },
      // v5.4：返回当前激活锚点（供前端金色锚环可视化 + Agent 感知工作记忆）
      anchors: this.anchors ? this.anchors.list(16).map((a) => ({ id: a.id, weight: Number(a.weight.toFixed(3)) })) : []
    };
  }

  /**
   * 联想扩散：沿相似图（向量邻居 + 突触连接）从种子 BFS，返回补充结果。
   * v5.2 修复：每个种子必须用【自身向量】找邻居（此前误用查询向量 qvec，
   * 导致所有种子都取到查询的同一批最近邻，联想退化为重复召回）；
   * active 快照由调用方传入（可选），避免同一检索多次全表扫描。
   */
  associateExpand(seeds, n, _qvec, activeRows) {
    const active = Array.isArray(activeRows) ? activeRows : this.activeBranches();
    if (active.length <= 1) return [];
    const seedIds = new Set(seeds.map((x) => x.b.id));
    const neighbors = new Map();
    const byId = new Map(active.map((b) => [b.rowId ?? b.id, b]));
    for (const s of seeds) {
      const row = this.db.prepare("SELECT * FROM branches WHERE uid=?").get(s.b.id);
      if (!row) continue;
      // ① 向量邻居（始终用种子自身向量；qvec 仅作为检索质量参考不再复用）
      const emb = this.embedFor(row.id);
      if (emb) {
        const hits = this.db.prepare(
          "SELECT rowid, distance FROM memories WHERE embedding MATCH ? ORDER BY distance LIMIT ?"
        ).all(vecToBuffer(emb), ASSOC_TOP_K + 2);
        for (const h of hits) {
          if (h.rowid === row.id) continue;
          const nb = byId.get(h.rowid);
          if (nb && !seedIds.has(nb.id)) {
            const sim = clamp(1 - (h.distance * h.distance) / 2, 0, 1);
            const cur = neighbors.get(nb.id);
            neighbors.set(nb.id, { b: nb, w: Math.max(cur?.w ?? 0, sim) });
          }
        }
      }
      // ② 突触连接（v3 持久化）
      for (const l of this.linksOf(s.b.id)) {
        const nb = byId.get(l.other);
        if (nb && !seedIds.has(nb.id)) {
          const cur = neighbors.get(nb.id);
          neighbors.set(nb.id, { b: nb, w: Math.max(cur?.w ?? 0, l.weight) });
        }
      }
    }
    // v5.4 第二轮联想扩散：从第一轮邻居再扩散一次（联想链，权重 ×0.6 衰减）——
    // 像人脑「想起 A → 想起 B → 顺带想起 C」的多跳联想，但随跳数衰减
    if (neighbors.size > 0) {
      const first = [...neighbors.values()].sort((a, b) => b.w - a.w).slice(0, 8);
      const depth2 = new Map();
      for (const nb of first) {
        const row = this.db.prepare("SELECT * FROM branches WHERE uid=?").get(nb.b.id);
        if (!row) continue;
        const emb2 = this.embedFor(row.id);
        if (emb2) {
          const hits2 = this.db.prepare(
            "SELECT rowid, distance FROM memories WHERE embedding MATCH ? ORDER BY distance LIMIT 6"
          ).all(vecToBuffer(emb2));
          for (const h of hits2) {
            if (h.rowid === row.id) continue;
            const b2 = byId.get(h.rowid);
            if (!b2 || seedIds.has(b2.id) || neighbors.has(b2.id)) continue;
            const sim2 = clamp(1 - (h.distance * h.distance) / 2, 0, 1);
            const w2 = sim2 * 0.6 * nb.w;
            const cur = depth2.get(b2.id);
            depth2.set(b2.id, { b: b2, w: Math.max(cur?.w ?? 0, w2) });
          }
        }
        for (const l of this.linksOf(nb.b.id)) {
          const b2 = byId.get(l.other);
          if (!b2 || seedIds.has(b2.id) || neighbors.has(b2.id)) continue;
          const w2 = l.weight * 0.6 * nb.w;
          const cur = depth2.get(b2.id);
          depth2.set(b2.id, { b: b2, w: Math.max(cur?.w ?? 0, w2) });
        }
      }
      for (const [id, v] of depth2) {
        const cur = neighbors.get(id);
        neighbors.set(id, cur ? { b: v.b, w: Math.max(cur.w, v.w) } : v);
      }
    }
    return [...neighbors.values()]
      .map(({ b, w }) => ({ b, s: w * 0.85 }))
      .filter((x) => x.s > 0.12)
      .sort((x, y) => y.s - x.s);
  }

  // -------------------------------------------------------------------------
  // v5.5：联想交汇 —— 连线交叉在记忆库中真正生成「微弱新想法」分支
  //   两条联想连线在 3D 空间交汇 = 两条思维路径的交叉点。
  //   交叉点并非装饰：在记忆库中创建一条真实的弱 insight 分支
  //   （记录 4 个交汇记忆的关联），与 4 个源节点建立弱突触连接。
  //   该分支可被检索、注入、演化、修剪 —— 真正进入记忆网络，成为「新想法」。
  //   去重：同一 4 节点组合只强化不重复建；限频：默认 5 分钟一次检测。
  // -------------------------------------------------------------------------

  /**
   * 检测联想连线交汇并生成/强化「联想交汇」分支。
   * 在检索命中后调用（思维活动的高潮期），fire-and-forget 不阻塞检索返回。
   * @returns {Promise<{created:number, skipped?:string}>}
   */
  async crossLink(opts = {}) {
    const nowMs = now();
    const cooldown = Number(opts.cooldownMs) || 5 * 60000;
    const lastCross = Number(this.getMeta("lastCrossAt", 0)) || 0;
    if (nowMs - lastCross < cooldown) return { created: 0, skipped: "cooldown" };
    const maxCreated = opts.maxCreated ?? 1;
    let created = 0;
    try {
      const g = this.graphData(); // 复用 20s 缓存布局（含 x0/y0/z0）
      const nodes = g.nodes.filter((n) => n.type === "leaf" || n.type === "core");
      if (nodes.length < 4) return { created: 0, skipped: "nodes<4" };
      const byId = new Map(nodes.map((n) => [n.id, n]));
      // 边（仅两端都在节点表内的有效边）
      const edges = [];
      for (const e of g.edges) {
        const a = byId.get(e.a), b = byId.get(e.b);
        if (a && b) edges.push({ a, b, weight: e.weight });
      }
      if (edges.length < 2) return { created: 0, skipped: "edges<2" };
      // 两两检测（限量，防大图 O(N²) 爆炸）
      // v5.7 修复：图节点坐标字段是 x0/y0/z0（布局理想坐标），必须显式提取——
      // 此前直接传节点对象，segSegDist3 读到 undefined → NaN → 交叉永远检测不到
      const CROSS_THRESHOLD = 0.13; // 球坐标单位：两条连线最近距离小于该值视为交汇
      const pt = (n) => ({ x: n.x0 ?? 0, y: n.y0 ?? 0, z: n.z0 ?? 0 });
      const maxPairs = 6000;
      let pairs = 0;
      for (let i = 0; i < edges.length && created < maxCreated; i++) {
        for (let j = i + 1; j < edges.length && created < maxCreated; j++) {
          if (++pairs > maxPairs) { pairs = maxPairs; break; }
          const e1 = edges[i], e2 = edges[j];
          // 共享端点不算交汇（那是同一个节点的分叉）
          const s = new Set([e1.a.id, e1.b.id, e2.a.id, e2.b.id]);
          if (s.size < 4) continue;
          const d = segSegDist3(pt(e1.a), pt(e1.b), pt(e2.a), pt(e2.b));
          if (isFinite(d) && d < CROSS_THRESHOLD) {
            const made = await this.upsertCrossBranch(e1.a, e1.b, e2.a, e2.b, d);
            created += made;
          }
        }
        if (pairs >= maxPairs) break;
      }
    } catch { /* 交汇检测失败不影响主流程 */ }
    if (created > 0) this.setMeta("lastCrossAt", nowMs);
    return { created };
  }

  /**
   * 创建/强化一条「联想交汇」分支（去重：同 4 节点组合只强化）。
   * 返回 1=新建，0=已存在强化。
   */
  async upsertCrossBranch(n1, n2, n3, n4, dist) {
    const key = [n1.id, n2.id, n3.id, n4.id].sort().join("|");
    const ts = now();
    // 去重：content 以 KEY: 开头的既有交汇分支中查找同组合
    try {
      const rows = this.db.prepare(
        "SELECT * FROM branches WHERE status='active' AND title LIKE '⟡%' ORDER BY updated_at DESC LIMIT 300"
      ).all().map((r) => this.rowToBranch(r));
      const existing = rows.find((b) => String(b.content ?? "").startsWith("KEY:" + key));
      if (existing) {
        this.db.prepare("UPDATE branches SET strength=?, last_access_at=?, updated_at=? WHERE uid=?")
          .run(clamp(existing.strength + 0.02, 0, 1), ts, ts, existing.id);
        this.invalidateActiveCache();
        return 0;
      }
    } catch { /* 查询失败则继续新建 */ }
    const short = (t) => String(t ?? "").slice(0, 14);
    const title = ("⟡ 联想交汇 · " + [n1.title, n2.title, n3.title, n4.title].map(short).join(" · ")).slice(0, 70);
    const content = [
      "KEY:" + key,
      "两条思维路径在概念空间交汇（距离 " + Number(dist || 0).toFixed(2) + "），产生微弱新想法：",
      "· " + short(n1.title) + " ↔ " + short(n2.title) + "（" + (KIND_LABELS[n1.kind] ?? "") + " / " + (KIND_LABELS[n2.kind] ?? "") + "）",
      "· " + short(n3.title) + " ↔ " + short(n4.title) + "（" + (KIND_LABELS[n3.kind] ?? "") + " / " + (KIND_LABELS[n4.kind] ?? "") + "）",
      "这两个关联可能在某个未被注意的维度上指向同一件事。"
    ].join("\n");
    try {
      const out = await this.writeBranch({
        title,
        content,
        kind: "insight",
        tags: ["联想", "交汇", "自动"],
        source: "system",
        strength: 0.28,
        sessionId: null
      });
      if (!out.dedup) {
        // 与 4 个源节点建立弱突触连接（弱权重：仅作为潜在联想路径）
        const branchId = out.branch.id;
        for (const n of [n1, n2, n3, n4]) {
          if (n.id !== branchId) this.setLink(branchId, n.id, 0.16);
        }
        this.setMeta("crossCreated", Number(this.getMeta("crossCreated", 0)) + 1);
        this.invalidateActiveCache();
        return 1;
      }
    } catch { /* 写入失败忽略 */ }
    return 0;
  }

  // -------------------------------------------------------------------------
  // v3：演化 / 修剪（真实合并与清理，防止记忆库污染）
  // -------------------------------------------------------------------------

  /** 演化：epoch+1、合并近重复记忆（≥0.9）、修剪弱连接、计算适应度 */
  async evolve() {
    this.setMeta("epoch", Number(this.getMeta("epoch", 1)) + 1);
    this.setMeta("generation", Number(this.getMeta("generation", 0)) + 1);
    this.setMeta("iteration", Number(this.getMeta("iteration", 0)) + 1);
    this.setMeta("lastActivityAt", now());

    // v4 漂移统计：距上次演化的新增/修改分支数（自动演化门控依据）
    const lastEvolveAt = Number(this.getMeta("lastEvolveAt", 0)) || 0;
    const drift = this.db.prepare(
      "SELECT COUNT(*) c FROM branches WHERE created_at > ? OR updated_at > ?"
    ).get(lastEvolveAt, lastEvolveAt).c;
    const fitnessBefore = Number(this.getMeta("fitness", 0));

    let merged = 0;
    const seenPairs = new Set();
    const active = this.db.prepare("SELECT * FROM branches WHERE status='active' ORDER BY strength DESC").all().map((r) => this.rowToBranch(r));
    const scan = active.slice(0, 40);
    for (const a of scan) {
      if (merged >= 5) break;
      const emb = this.embedFor(a.rowId);
      if (!emb) continue;
      const sim = await this.findSimilar(emb, { limit: 2, excludeUid: a.id, minScore: MERGE_THRESHOLD });
      // v4.1 项目精准度：演化合并仅限【同一项目】的记忆（核心/无项目归属的记忆不受限），
      // 防止把不同项目里语义相近但内容独立的记忆合并归档、丢失各自项目细节。
      const top = sim.find((s) =>
        s.b.kind === a.kind
        && (this.isCoreBranch(a) || this.isCoreBranch(s.b) || !a.scopePath || !s.b.scopePath
          || this.sameProject(a.scopePath, s.b.scopePath))
      );
      if (!top) continue;
      const pairKey = a.id < top.b.id ? a.id + "|" + top.b.id : top.b.id + "|" + a.id;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      const stronger = a.strength >= top.b.strength ? a : top.b;
      const weaker = stronger.id === a.id ? top.b : a;
      this.mergeInto(stronger, weaker);
      merged++;
    }

    const prunedLinks = this.db.prepare("DELETE FROM links WHERE weight < ?").run(LINK_PRUNE_THRESHOLD).changes;

    this.applyDecay();
    const active2 = this.db.prepare("SELECT * FROM branches WHERE status='active'").all().map((r) => this.rowToBranch(r));
    const avg = active2.length ? active2.reduce((s, b) => s + b.strength, 0) / active2.length : 0;
    const fitnessAfter = Number(avg.toFixed(3));
    this.setMeta("fitness", fitnessAfter);
    // v4 自适应学习率：fitness 上升 → 加速（×1.06），下降 → 减速（×0.96），有界
    const lr = this.learningRate();
    const lrNext = clamp(fitnessAfter > fitnessBefore ? lr * 1.06 : (fitnessAfter < fitnessBefore ? lr * 0.96 : lr), LR_MIN, LR_MAX);
    this.setMeta("learningRate", Number(lrNext.toFixed(4)));
    this.setMeta("lastEvolveAt", now());
    // v4 自循环进化留痕：evolog 演化日志
    this.appendEvolog({ merged, prunedLinks, fitnessBefore, fitnessAfter, lr: lrNext, drift, nodes: active2.length });
    this.invalidateActiveCache();
    const g = this.graphData();
    return { ...g, merged, prunedLinks, fitnessAfter, lr: lrNext, drift };
  }

  /** v4 演化日志（保留 EVOLOG_KEEP 条，供自循环趋势分析） */
  appendEvolog(rec) {
    this.db.prepare(
      "INSERT INTO evolog (ts, epoch, generation, merged, pruned_links, fitness_before, fitness_after, lr, added_since, nodes, drift) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    ).run(
      now(), Number(this.getMeta("epoch", 1)), Number(this.getMeta("generation", 0)),
      rec.merged ?? 0, rec.prunedLinks ?? 0, rec.fitnessBefore ?? 0, rec.fitnessAfter ?? 0,
      rec.lr ?? LR_DEFAULT, rec.addedSince ?? 0, rec.nodes ?? 0, rec.drift ?? 0
    );
    this.db.prepare(
      "DELETE FROM evolog WHERE id NOT IN (SELECT id FROM evolog ORDER BY id DESC LIMIT ?)"
    ).run(EVOLOG_KEEP);
  }

  /**
   * v4 自循环演练分析（非破坏）：冗余/熵/衰减曲线/漂移/连接健康/孤儿向量。
   * 只读分析 —— 不会写入任何数据，可作为自动演化的「决策输入」。
   */
  async analyze() {
    const ts = now();
    const active = this.db.prepare("SELECT * FROM branches WHERE status='active'").all().map((r) => this.rowToBranch(r));
    const total = active.length;

    // 冗余：采样 top-N 强度分支，向量自相似 ≥0.9 的可合并候选对（跨种类，与去重口径一致）
    const scan = active.slice().sort((a, b) => b.strength - a.strength).slice(0, ANALYZE_SAMPLE);
    const redundancy = { pairs: 0, examples: [] };
    const seen = new Set();
    for (const a of scan) {
      const emb = this.embedFor(a.rowId);
      if (!emb) continue;
      const sim = await this.findSimilar(emb, { limit: 3, excludeUid: a.id, minScore: 0.9 });
      for (const s of sim) {
        const pairKey = a.id < s.b.id ? a.id + "|" + s.b.id : s.b.id + "|" + a.id;
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);
        redundancy.pairs++;
        if (redundancy.examples.length < 5) {
          redundancy.examples.push({ a: String(a.title).slice(0, 24), b: String(s.b.title).slice(0, 24), s: Number(s.s.toFixed(2)) });
        }
      }
    }

    // 信息熵：种类分布均匀度（0=单一，max≈1.6=均匀）
    const kindCounts = {};
    for (const b of active) kindCounts[b.kind] = (kindCounts[b.kind] ?? 0) + 1;
    let H = 0;
    for (const k of Object.keys(kindCounts)) {
      const p = kindCounts[k] / Math.max(1, total);
      H -= p * Math.log(p || 1);
    }

    // 衰减曲线：强度分桶（训练效果的形态）
    const decayCurve = { weak: 0, mid: 0, strong: 0 };
    for (const b of active) {
      if (b.strength < 0.4) decayCurve.weak++;
      else if (b.strength < 0.6) decayCurve.mid++;
      else decayCurve.strong++;
    }

    const staleCut = ts - STALE_DAYS * DAY_MS;
    const stale = active.filter((b) => b.updatedAt < staleCut && !this.isCoreBranch(b)).length;
    const links = this.db.prepare("SELECT COUNT(*) c FROM links WHERE weight >= ?").get(LINK_PRUNE_THRESHOLD).c;
    const weakLinks = this.db.prepare("SELECT COUNT(*) c FROM links WHERE weight < ?").get(LINK_PRUNE_THRESHOLD).c;
    const orphans = this.db.prepare("SELECT COUNT(*) c FROM memories WHERE rowid NOT IN (SELECT id FROM branches)").get().c;
    const meta = this.buildMeta();
    const density = total > 1 ? Number((links / (total * Math.max(1, total - 1) / 2)).toFixed(3)) : 0;
    const health = total > 0
      ? Number(clamp((1 - (redundancy.pairs / total) * 0.5) * (1 - (stale / total) * 0.3) * (1 - (orphans / total)), 0, 1).toFixed(3))
      : 1;
    return {
      at: ts,
      nodes: total,
      links,
      weakLinks,
      orphans,
      entropy: Number(H.toFixed(3)),
      redundancy,
      decayCurve,
      stale,
      density,
      meta: { epoch: meta.epoch, generation: meta.generation, fitness: meta.fitness, learningRate: meta.learningRate },
      health
    };
  }

  /**
   * v4 自循环进化演练（非破坏）：先 analyze 现状，再模拟一次演化流程
   * （合并冗余 → 修剪弱连接 → 衰减）的净效果，供「要不要演化」决策。
   */
  async drill() {
    const analysis = await this.analyze();
    const mergeCandidates = analysis.redundancy.pairs;
    const pruneCandidates = analysis.weakLinks;
    const predictedNodesAfterMerge = Math.max(1, analysis.nodes - Math.floor(mergeCandidates * 0.6));
    return {
      ...analysis,
      simulation: {
        mergeCandidates,
        pruneCandidates,
        predictedNodesAfterMerge,
        predictedLinksAfterPrune: Math.max(0, analysis.links - pruneCandidates),
        recommended: analysis.health < 0.85 || mergeCandidates >= 3 || analysis.stale >= 3
      }
    };
  }

  /** 把 weaker 合并进 stronger（归档 weaker，内容摘要并入 stronger 历史） */
  mergeInto(stronger, weaker) {
    const ts = now();
    const note = "〔演化合并自 " + weaker.title + "：" + String(weaker.content).slice(0, 120) + "〕";
    const sRow = this.db.prepare("SELECT * FROM branches WHERE uid=?").get(stronger.id);
    const history = safeJsonArray(sRow?.history, "[]");
    history.push({ at: ts, by: "system", summary: "演化合并: 吸收了 " + weaker.title });
    const content = String(stronger.content ?? "");
    const nextContent = content.length + note.length <= 4000 ? (content ? content + "\n" + note : note) : content;
    this.db.prepare(
      "UPDATE branches SET content=?, strength=?, updated_at=?, history=?, last_access_at=? WHERE uid=?"
    ).run(nextContent, clamp(stronger.strength + 0.03, 0, 1), ts, JSON.stringify(history.slice(-HISTORY_LIMIT)), ts, stronger.id);
    // v5.2：被合并分支归档即删向量；强者内容变化后后台重嵌入（保持语义检索命中合并内容）
    const wRow = this.db.prepare("SELECT id FROM branches WHERE uid=?").get(weaker.id);
    if (wRow) this.db.prepare("DELETE FROM memories WHERE rowid=?").run(BigInt(wRow.id));
    this.db.prepare("UPDATE branches SET status='archived', updated_at=? WHERE uid=?").run(ts, weaker.id);
    this.unlinkAll(weaker.id);
    this.setMeta("pruned", Number(this.getMeta("pruned", 0)) + 1);
    for (const l of this.linksOf(weaker.id)) {
      this.strengthenLink(stronger.id, l.other, l.weight * 0.6);
    }
    if (nextContent !== content) {
      embedText([stronger.title, (stronger.tags ?? []).join(" "), nextContent].filter(Boolean).join("。"))
        .then((nv) => { if (nv) this.storeEmbedding(stronger.rowId, nv); })
        .catch(() => {});
    }
  }

  /** 修剪：归档「弱且久」的记忆（强度<0.15 且创建>14天），清理其连接 */
  prune() {
    const ts = now();
    const cutoff = ts - PRUNE_AGE_DAYS * DAY_MS;
    const rows = this.db.prepare(
      "SELECT uid FROM branches WHERE status='active' AND strength < ? AND created_at < ?"
    ).all(PRUNE_STRENGTH, cutoff);
    const n = rows.length;
    const tx = this.db.transaction((items) => {
      for (const r of items) {
        this.db.prepare("UPDATE branches SET status='archived', updated_at=? WHERE uid=?").run(ts, r.uid);
        // 归档即移除向量（防孤儿向量堆积）
        const idRow = this.db.prepare("SELECT id FROM branches WHERE uid=?").get(r.uid);
        if (idRow) this.db.prepare("DELETE FROM memories WHERE rowid=?").run(BigInt(idRow.id));
        this.unlinkAll(r.uid);
      }
    });
    tx(rows);
    const prunedLinks = this.db.prepare("DELETE FROM links WHERE weight < ?").run(LINK_PRUNE_THRESHOLD).changes;
    this.setMeta("pruned", Number(this.getMeta("pruned", 0)) + n);
    this.setMeta("lastActivityAt", ts);
    this.invalidateActiveCache();
    const g = this.graphData();
    return { ...g, pruned: n, prunedLinks };
  }

  // -------------------------------------------------------------------------
  // v3.1：过期记忆清理 / 存储上限优化 / 轨迹喂养支撑
  // -------------------------------------------------------------------------

  /**
   * 过期记忆清理（每小时 + 每次喂养后 + 超限优化时执行）：
   *  - 超过 STALE_DAYS（30 天）且强度 < 0.1 → 彻底删除（含向量与突触）
   *  - 超过 STALE_DAYS 且强度 < 0.35 → 归档（保留历史）
   *  - 归档超过 STALE_RETENTION_DAYS（90 天）→ 彻底删除
   *  - v3.3：连接 TTL —— 超过 LINK_TTL_DAYS（3 天）无交互传输的连接断开
   *    （偏好/交流 ↔ 工作区目录的永久连接豁免）
   * 强记忆（≥0.35，如核心偏好）保留但检索降权，避免误删重要信息；
   * 偏好/交流核心永不自动归档/删除（除非用户主动删除/归档工作区）。
   */
  purgeStale() {
    const ts = now();
    const staleCut = ts - STALE_DAYS * DAY_MS;
    const retentionCut = ts - STALE_RETENTION_DAYS * DAY_MS;
    let archived = 0;
    let deleted = 0;
    let ttlBroken = 0;
    const rows = this.db.prepare("SELECT * FROM branches WHERE status='active'").all().map((r) => this.rowToBranch(r));
    for (const b of rows) {
      if (this.isCoreBranch(b)) continue; // 偏好/交流：永不自动归档/删除
      const ageBase = b.updatedAt || b.createdAt || ts;
      if (ageBase >= staleCut) continue;
      if (b.strength < STALE_DELETE_STRENGTH) {
        try { this.removeBranch(b.id, true); deleted++; } catch { /* 竞态忽略 */ }
      } else if (b.strength < STALE_ARCHIVE_STRENGTH) {
        try { this.removeBranch(b.id, false); archived++; } catch { /* 竞态忽略 */ }
      }
    }
    const delRows = this.db.prepare("SELECT uid FROM branches WHERE status='archived' AND updated_at < ?").all(retentionCut);
    for (const r of delRows) {
      try { this.removeBranch(r.uid, true); deleted++; } catch { /* 竞态忽略 */ }
    }
    // v3.3：连接 TTL —— 3 天无交互传输即断开（永久连接豁免）
    const ttlCut = ts - LINK_TTL_DAYS * DAY_MS;
    const linkRows = this.db.prepare("SELECT a, b FROM links WHERE updated_at < ?").all(ttlCut);
    for (const l of linkRows) {
      if (this.isPermanentLink(l.a, l.b)) continue;
      try {
        this.db.prepare("DELETE FROM links WHERE a=? AND b=?").run(l.a, l.b);
        ttlBroken++;
      } catch { /* 竞态忽略 */ }
    }
    if (archived + deleted > 0) {
      this.setMeta("staleCleaned", Number(this.getMeta("staleCleaned", 0)) + archived + deleted);
    }
    if (ttlBroken > 0) {
      this.setMeta("ttlBroken", Number(this.getMeta("ttlBroken", 0)) + ttlBroken);
    }
    this.setMeta("lastPurgeAt", ts);
    return { archived, deleted, ttlBroken };
  }

  /**
   * 提炼过期记忆精华：把超过 STALE_DAYS 的活跃记忆按摘要合并进一条
   * 「历史记忆精华」insight 分支（upsert），随后删除被提炼的过期记忆 ——
   * 「先提炼精炼重要信息喂养记忆，再删除过期无效记忆」。
   * v5.2：改为 async 并 await 精华更新完成后再删除（此前 fire-and-forget
   * 与删除并发，重嵌入向量可能晚于删除执行 → 产生孤儿向量）。
   */
  async distillStale() {
    const ts = now();
    const staleCut = ts - STALE_DAYS * DAY_MS;
    const rows = this.db.prepare("SELECT * FROM branches WHERE status='active'").all()
      .map((r) => this.rowToBranch(r))
      .filter((b) => !this.isCoreBranch(b) && (b.updatedAt || b.createdAt || ts) < staleCut);
    if (rows.length === 0) return { distilled: 0 };
    const dateLabel = new Date(ts).toLocaleDateString("zh-CN");
    const summary = rows.map((b) =>
      "• [" + (KIND_LABELS[b.kind] ?? b.kind) + "|" + b.strength.toFixed(2) + "] " + b.title + "：" + String(b.content ?? "").slice(0, 120)
    ).join("\n");
    const title = "历史记忆精华 " + dateLabel;
    const existing = this.findByTitle(title);
    if (existing) {
      const content = (String(existing.content ?? "") ? existing.content + "\n" : "") + summary;
      try { await this.updateBranch(existing.id, { content: content.slice(0, 8000), strength: clamp(existing.strength + 0.04, 0, 1) }, "system"); } catch { /* 精华更新失败不阻断清理 */ }
    } else {
      try { await this.writeBranch({ title, content: summary.slice(0, 8000), kind: "insight", tags: ["精华", "自动", "过期归档"], source: "system" }); } catch { /* 精华写入失败不阻断清理 */ }
    }
    let deleted = 0;
    for (const b of rows) {
      try { this.removeBranch(b.id, true); deleted++; } catch { /* 竞态忽略 */ }
    }
    this.setMeta("staleCleaned", Number(this.getMeta("staleCleaned", 0)) + deleted);
    return { distilled: rows.length, deleted };
  }

  /** 存储上限检查：超过 SIZE_LIMIT_BYTES 自动触发优化 */
  async checkSize() {
    const size = this.dbSizeBytes();
    this.setMeta("sizeBytes", size);
    if (size > SIZE_LIMIT_BYTES) {
      return { ...(await this.optimizeForSize()), triggered: true };
    }
    return { ok: true, sizeBytes: size, optimized: false, triggered: false };
  }

  /**
   * 超限优化：① 提炼过期记忆精华（喂养）→ ② 清理过期/无效记忆 →
   * ③ 清除孤儿向量 → ④ checkpoint + VACUUM 压缩。
   */
  async optimizeForSize() {
    const before = this.dbSizeBytes();
    let distilled = 0;
    let deleted = 0;
    try {
      const d = await this.distillStale();
      distilled = d.distilled ?? 0;
      deleted = (d.deleted ?? 0) + (d.distilled ?? 0);
    } catch { /* 提炼失败不阻断清理 */ }
    try {
      const p = this.purgeStale();
      deleted += p.archived + p.deleted;
    } catch { /* 清理失败不阻断压缩 */ }
    try {
      this.db.prepare("DELETE FROM memories WHERE rowid NOT IN (SELECT id FROM branches)").run();
      this.db.pragma("wal_checkpoint(TRUNCATE)");
      this.db.exec("VACUUM");
    } catch { /* 压缩失败保留原库 */ }
    const after = this.dbSizeBytes();
    this.setMeta("sizeBytes", after);
    this.setMeta("optimizedAt", now());
    this.setMeta("optimizedCount", Number(this.getMeta("optimizedCount", 0)) + 1);
    return { ok: true, before, after, freed: Math.max(0, before - after), distilled, deleted, optimized: true };
  }

  /**
   * 轨迹喂养（每小时）：把最近事件的提炼文本 upsert 进「会话精华」分支
   * （按小时窗口标题，同小时重复喂养自动合并）。
   * 返回 { fed: 事件数, wrote: 是否写入 }。
   */
  async feedTrajectory(events, sessionId, scopePath = null) {
    if (!Array.isArray(events) || events.length === 0) return { fed: 0, wrote: false };
    const ts = now();
    const text = distillTrajectory(events);
    if (!text) return { fed: events.length, wrote: false };
    // 小时窗口标题：同一小时的喂养归并到同一条「会话精华」
    const windowLabel = new Date(ts).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit" });
    const title = "会话精华 " + windowLabel;
    const existing = this.findByTitle(title);
    let target = existing;
    if (!target) {
      // v4 跨窗口语义去重：无精确标题时，与现有「会话精华」高相似(≥0.9)则合并，
      // 修复「会话精华 22时/00时 相似度 1.00」的重复分支（跨种类比较，不限于同标题）
      try {
        const emb = await embedText(text);
        if (emb) {
          const sim = await this.findSimilar(emb, { limit: 3, minScore: 0.9 });
          const best = sim.find((x) => /会话精华|轨迹自动|历史记忆精华/.test(String(x.b.title)));
          if (best) target = best.b;
        }
      } catch { /* 编码失败则退回新建 */ }
    }
    if (target) {
      this.db.prepare(
        "UPDATE branches SET content=?, strength=?, updated_at=?, last_access_at=? WHERE uid=?"
      ).run(text, clamp(target.strength + 0.05, 0, 1), ts, ts, target.id);
      // v5.2 修复：内容更新后重嵌入向量（否则语义检索永远命中旧内容）
      try {
        const vec = await embedText([target.title, (target.tags ?? []).join(" "), text].filter(Boolean).join("。"));
        if (vec) this.storeEmbedding(target.rowId, vec);
      } catch { /* 重嵌入失败保留旧向量（词法仍可命中） */ }
    } else {
      await this.writeBranch({
        title,
        content: text,
        kind: "insight",
        tags: ["自动", "轨迹", "会话精华"],
        source: "system",
        strength: 0.55,
        sessionId: sessionId ?? null
      });
    }
    // v4 训练效果：自动提炼当前工作状态（若 events 含用户最新指令）——
    // 让「当前工作状态」分支始终跟随最近一次任务进展，检索优先级更高
    if (AUTO_STATE) {
      try { await this.autoRefineWorkstate(events, sessionId, scopePath); } catch { /* 不阻断喂养主流程 */ }
    }
    this.setMeta("feedAt", ts);
    this.invalidateActiveCache();
    return { fed: events.length, wrote: true, title, chars: text.length };
  }

  /**
   * v4 自动工作状态提炼：取 events 中最新一条用户消息（排除被压缩替换的旧事件）
   * 作为当前工作内容，upsert 当前项目（scopePath 匹配优先）的 workstate 分支。
   * 训练效果：workstate 是检索/记忆包的最高优先分支，保持其新鲜 = 项目记忆锚点永远准确。
   */
  async autoRefineWorkstate(events, sessionId, scopePath) {
    const latest = [...events]
      .filter((ev) => ev && ev.type === "user/message" && !ev.compressed)
      .sort((a, b) => (a.time || 0) - (b.time || 0))
      .pop();
    if (!latest) return false;
    const content = messageTextOf(latest);
    if (!content || content.length < 4) return false;
    const active = this.activeBranches().filter((b) => b.kind === "workstate");
    let target = null;
    if (scopePath) target = active.filter((b) => b.scopePath === scopePath).sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
    if (!target) target = active.sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
    const title = "工作状态";
    const ts = now();
    if (target) {
      this.db.prepare(
        "UPDATE branches SET title=?, content=?, updated_at=?, last_access_at=? WHERE uid=?"
      ).run(title, content.slice(0, 400), ts, ts, target.id);
      // v5.2 修复：workstate 内容更新后重嵌入向量（此前语义检索永远命中旧任务内容）
      try {
        const vec = await embedText([title, "状态", content.slice(0, 400)].filter(Boolean).join("。"));
        if (vec) this.storeEmbedding(target.rowId, vec);
      } catch { /* 重嵌入失败保留旧向量 */ }
    } else {
      await this.writeBranch({
        title,
        content: content.slice(0, 400),
        kind: "workstate",
        tags: ["状态"],
        source: "system",
        strength: 0.6,
        sessionId: sessionId ?? null,
        scopePath: scopePath ?? null
      });
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // 可视化 / 统计 / 项目记忆包
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // v3.3：球形神经网络图（核心/工作区环/衍生外圈）
  // -------------------------------------------------------------------------

  /** 图数据缓存失效（任何写操作后调用） */
  invalidateGraphCache() {
    this.graphCache = null;
  }

  /**
   * 可视化图（3D 球形神经网络）：
   *  - 核心：偏好/交流记忆节点（球心附近，永不衰减）
   *  - 工作区目录：第一层球面（围绕核心，与核心永久连接）
   *  - 衍生记忆：外球面（按所属工作区方向扇区扩散）
   * 每个节点带三维理想坐标（x0/y0/z0，归一化 -1..1），客户端 3D 投影渲染；
   * 边 = 持久化突触（含永久连接），向量兜底补孤立衍生节点；
   * 结果缓存 20 秒（启动预热后打开秒开）。
   */
  graphData() {
    if (this.graphCache && now() - this.graphCache.at < 20000) {
      return this.graphCache.data;
    }
    const active = this.db.prepare("SELECT * FROM branches WHERE status='active'").all().map((r) => this.rowToBranch(r));
    const byId = new Map(active.map((b) => [b.rowId ?? b.id, b]));
    const cores = active.filter((b) => this.isCoreBranch(b));
    const leaves = active.filter((b) => !this.isCoreBranch(b));
    const wdirs = this.activeWorkdirs();

    // Fibonacci 球面均匀方向
    const sphereDir = (i, n, offset = 0) => {
      const y = 1 - (i / Math.max(1, n - 1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = (i + 0.5) * 2.399963229728653 + offset;
      return { x: Math.cos(theta) * r, y, z: Math.sin(theta) * r };
    };
    const hash01 = (seed) => hashOf(seed);
    const norm = (v) => {
      const l = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) || 1e-6;
      return { x: v.x / l, y: v.y / l, z: v.z / l };
    };

    const nodes = [];
    // 核心：球心附近小团簇（偏好/交流）—— v5.5 半径略增避免核心重叠
    cores.forEach((b, i) => {
      const d = sphereDir(i, Math.max(1, cores.length), 1.7);
      // v5.7 核心布局半径扩大，避免互相挤占/与工作区环重叠
      const r = 0.13 + hash01("cr" + b.id) * 0.10;
      nodes.push({
        id: b.id, uid: b.id, title: b.title, kind: b.kind, strength: b.strength, status: b.status,
        type: "core", ring: 0, activation: b.strength,
        ageDays: Math.max(0, (now() - (b.createdAt || now())) / DAY_MS),
        x0: d.x * r, y0: d.y * r, z0: d.z * r
      });
    });
    // 工作区目录：第一层球面
    const wdirDirs = wdirs.map((w, i) => {
      const d = sphereDir(i, Math.max(1, wdirs.length), 0);
      return { w, d };
    });
    wdirDirs.forEach(({ w, d }, i) => {
      // v5.7 工作区环稍外移，与核心簇拉开间距
      const r = 0.38 + hash01("wr" + w.path) * 0.07;
      nodes.push({
        id: this.workdirId(w.path), uid: this.workdirId(w.path), title: "📁 " + (w.name ?? w.path),
        kind: "workdir", strength: 0.85, status: "active", workdir: w.path,
        type: "workdir", ring: 1, activation: 0.85, ageDays: 0,
        x0: d.x * r, y0: d.y * r, z0: d.z * r
      });
    });
    // 衍生记忆：外球面，按所属工作区方向扇区扩散
    // v5.5：同一扇区内的叶子做「二次均匀散布」（局部 Fibonacci 球面），
    // 替代 hash 随机抖动 —— 避免节点堆叠/距离过近；半径范围扩大拉开层次
    const wdirDirMap = new Map(wdirDirs.map(({ w, d }) => [w.path, d]));
    const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
    const axisOf = (d) => (Math.abs(d.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 });
    // 按扇区收集叶子（无工作区 → __global__）
    const bySector = new Map();
    for (const b of leaves) {
      const wd = b.scopePath ?? null;
      const key = wd && wdirDirMap.has(wd) ? wd : "__global__";
      if (!bySector.has(key)) bySector.set(key, []);
      bySector.get(key).push(b);
    }
    const pushLeaf = (b, d, r) => {
      nodes.push({
        id: b.id, uid: b.id, title: b.title, kind: b.kind, strength: b.strength, status: b.status,
        type: "leaf", ring: 2, workdir: b.scopePath ?? null, activation: b.strength,
        ageDays: Math.max(0, (now() - (b.createdAt || now())) / DAY_MS),
        x0: d.x * r, y0: d.y * r, z0: d.z * r
      });
    };
    // 全局叶子（无工作区）：球面 Fibonacci 均匀散布
    const globalLeaves = bySector.get("__global__") ?? [];
    globalLeaves.forEach((b, i) => {
      const d = sphereDir(i, Math.max(1, globalLeaves.length), 3.3);
      pushLeaf(b, d, 0.82 + hash01("lr" + b.id) * 0.26);
    });
    // 每个工作区扇区：以扇区中心方向为轴，扇区内做局部 Fibonacci 二次均匀散布
    for (const [wd, list] of bySector) {
      if (wd === "__global__") continue;
      const baseDir = wdirDirMap.get(wd);
      const u = norm(cross(baseDir, axisOf(baseDir)));
      const v = norm(cross(baseDir, u));
      const sectorSeed = hash01("so" + wd) * 6.283;
      list.forEach((b, i) => {
        const y = 1 - (i / Math.max(1, list.length - 1)) * 2; // -1..1
        const rr = Math.sqrt(Math.max(0, 1 - y * y));
        const theta = (i + 0.5) * 2.399963229728653 + sectorSeed;
        const spread = Math.sin(0.55) * rr; // 扇区锥半角 0.55
        const dir = norm({
          x: baseDir.x + (u.x * Math.cos(theta) + v.x * Math.sin(theta)) * spread,
          y: baseDir.y + (u.y * Math.cos(theta) + v.y * Math.sin(theta)) * spread,
          z: baseDir.z + (u.z * Math.cos(theta) + v.z * Math.sin(theta)) * spread
        });
        pushLeaf(b, dir, 0.84 + hash01("lr" + b.id) * 0.28);
      });
    }

    // 边：持久化突触（含核心↔工作区永久连接、衍生↔工作区连接、记忆间连接）
    const edgeMap = new Map();
    for (const l of this.db.prepare("SELECT a, b, weight FROM links WHERE weight >= ?").all(LINK_PRUNE_THRESHOLD)) {
      edgeMap.set(l.a + "|" + l.b, { a: l.a, b: l.b, weight: l.weight });
    }
    // 向量兜底：孤立衍生节点补最近邻边（写入 links 持久化，单轮限量）
    const degreeMap = new Map();
    for (const e of edgeMap.values()) {
      degreeMap.set(e.a, (degreeMap.get(e.a) ?? 0) + 1);
      degreeMap.set(e.b, (degreeMap.get(e.b) ?? 0) + 1);
    }
    const FALLBACK_MAX_EDGES = 30;
    let addedFallback = 0;
    for (const a of leaves) {
      if (addedFallback >= FALLBACK_MAX_EDGES) break;
      if ((degreeMap.get(a.id) ?? 0) > 0) continue;
      const row = this.db.prepare("SELECT id FROM branches WHERE uid=?").get(a.id);
      if (!row) continue;
      const emb = this.embedFor(row.id);
      if (!emb) continue;
      const hits = this.db.prepare(
        "SELECT rowid, distance FROM memories WHERE embedding MATCH ? ORDER BY distance LIMIT 4"
      ).all(emb);
      for (const h of hits) {
        if (h.rowid === row.id) continue;
        const b = byId.get(h.rowid);
        if (!b) continue;
        const w = clamp(1 - (h.distance * h.distance) / 2, 0, 1);
        if (w < 0.16) continue;
        const key = a.id < b.id ? a.id + "|" + b.id : b.id + "|" + a.id;
        if (edgeMap.has(key)) continue;
        this.setLink(a.id, b.id, w);
        edgeMap.set(key, { a: a.id, b: b.id, weight: w });
        degreeMap.set(a.id, (degreeMap.get(a.id) ?? 0) + 1);
        degreeMap.set(b.id, (degreeMap.get(b.id) ?? 0) + 1);
        addedFallback++;
        if (addedFallback >= FALLBACK_MAX_EDGES) break;
      }
    }
    const edges = [...edgeMap.values()];
    for (const node of nodes) node.degree = degreeMap.get(node.id) ?? 0;
    const avg = active.length ? active.reduce((s, b) => s + b.strength, 0) / active.length : 0;
    const meta = this.buildMeta();
    const data = {
      nodes,
      edges,
      meta: {
        ...meta,
        epoch: meta.epoch,
        neurons: nodes.length,
        connections: edges.length,
        fitness: Number(avg.toFixed(3)),
        activation: Number(avg.toFixed(3))
      }
    };
    this.graphCache = { data, at: now() };
    return data;
  }

  buildMeta() {
    // v4 读取速率：2s 短时缓存 —— 高频 list/stats/context 调用免重复聚合查询；
    // 任何 setMeta 已使缓存失效（metaCache = null）
    if (this.metaCache && now() - this.metaCache.at < META_CACHE_MS) return this.metaCache.data;
    const total = this.db.prepare("SELECT COUNT(*) AS c FROM branches").get().c;
    const active = this.db.prepare("SELECT COUNT(*) AS c FROM branches WHERE status='active'").get().c;
    // v5.2：种类计数单条 GROUP BY（此前每个种类一次 COUNT 查询）
    const kinds = {};
    for (const row of this.db.prepare(
      "SELECT kind, COUNT(*) AS c FROM branches WHERE status='active' GROUP BY kind"
    ).all()) kinds[row.kind] = row.c;
    for (const k of KINDS) if (!(k in kinds)) kinds[k] = 0;
    const links = this.db.prepare("SELECT COUNT(*) AS c FROM links WHERE weight >= ?").get(LINK_PRUNE_THRESHOLD).c;
    const data = {
      epoch: Number(this.getMeta("epoch", 1)),
      generation: Number(this.getMeta("generation", 0)),
      iteration: Number(this.getMeta("iteration", 0)),
      error: Number(this.getMeta("error", 0)),
      learningRate: Number(this.getMeta("learningRate", LR_DEFAULT)),
      pruned: Number(this.getMeta("pruned", 0)),
      added: Number(this.getMeta("added", 0)),
      merged: Number(this.getMeta("merged", 0)),
      fitness: Number(this.getMeta("fitness", 0)),
      counts: { total, active, archived: total - active, kinds },
      neurons: active,
      connections: links,
      activation: 0,
      lastActivityAt: this.getMeta("lastActivityAt", null),
      // v3.1：喂养 / 存储 / 过期清理状态
      feedAt: this.getMeta("feedAt", null),
      sizeBytes: this.dbSizeBytes(),
      staleCleaned: Number(this.getMeta("staleCleaned", 0)),
      lastPurgeAt: this.getMeta("lastPurgeAt", null),
      optimizedAt: this.getMeta("optimizedAt", null),
      optimizedCount: Number(this.getMeta("optimizedCount", 0)),
      // v3.2：节点上限淘汰计数
      cappedRemoved: Number(this.getMeta("cappedRemoved", 0)),
      // v3.3：连接 TTL 断开 / 归档工作区计数
      ttlBroken: Number(this.getMeta("ttlBroken", 0)),
      archivedWorkdirs: Number(this.getMeta("archivedWorkdirs", 0))
    };
    this.metaCache = { data, at: now() };
    return data;
  }

  /**
   * v3：项目记忆包 —— 长会话中刷新上下文锚点，缓解上下文污染。
   * 返回当前作用域浓缩记忆：按 强度×0.6 + 新鲜度×0.4 排序的 topN、
   * 最新工作状态、最新洞察、以及记忆库健康统计。
   * v5.2：复用活动快照；minQuality 过滤低质量记忆（对话前注入默认 0.5，
   * 避免把标题残缺/内容过短的记忆注入系统提示浪费 token）。
   */
  contextPack({ topN = 12, maxLen = 200, minQuality = 0 } = {}) {
    const ts = now();
    const n = clamp(Math.floor(topN ?? 12), 3, 30);
    const len = clamp(Math.floor(maxLen ?? 200), 60, 800);
    const active = this.activeBranches();
    const scored = active.map((b) => {
      const ageDays = Math.max(0, (ts - (b.updatedAt || ts)) / DAY_MS);
      const recency = Math.max(0, 1 - ageDays / 30);
      const q = minQuality > 0 ? this.computeQuality(b) : 1;
      return { b, s: (b.strength * 0.6 + recency * 0.4) * (q >= minQuality ? 1 : 0) };
    }).filter((x) => x.s > 0).sort((x, y) => y.s - x.s);
    const top = scored.slice(0, n).map(({ b, s }) => {
      const c = String(b.content ?? "");
      return { ...this.sanitize(b), content: c.length > len ? c.slice(0, len) + "…" : c, packScore: Number(s.toFixed(3)) };
    });
    const workstate = active.filter((b) => b.kind === "workstate").sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
    const insight = active.filter((b) => b.kind === "insight").sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
    const stats = this.buildMeta();
    // v5.8：记忆包文本框架英文化（降低对话中 memory_context 的 token 支出；记忆内容保留原文）
    const head = "【Hippocampus Memory Pack】" + (this.projectPath ? " cwd: " + this.projectPath : "");
    const lines = [head];
    if (workstate) lines.push("▶ Work state: " + String(workstate.content).slice(0, 300));
    for (const t of top) {
      lines.push("• [" + t.kind + "|" + t.strength.toFixed(2) + "|" + t.packScore.toFixed(2) + "] " + t.title + " — " + String(t.content).slice(0, len));
    }
    if (insight && !top.some((t) => t.id === insight.id)) {
      lines.push("• [insight] " + insight.title + " — " + String(insight.content).slice(0, len));
    }
    lines.push("〔stats: active " + stats.counts.active + " · links " + stats.connections + " · avg-strength " + (stats.fitness || 0).toFixed(2) + " · epoch " + stats.epoch + " · archived " + stats.counts.archived + " · db " + Math.round(stats.sizeBytes / 1024) + "KB〕");
    // v5.4：记忆包被调用 → 激活 top 锚点（保持工作记忆延续）+ 附带锚点列表
    if (this.anchors) {
      this.anchors.activate(top.slice(0, 8).map((t) => t.id), 0.4);
      this.anchors.purge();
    }
    return {
      scope: this.scope,
      projectPath: this.projectPath ?? null,
      text: lines.join("\n"),
      top,
      workstate: workstate ? this.sanitize(workstate) : null,
      stats,
      anchors: this.anchors ? this.anchors.list(16).map((a) => ({ id: a.id, weight: Number(a.weight.toFixed(3)) })) : []
    };
  }

  reportWork({ task, phase, progress, sessionId }) {
    this.setMeta("lastActivityAt", now());
    if (typeof sessionId === "string") this.setMeta("lastSessionId", sessionId);
    if (typeof task === "string") this.setMeta("lastTask", task.slice(0, 300));
    const qTokens = tokensOf("工作状态");
    const active = this.activeBranches();
    let ws = active.filter((b) => b.kind === "workstate").sort((a, b) => scoreQuery(b, qTokens) - scoreQuery(a, qTokens))[0];
    const ts = now();
    const content = [
      task ? "任务：" + task : "",
      phase ? "阶段：" + phase : "",
      typeof progress === "number" ? "进度：" + Math.round(clamp(progress, 0, 1) * 100) + "%" : "",
      "更新于 " + new Date(ts).toLocaleString("zh-CN")
    ].filter(Boolean).join("\n");
    if (ws) {
      const history = safeJsonArray(this.db.prepare("SELECT history FROM branches WHERE uid=?").get(ws.id)?.history, "[]");
      history.push({ at: ts, by: "agent", summary: "工作状态更新" });
      this.db.prepare("UPDATE branches SET content=?, strength=?, updated_at=?, last_access_at=?, history=? WHERE uid=?").run(
        content, clamp(ws.strength + 0.08, 0, 1), ts, ts, JSON.stringify(history.slice(-HISTORY_LIMIT)), ws.id
      );
    } else {
      this.writeBranch({ ...seedBranch("工作状态", content, "workstate", ["状态"], 0.6), source: "agent", sessionId }).catch(() => {});
    }
    return { ok: true, meta: this.buildMeta() };
  }

  stats() {
    const g = this.graphData();
    // v5.4：统计响应附带当前激活锚点（前端金色锚环可视化）
    return {
      counts: this.buildMeta().counts,
      meta: this.buildMeta(),
      graph: g,
      anchors: this.anchors ? this.anchors.list(24).map((a) => ({ id: a.id, weight: Number(a.weight.toFixed(3)) })) : []
    };
  }

  sanitize(branch) {
    const q = this.computeQuality(branch);
    return { ...branch, quality: q, history: (branch.history ?? []).slice(-10) };
  }

  /** 质量评分 0..1：完整性（内容长度/标题/标签）+ 清晰度 + 时效修正 */
  computeQuality(branch) {
    if (!branch) return 0;
    let s = 0.5;
    // 标题 ≥ 3 字 +1 分；≥ 8 字 +2 分
    const tl = (branch.title ?? "").length;
    if (tl >= 3) s += 0.1;
    if (tl >= 8) s += 0.1;
    // 内容够长
    const cl = (branch.content ?? "").length;
    if (cl >= 20) s += 0.1;
    if (cl >= 80) s += 0.2;
    // 有标签
    const tags = Array.isArray(branch.tags) ? branch.tags : [];
    if (tags.length >= 1) s += 0.1;
    if (tags.length >= 3) s += 0.1;
    // 有时间信息
    if (branch.updatedAt && branch.createdAt) s += 0.1;
    // 新鲜度降权（>60 天）
    if (branch.updatedAt && (now() - branch.updatedAt) > 60 * DAY_MS) s -= 0.1;
    return clamp(s, 0, 1);
  }

  /** 所有标签及其使用计数（全局统计，用于标签云和合并） */
  tags() {
    const rows = this.db.prepare("SELECT tags FROM branches WHERE status='active' OR status='archived'").all();
    const map = new Map();
    for (const r of rows) {
      for (const t of safeJsonArray(r.tags, "[]")) {
        map.set(t, (map.get(t) ?? 0) + 1);
      }
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count }));
  }

  /** 合并/重命名标签：旧标签替换为新标签 */
  tagRename(oldTag, newTag) {
    if (!oldTag || !newTag) return { renamed: 0 };
    const rows = this.db.prepare("SELECT id, tags FROM branches WHERE status='active' OR status='archived'").all();
    let cnt = 0;
    const tx = this.db.transaction(() => {
      for (const r of rows) {
        let tags = safeJsonArray(r.tags, "[]");
        const idx = tags.indexOf(oldTag);
        if (idx === -1) continue;
        tags[idx] = newTag;
        this.db.prepare("UPDATE branches SET tags=?, updated_at=? WHERE id=?").run(JSON.stringify(tags), now(), r.id);
        cnt++;
      }
    });
    tx();
    return { renamed: cnt, from: oldTag, to: newTag };
  }

  /** 导出所有记忆为 Markdown（含元数据） */
  exportAll() {
    const rows = this.db.prepare("SELECT * FROM branches WHERE status='active' ORDER BY updated_at DESC").all()
      .map((r) => this.rowToBranch(r));
    const lines = ["# 海马体记忆导出", "导出时间: " + new Date().toISOString(), "条目数: " + rows.length, "---"];
    for (const b of rows) {
      lines.push("## " + b.title);
      lines.push("_种类: " + (KIND_LABELS[b.kind] ?? b.kind) + " · 标签: " + (b.tags ?? []).join(", ") + " · 强度: " + (b.strength ?? 0.6).toFixed(2) + "_");
      lines.push("");
      lines.push(b.content);
      lines.push("---");
    }
    return lines.join("\n");
  }

  /**
   * 从 Markdown 导入记忆（带去重合并）。
   * v5.2：限量 300 条 + 每 5 条让出事件循环，防止大文件导入长时间阻塞主线程。
   */
  async importAll(text) {
    const items = parseMarkdownExport(text).slice(0, 300);
    let imported = 0, dedup = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      try {
        const out = await this.writeBranch({ ...item, source: "user" });
        if (out.dedup) dedup++; else imported++;
      } catch { /* 单条失败不中断导入 */ }
      if ((i & 4) === 4) await new Promise((res) => setTimeout(res, 0));
    }
    return { imported, dedup, total: items.length, truncated: items.length < parseMarkdownExport(text).length };
  }

  // -------------------------------------------------------------------------
  // v5：间隔重复复习调度（P5）—— 到期记忆优先召回 + 待复习提醒
  // -------------------------------------------------------------------------

  /** 间隔重复：强度越高，复习间隔越长（艾宾浩斯曲线，1~28 天） */
  reviewIntervalDays(strength) {
    return clamp(Math.round(1 + strength * 27), 1, 28);
  }

  /** 到期复习时间戳（纯函数，无需落库：由强度 + 最近访问时间推出） */
  reviewDueAt(branch) {
    const base = branch.lastAccessAt || branch.updatedAt || branch.createdAt || now();
    return base + this.reviewIntervalDays(branch.strength) * DAY_MS;
  }

  /** 待复习记忆列表（按到期先后排序） */
  reviewDue(limit = 50) {
    const ts = now();
    const rows = this.db.prepare("SELECT * FROM branches WHERE status='active'").all().map((r) => this.rowToBranch(r));
    const due = rows
      .map((b) => ({ b, at: this.reviewDueAt(b) }))
      .filter((x) => x.at <= ts)
      .sort((a, b) => a.at - b.at)
      .slice(0, clamp(limit, 1, 200))
      .map((x) => this.sanitize(x.b));
    return { due: due.length, branches: due };
  }

  /** 复习一条记忆：再巩固强化 + 刷新复习期 */
  review(uid) {
    const b = this.getByUid(uid);
    if (!b) throw new Error("hippocampus.review: 记忆不存在: " + uid);
    const ts = now();
    const boost = clamp(RECONSOLIDATE_BOOST * (1 + this.learningRate()), 0.03, 0.12);
    const ns = clamp(b.strength + boost, 0, 1);
    const history = safeJsonArray(this.db.prepare("SELECT history FROM branches WHERE uid=?").get(uid)?.history, "[]");
    history.push({ at: ts, by: "user", summary: "复习强化（间隔重复）" });
    this.db.prepare("UPDATE branches SET strength=?, last_access_at=?, updated_at=?, history=? WHERE uid=?").run(
      ns, ts, ts, JSON.stringify(history.slice(-HISTORY_LIMIT)), uid
    );
    this.invalidateActiveCache();
    return this.sanitize(this.getByUid(uid));
  }

  /** 记忆时间线：创建 / 修正历史 / 归档 / 演化事件合并，按时间倒序 */
  timeline(limit = 80) {
    const rows = this.db.prepare("SELECT * FROM branches").all().map((r) => this.rowToBranch(r));
    const events = [];
    for (const b of rows) {
      events.push({ ts: b.createdAt, type: "created", id: b.id, title: b.title, kind: b.kind, status: b.status, detail: "创建记忆" });
      for (const h of b.history ?? []) {
        events.push({ ts: h.at, type: "history", id: b.id, title: b.title, kind: b.kind, by: h.by, detail: String(h.summary ?? "").slice(0, 90) });
      }
      if (b.status === "archived") {
        events.push({ ts: b.updatedAt, type: "archived", id: b.id, title: b.title, detail: "归档记忆" });
      }
    }
    try {
      const evo = this.db.prepare("SELECT * FROM evolog ORDER BY ts DESC LIMIT 40").all();
      for (const e of evo) {
        events.push({
          ts: e.ts, type: "evolve", id: "evo:" + e.id, title: "演化 · epoch " + e.epoch,
          detail: "合并 " + e.merged + " · 修剪连接 " + e.pruned_links + " · fitness " + Number(e.fitness_after || 0).toFixed(3)
        });
      }
    } catch { /* evolog 缺失忽略 */ }
    events.sort((a, b) => b.ts - a.ts);
    return events.slice(0, clamp(limit, 10, 300));
  }

  // -------------------------------------------------------------------------
  // v5.1：注入留痕（F9 注入日志面板的数据源）
  //   - 对话前自动注入（registerPromptMemory，每轮 turn 前）
  //   - 工具调取（memory_context）
  //   - 界面刷新（记忆页「刷新」/ projectPath 后台刷新）
  // -------------------------------------------------------------------------

  /** 记录一次记忆注入（mode: auto / tool / refresh） */
  logInjection(mode, branches, workstateId) {
    try {
      const active = Array.isArray(branches) ? branches.filter(Boolean) : [];
      const workstate = active.some((b) => b && workstateId && b.id === workstateId);
      const chars = active.reduce((s, b) => s + (b.content ? String(b.content).length : 0) + (b.title ? String(b.title).length : 0), 0);
      this.db.prepare(
        "INSERT INTO inject_log(ts, mode, count, workstate, chars, title) VALUES(?,?,?,?,?,?)"
      ).run(
        now(), String(mode || "auto"), active.length, workstate ? 1 : 0, chars,
        active.slice(0, 6).map((b) => String(b.title ?? "").slice(0, 24)).join(" | ")
      );
      this.db.prepare(
        "DELETE FROM inject_log WHERE id NOT IN (SELECT id FROM inject_log ORDER BY id DESC LIMIT ?)"
      ).run(INJECT_LOG_KEEP);
    } catch { /* 注入留痕失败不影响主流程 */ }
  }

  /** 读取注入日志（倒序） */
  injectLog(limit = 60) {
    try {
      const rows = this.db.prepare("SELECT * FROM inject_log ORDER BY id DESC LIMIT ?").all(clamp(limit, 1, 300));
      return rows.map((r) => ({
        id: r.id, ts: r.ts, mode: r.mode, count: r.count,
        workstate: !!r.workstate, chars: r.chars, title: r.title
      }));
    } catch { return []; }
  }

  // -------------------------------------------------------------------------
  // v5.1：突触手动编辑（F5 —— 在两个记忆之间显式连接 / 断开）
  // -------------------------------------------------------------------------

  /** 手动连接突触：显式建立/加强两记忆间的连接（取更大权重） */
  linkManual(uidA, uidB, weight) {
    const a = this.getByUid(uidA);
    const b = this.getByUid(uidB);
    if (!a || !b) throw new Error("hippocampus.linkManual: 记忆不存在");
    if (uidA === uidB) throw new Error("hippocampus.linkManual: 不能连接记忆自身");
    const w = clamp(typeof weight === "number" ? weight : 0.6, 0.05, 1);
    this.setLink(uidA, uidB, w);
    const ts = now();
    for (const target of [a, b]) {
      const row = this.db.prepare("SELECT history FROM branches WHERE uid=?").get(target.id);
      const history = safeJsonArray(row?.history, "[]");
      history.push({ at: ts, by: "user", summary: "手动连接突触 → " + (target.id === a.id ? b.title : a.title) + "（权重 " + w.toFixed(2) + "）" });
      this.db.prepare("UPDATE branches SET history=?, updated_at=? WHERE uid=?").run(
        JSON.stringify(history.slice(-HISTORY_LIMIT)), ts, target.id
      );
    }
    this.invalidateActiveCache();
    return { linked: true, a: uidA, b: uidB, weight: w };
  }

  /** 手动断开突触：删除两记忆间的连接 */
  unlinkManual(uidA, uidB) {
    if (!uidA || !uidB || uidA === uidB) throw new Error("hippocampus.unlinkManual: 参数不合法");
    const [x, y] = this.linkKey(uidA, uidB);
    const existed = this.db.prepare("SELECT weight FROM links WHERE a=? AND b=?").get(x, y);
    if (!existed) return { unlinked: false, a: uidA, b: uidB, reason: "两记忆间无连接" };
    this.db.prepare("DELETE FROM links WHERE a=? AND b=?").run(x, y);
    this.invalidateActiveCache();
    return { unlinked: true, a: uidA, b: uidB, removedWeight: existed.weight };
  }

  // -------------------------------------------------------------------------
  // v5.1：演化日志查看（F6 —— 合并/修剪/代际的留痕）
  // -------------------------------------------------------------------------

  /** 演化日志列表（倒序） */
  evologList(limit = 40) {
    try {
      const rows = this.db.prepare("SELECT * FROM evolog ORDER BY id DESC LIMIT ?").all(clamp(limit, 1, 200));
      return rows.map((r) => ({
        id: r.id, ts: r.ts, epoch: r.epoch, generation: r.generation,
        merged: r.merged, prunedLinks: r.pruned_links,
        fitnessBefore: r.fitness_before, fitnessAfter: r.fitness_after,
        lr: r.lr, addedSince: r.added_since, nodes: r.nodes, drift: r.drift
      }));
    } catch { return []; }
  }

  close() {
    try { this.db.pragma("wal_checkpoint(TRUNCATE)"); } catch {}
    try { this.db.close(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// 活动注册表（v3.1：每小时自动喂养需要知道哪些项目在活跃、用哪个会话）
// ---------------------------------------------------------------------------

class ActivityRegistry {
  constructor(file) {
    this.file = file;
    this.map = new Map();
    this._saveTimer = null;
    try {
      const raw = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(raw);
      for (const [k, v] of Object.entries(parsed)) this.map.set(k, v);
    } catch { /* 首次使用或损坏时为空 */ }
  }

  /** 记录项目活跃（工具/Remote 调用时触发），并登记最近使用的会话 */
  touch(projectPath, sessionId) {
    if (!projectPath) return;
    const entry = this.map.get(projectPath) ?? { sessionIds: [], lastActiveAt: 0 };
    if (sessionId && !entry.sessionIds.includes(sessionId)) {
      entry.sessionIds.push(sessionId);
      entry.sessionIds = entry.sessionIds.slice(-5);
    }
    entry.lastActiveAt = now();
    this.map.set(projectPath, entry);
    // v4 注册表防抖：高频 touch 不每次写盘，合并为 2s 一次
    this._debounceSave();
  }

  _debounceSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.map)));
      } catch { /* 注册表写失败不影响主流程 */ }
    }, 2000);
  }

  /** 最近活跃的项目（窗口内） */
  recentProjects() {
    const cut = now() - REGISTRY_ACTIVE_WINDOW_MS;
    return [...this.map.entries()]
      .filter(([, e]) => e.lastActiveAt >= cut)
      .map(([projectPath, e]) => ({ projectPath, sessionIds: e.sessionIds ?? [] }));
  }
}

// ---------------------------------------------------------------------------
// 存储工厂（v3.2：统一记忆库单例 —— 所有工作区目录读写同一记忆库，实现打通）
// ---------------------------------------------------------------------------

class HippocampusDbFactory {
  constructor() {
    this.dbs = new Map();
    // v5.4：激活锚点（工作记忆延续）—— 统一库单例共享，所有会话/项目共用一份工作记忆
    this.anchors = new AnchorBank();
    // v5.4：消息预检索缓存 —— 用户消息到达（agent/inbox/inserted）时异步检索，
    // 系统提示组装（模型请求前）时读取注入：真正实现「先梳理检索、再决定输出」
    this.recallCache = new Map(); // agentId -> { q, results, anchors, at }
  }
  getDb(scope, projectPath) {
    // scope/scopePath 仅为向后兼容，统一返回同一个记忆库
    const key = "unified";
    let db = this.dbs.get(key);
    if (!db) {
      db = new HippocampusDb("global", null, this.anchors);
      this.dbs.set(key, db);
    }
    return db;
  }
  /** 记录一次消息预检索结果（按 agent 区分，仅保留最近一条） */
  setRecall(agentId, entry) {
    if (!entry || !Array.isArray(entry.results)) return;
    this.recallCache.set(agentId ?? "__global__", entry);
    // 容量保护：最多 16 个 agent，超出淘汰最旧
    if (this.recallCache.size > 16) {
      const oldest = this.recallCache.keys().next().value;
      this.recallCache.delete(oldest);
    }
  }
  /** 读取最近的预检索结果（maxAgeMs 内最新的一条；无则 null） */
  peekRecall(maxAgeMs = 90000) {
    let best = null;
    const cut = now() - maxAgeMs;
    for (const entry of this.recallCache.values()) {
      if (entry.at >= cut && (!best || entry.at > best.at)) best = entry;
    }
    return best;
  }
  clearRecall() {
    this.recallCache.clear();
  }
}

// ---------------------------------------------------------------------------
// Remote 服务：浏览器「记忆」标签页的数据通道
// ---------------------------------------------------------------------------

class HippocampusService extends TypertRemoteService {
  constructor(ctx, factory, registry) {
    super(ctx, "hippocampus");
    this.factory = factory;
    this.registry = registry ?? null;
  }

  dbOf(request) {
    const { scope, scopePath, sessionId } = isPlainObject(request) ? request : {};
    // v3.1：记录活跃会话来源（供每小时自动喂养；v3.2 统一库后仍按目录记录来源，跨目录打通）
    if (this.registry && scopePath) {
      this.registry.touch(scopePath, typeof sessionId === "string" ? sessionId : null);
    }
    return this.factory.getDb(scope || "global", scopePath);
  }

  /** 列出记忆分支 */
  async list(request) {
    const { scope, scopePath, kind, q, includeArchived } = isPlainObject(request) ? request : {};
    return this.dbOf(request).listBranches({ kind, q, includeArchived });
  }

  /** 读取单条记忆 */
  async get(request) {
    const { id } = isPlainObject(request) ? request : {};
    if (typeof id !== "string" || !id) throw new Error("hippocampus.get: 缺少记忆 id");
    return this.dbOf(request).getBranch(id);
  }

  /** 新建一条记忆（v3：自动去重合并 + 突触连接 + 自动标签；v3.3 记录所属工作区目录） */
  async create(request) {
    const { scope, scopePath, ...input } = isPlainObject(request) ? request : {};
    if (typeof input.title !== "string" || !input.title.trim()) throw new Error("hippocampus.create: 标题不能为空");
    const db = this.dbOf(request);
    const out = await db.writeBranch({ ...input, scopePath: scopePath ?? null });
    return { branch: db.sanitize(out.branch), dedup: out.dedup === true, mergedInto: out.mergedInto };
  }

  /** 修改一条记忆 */
  async update(request) {
    const { scope, scopePath, id, patch, by } = isPlainObject(request) ? request : {};
    if (typeof id !== "string" || !id) throw new Error("hippocampus.update: 缺少记忆 id");
    if (!isPlainObject(patch)) throw new Error("hippocampus.update: 缺少 patch");
    const db = this.dbOf(request);
    const branch = await db.updateBranch(id, patch, by);
    return { branch: db.sanitize(branch) };
  }

  /** 遗忘：归档（默认）或彻底删除 */
  async forget(request) {
    const { id, hard } = isPlainObject(request) ? request : {};
    if (typeof id !== "string" || !id) throw new Error("hippocampus.forget: 缺少记忆 id");
    return this.dbOf(request).removeBranch(id, hard === true);
  }

  /** 三阶段检索 */
  async search(request) {
    const { q, limit, scopePath } = isPlainObject(request) ? request : {};
    // v4.1 项目精准度：把请求的当前项目路径显式传入检索，用于项目相关性加权
    return this.dbOf(request).searchBranches(q, limit, scopePath);
  }

  /** 可视化图（打开记忆页即触发一次联想交汇检测 —— 让 ⟡ 新想法随浏览网络自然浮现） */
  async graph(request) {
    const db = this.dbOf(request);
    const g = db.graphData();
    if (process.env.DSH_HIPPOCAMPUS_CROSSLINK !== "0") {
      db.crossLink({ maxCreated: 1, cooldownMs: 60000 }).catch(() => {});
    }
    return g;
  }

  /** 统计面板 */
  async stats(request) {
    return this.dbOf(request).stats();
  }

  /** 演化：合并近重复 + 修剪弱连接 + epoch+1（真实操作） */
  async evolve(request) {
    return this.dbOf(request).evolve();
  }

  /** 修剪：归档弱且久的记忆 */
  async prune(request) {
    return this.dbOf(request).prune();
  }

  /** v4 自循环演练分析（非破坏）：冗余/熵/衰减曲线/健康度 */
  async analyze(request) {
    return this.dbOf(request).analyze();
  }

  /** v4 自循环进化演练（非破坏）：现状 + 模拟演化净效果 */
  async drill(request) {
    return this.dbOf(request).drill();
  }

  /**
   * v4 自循环自动演化：演练门控 —— 未到周期/漂移不足/演练不建议则跳过；
   * 满足条件才真实演化（合并冗余 + 修剪弱连接 + 自适应学习率）。
   */
  async autoEvolve() {
    const db = this.dbOf({ scope: "unified" });
    const lastAuto = Number(db.getMeta("lastAutoEvolveAt", 0)) || 0;
    if (now() - lastAuto < EVOLVE_INTERVAL_MS) {
      return { skipped: true, reason: "未到演化周期" };
    }
    // 漂移门控：距上次演化新增/修改太少则免无谓演化
    const drift = db.db.prepare(
      "SELECT COUNT(*) c FROM branches WHERE created_at > ? OR updated_at > ?"
    ).get(lastAuto, lastAuto).c;
    if (drift < EVOLVE_MIN_DRIFT) {
      db.setMeta("lastAutoEvolveAt", now());
      return { skipped: true, reason: "漂移不足（" + drift + "<" + EVOLVE_MIN_DRIFT + "）" };
    }
    const analysis = await db.drill();
    if (!analysis.simulation?.recommended) {
      db.setMeta("lastAutoEvolveAt", now());
      return {
        skipped: true,
        reason: "演练不建议演化（健康度 " + analysis.health + "，冗余 " + analysis.redundancy.pairs + "，过期 " + analysis.stale + "）",
        health: analysis.health
      };
    }
    const g = await db.evolve();
    db.setMeta("lastAutoEvolveAt", now());
    return { evolved: true, merged: g.merged, prunedLinks: g.prunedLinks, fitnessAfter: g.fitnessAfter, lr: g.lr };
  }

  /** 项目记忆包（上下文刷新用；调用即留痕到注入日志） */
  async context(request) {
    const { topN, maxLen } = isPlainObject(request) ? request : {};
    const db = this.dbOf(request);
    const pack = db.contextPack({ topN, maxLen });
    db.logInjection("refresh", pack.top ?? [], pack.workstate?.id);
    return pack;
  }

  /**
   * v3.1 项目目录解析（权威）：根据会话 id 解析其绑定的工作区文件夹（cwd）。
   * 浏览器端「记忆」页用它精确绑定项目记忆；sessionQuery 优先，
   * 兜底 sessions.binding。
   */
  async resolveProject(request) {
    const { sessionId } = isPlainObject(request) ? request : {};
    if (typeof sessionId !== "string" || !sessionId) {
      return { ok: false, cwd: null, reason: "缺少 sessionId" };
    }
    const sq = this.ctx.get("sessionQuery");
    if (sq) {
      try {
        const snap = await sq.readSession(sessionId);
        const cwd = snap?.session?.cwd ?? null;
        if (typeof cwd === "string" && cwd) return { ok: true, cwd };
      } catch { /* 读失败走兜底 */ }
    }
    try {
      const sessions = this.ctx.get("sessions");
      const cwd = sessions?.binding?.(sessionId)?.session?.header?.cwd ?? null;
      if (typeof cwd === "string" && cwd) return { ok: true, cwd };
    } catch { /* 兜底失败 */ }
    return { ok: false, cwd: null, reason: "无法解析会话工作区" };
  }

  /** 工作状态上报 */
  async reportWork(request) {
    const { scope, scopePath, task, phase, progress, sessionId } = isPlainObject(request) ? request : {};
    return this.dbOf(request).reportWork({ task, phase, progress, sessionId });
  }

  /**
   * v3.1 轨迹喂养（每小时自动调用，也可手动触发）：
   * 读取会话「轨迹」内容（readSurface —— 与「轨迹」标签页同源的模型表面事件：
   * 用户/助手/工具消息，自动排除被压缩替换的旧事件）→ 自动提炼关键句与高频词 →
   * upsert「会话精华」分支 → 过期清理 → 存储上限检查 → 节点上限淘汰。
   * v3.2：统一记忆库 —— 所有工作区目录的会话轨迹都喂养进同一记忆库（跨目录打通）。
   * - 首次（feedAt 为空）或显式传 sinceMs=0：喂养**整个对话历史**
   * - 之后：增量喂养（只取 feedAt 之后的新事件）
   */
  async feed(request) {
    const { scopePath, sessionIds, sessionId: reqSessionId, sinceMs } = isPlainObject(request) ? request : {};
    const db = this.dbOf(request);
    const sq = this.ctx.get("sessionQuery");
    if (!sq) return { ok: false, reason: "sessionQuery 服务不可用", fed: 0 };
    // 显式 sinceMs 优先；否则：已有喂养记录 → 增量（feedAt 之后）；首次 → 全部历史（0）
    const since = typeof sinceMs === "number" ? sinceMs : (db.getMeta("feedAt", 0) || 0);
    // 会话来源：① 请求显式 sessionId（客户端按钮点击）→ ② sessionIds 列表 → ③ 活动注册表
    const ids = typeof reqSessionId === "string" && reqSessionId
      ? [reqSessionId]
      : (Array.isArray(sessionIds) && sessionIds.length > 0
        ? sessionIds
        : (this.registry ? [...new Set(this.registry.recentProjects().flatMap((p) => p.sessionIds))] : []));
    if (ids.length === 0) {
      return { ok: false, fed: 0, wrote: false, reason: "未绑定会话（记忆库还没有会话记录），请先在本会话中与 Agent 对话或调用一次记忆工具，再点击喂养" };
    }
    const events = [];
    for (const sid of ids) {
      if (typeof sid !== "string" || !sid) continue;
      try {
        // readSurface = 「轨迹」标签页同源：当前模型表面的用户/助手/工具消息
        const snap = await sq.readSurface(sid);
        for (const ev of snap?.events ?? []) {
          if (ev && ev.time > since && (ev.type === "user/message" || ev.type === "assistant/message" || ev.type === "tool/result")) {
            events.push(ev);
          }
        }
      } catch { /* 单会话读取失败不影响其他 */ }
    }
    // v5.2：事件上限保护 —— 超长会话只取最近 500 条（避免上万事件拖慢喂养/提炼）
    events.sort((a, b) => a.time - b.time);
    const keep = events.slice(-500);
    const out = db.feedTrajectory(keep, ids[0] ?? null, scopePath ?? null);
    out.fedAll = events.length;
    try { out.purged = db.purgeStale(); } catch { /* 清理失败不阻断 */ }
    try { out.size = await db.checkSize(); } catch { /* 检查失败不阻断 */ }
    return { ok: true, ...out };
  }

  /** v3.1 超限优化：提炼过期记忆 → 删除无效记忆 → VACUUM 压缩（手动触发） */
  async optimize(request) {
    return this.dbOf(request).optimizeForSize();
  }

  /** v3.3 用户主动归档工作区目录：断开其全部连接（含偏好/交流永久连接） */
  async archiveWorkdir(request) {
    const { path } = isPlainObject(request) ? request : {};
    return this.dbOf(request).archiveWorkdir(path);
  }

  /** 标签云：全部标签及使用计数 */
  async tags(request) {
    return this.dbOf(request).tags();
  }

  /** 合并/重命名标签 */
  async tagRename(request) {
    const { from, to } = isPlainObject(request) ? request : {};
    return this.dbOf(request).tagRename(from, to);
  }

  /** 导出记忆（Markdown 文本） */
  async exportAll(request) {
    return { text: this.dbOf(request).exportAll() };
  }

  /** 从 Markdown 导入记忆（带去重合并） */
  async importAll(request) {
    const { text } = isPlainObject(request) ? request : {};
    if (typeof text !== "string" || !text.trim()) throw new Error("hippocampus.importAll: 缺少导入内容");
    return this.dbOf(request).importAll(text);
  }

  /** 待复习记忆列表 */
  async reviewDue(request) {
    const { limit } = isPlainObject(request) ? request : {};
    return this.dbOf(request).reviewDue(limit);
  }

  /** 复习一条记忆（再巩固强化） */
  async review(request) {
    const { id } = isPlainObject(request) ? request : {};
    if (typeof id !== "string" || !id) throw new Error("hippocampus.review: 缺少记忆 id");
    return this.dbOf(request).review(id);
  }

  /** 记忆时间线 */
  async timeline(request) {
    const { limit } = isPlainObject(request) ? request : {};
    return { events: this.dbOf(request).timeline(limit) };
  }

  /** 某记忆的全部突触连接（手动连线面板展示已有连接） */
  async linksOf(request) {
    const { id } = isPlainObject(request) ? request : {};
    if (typeof id !== "string" || !id) throw new Error("hippocampus.linksOf: 缺少记忆 id");
    const links = this.dbOf(request).linksOf(id);
    const db = this.dbOf(request);
    const withTitle = links.map((l) => {
      const b = db.getByUid(l.other);
      return { other: l.other, weight: l.weight, title: b ? b.title : l.other, kind: b ? b.kind : null };
    });
    return { links: withTitle };
  }

  /** 手动连接突触（两个记忆之间显式建立连接） */
  async linkManual(request) {
    const { a, b, weight } = isPlainObject(request) ? request : {};
    if (typeof a !== "string" || !a || typeof b !== "string" || !b) {
      throw new Error("hippocampus.linkManual: 需要两个记忆 id");
    }
    return this.dbOf(request).linkManual(a, b, weight);
  }

  /** 手动断开突触（删除两个记忆间的连接） */
  async unlinkManual(request) {
    const { a, b } = isPlainObject(request) ? request : {};
    if (typeof a !== "string" || !a || typeof b !== "string" || !b) {
      throw new Error("hippocampus.unlinkManual: 需要两个记忆 id");
    }
    return this.dbOf(request).unlinkManual(a, b);
  }

  /** 演化日志（合并/修剪/代际留痕） */
  async evolog(request) {
    const { limit } = isPlainObject(request) ? request : {};
    return { events: this.dbOf(request).evologList(limit) };
  }

  /** 注入日志（对话前自动/工具/界面刷新的留痕） */
  async injectLog(request) {
    const { limit } = isPlainObject(request) ? request : {};
    return { events: this.dbOf(request).injectLog(limit) };
  }
}

// ---------------------------------------------------------------------------
// Remote 标记
// ---------------------------------------------------------------------------

function applyRemoteDecorators(serviceClass, mapping) {
  for (const [method, exportName] of Object.entries(mapping)) {
    const decorator = Remote(exportName);
    const descriptor = Object.getOwnPropertyDescriptor(serviceClass.prototype, method);
    if (!descriptor || typeof descriptor.value !== "function") {
      throw new Error("hippocampus: Remote 方法不存在: " + method);
    }
    const initializers = [];
    const context = {
      kind: "method",
      name: method,
      static: false,
      private: false,
      addInitializer(fn) {
        initializers.push(fn);
      }
    };
    decorator(descriptor.value, context);
    const probe = Object.create(serviceClass.prototype);
    for (const fn of initializers) fn.call(probe);
  }
}

applyRemoteDecorators(HippocampusService, {
  list: "list",
  get: "get",
  create: "create",
  update: "update",
  forget: "forget",
  search: "search",
  graph: "graph",
  stats: "stats",
  evolve: "evolve",
  prune: "prune",
  analyze: "analyze",
  drill: "drill",
  context: "context",
  reportWork: "reportWork",
  feed: "feed",
  optimize: "optimize",
  resolveProject: "resolveProject",
  archiveWorkdir: "archiveWorkdir",
  tags: "tags",
  tagRename: "tagRename",
  exportAll: "exportAll",
  importAll: "importAll",
  reviewDue: "reviewDue",
  review: "review",
  timeline: "timeline",
  linksOf: "linksOf",
  linkManual: "linkManual",
  unlinkManual: "unlinkManual",
  evolog: "evolog",
  injectLog: "injectLog"
});

// ---------------------------------------------------------------------------
// Agent 工具定义
// ---------------------------------------------------------------------------

function branchSummary(branch) {
  return "【" + branch.id + "】" + branch.title + "（" + (KIND_LABELS[branch.kind] ?? branch.kind) + "，强度 " + branch.strength.toFixed(2) + "，状态 " + (branch.status === "active" ? "活跃" : "已归档") + "）";
}

/** 工具侧解析统一记忆库（v3.2：所有工作区目录打通；同时登记活跃会话供轨迹喂养） */
function dbForScope(service, scope, agent) {
  const projectPath = agent?.session?.header?.cwd ?? null;
  const sessionId = agent?.session?.id ?? null;
  if (service.registry && projectPath) {
    service.registry.touch(projectPath, sessionId);
  }
  return { db: service.dbOf({ scope: "unified", scopePath: projectPath }), scope: "unified", scopePath: projectPath, sessionId };
}

async function viaService(service, method, request, agent) {
  if (method === "list") return service.list(request);
  if (method === "get") return service.get(request);
  if (method === "create") return service.create(request);
  if (method === "update") return service.update(request);
  if (method === "forget") return service.forget(request);
  if (method === "search") return service.search(request);
  if (method === "stats") return service.stats(request);
  if (method === "context") return service.context(request);
  if (method === "evolve") return service.evolve(request);
  if (method === "analyze") return service.analyze(request);
  if (method === "drill") return service.drill(request);
  if (method === "reportWork") {
    const sessionId = agent?.session?.id ?? null;
    return service.reportWork({ ...request, sessionId });
  }
  throw new Error("unknown method " + method);
}

function scopeParam() {
  return { type: "string", enum: ["global", "project"], default: "project", description: "记忆作用域：v3.2 起已统一为同一记忆库（所有信息内容在同一记录中，跨工作区目录打通），scope 参数保留仅为向后兼容，global/project 均读写同一记忆库；不再按目录隔离" };
}

/**
 * 分支输出 schema —— v3 修复：v2 只声明了部分字段且 additionalProperties:false，
 * 而实际返回的分支带有多余字段（tags/status/source/时间戳/history 等），
 * 导致全部 memory_* 工具输出校验失败。这里声明完整非空字段，
 * 允许未声明的可空字段（parentId/sessionId/rowId）透传。
 */
const BRANCH_OUT = {
  type: "object",
  additionalProperties: true,
  properties: {
    id: { type: "string", required: true },
    title: { type: "string", required: true },
    content: { type: "string", required: true },
    kind: { type: "string", required: true },
    tags: { type: "array", required: true, items: { type: "string" } },
    strength: { type: "number", required: true },
    status: { type: "string", required: true },
    source: { type: "string", required: true },
    createdAt: { type: "number", required: true },
    updatedAt: { type: "number", required: true },
    lastAccessAt: { type: "number", required: true },
    history: {
      type: "array",
      required: true,
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          at: { type: "number", required: true },
          by: { type: "string", required: true },
          summary: { type: "string", required: true }
        }
      }
    }
  }
};

function defineMemoryTools(service) {
  const tools = [];

  tools.push(defineTool({
    name: "memory_write",
    description: "写入或更新一条记忆到海马体记忆库（Agent 的长期记忆，语义向量检索）。v3.2 起为统一记忆库：所有信息内容记忆在同一记录中，跨工作区目录打通 —— 无论当前在哪个目录工作，都读写同一份记忆（偏好/性格/需求/工作状态/项目细节/洞察全部在一起），实现不同工作区目录间的记忆共享。传入 id 则更新已有分支，否则新建分支。写入时会自动检测高相似记忆（≥0.9 同种类）并合并强化原记忆而非重复入库，自动生成高频词标签，并与最相似记忆建立突触连接；活跃节点超过 1000 时自动淘汰最弱。写入后我可以在工作期间随时用 memory_read / memory_search / memory_context 回忆。",
    parameters: {
      title: { type: "string", required: true, description: "记忆标题，一句话概括这条记忆" },
      content: { type: "string", required: true, description: "记忆正文：具体、可回放的事实描述" },
      kind: { type: "string", required: true, enum: [...KINDS], description: "记忆种类：preference=用户偏好, communication=交流方式, workstate=工作状态, insight=洞察, other=其他" },
      tags: { type: "array", description: "标签数组，便于检索与聚类；留空则自动生成高频词标签", items: { type: "string" } },
      id: { type: "string", description: "已有记忆分支的 id；传入则更新该分支而非新建" },
      strength: { type: "number", description: "记忆强度 0..1（默认 0.6），越高越不容易被遗忘" },
      scope: scopeParam()
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          ok: { type: "boolean", required: true },
          branch: BRANCH_OUT,
          dedup: { type: "boolean" },
          mergedInto: { type: "string" },
          message: { type: "string" }
        }
      },
      render: (_args, value) => [{
        type: "text",
        text: value.message ?? (value.dedup
          ? "检测到相似记忆，已合并强化原记忆: " + branchSummary(value.branch)
          : "记忆已写入: " + branchSummary(value.branch))
      }]
    },
    execute: async (args, exec) => {
      const agent = exec.agent ?? null;
      const sessionId = agent?.session?.id ?? null;
      const { scope, scopePath } = (() => {
        const r = dbForScope(service, args.scope, agent);
        return { scope: r.scope, scopePath: r.scopePath };
      })();
      // v3.2：统一记忆库 —— 不再限制全局/项目用途，所有信息内容记忆在同一记录中
      if (args.id) {
        const { branch } = await viaService(service, "update", { id: args.id, patch: { title: args.title, content: args.content, kind: args.kind, tags: args.tags ?? [], strength: args.strength }, by: "agent", scope, scopePath, sessionId }, agent);
        return { ok: true, branch, message: "记忆已更新: " + branchSummary(branch) };
      }
      const created = await viaService(service, "create", { title: args.title, content: args.content, kind: args.kind, tags: args.tags ?? [], strength: args.strength, source: "agent", scope, scopePath, sessionId }, agent);
      const { branch, dedup, mergedInto } = created;
      const relatedList = Array.isArray(created.related) ? created.related : [];
      if (args.kind === "workstate" && !dedup) await viaService(service, "reportWork", { task: args.title, phase: "写入", progress: null, scope, scopePath }, agent).catch(() => {});
      // v5.4：mergedInto 仅去重命中时输出（null 会被工具输出 schema 判为非 string）
      const relatedNote = relatedList.length
        ? "\n相关记忆 " + relatedList.length + " 条（语义关联，未合并）: " + relatedList.map((r) => r.title + "(" + r.score + ")").join("、")
        : "";
      const out = {
        ok: true,
        branch,
        dedup,
        message: dedup
          ? "检测到相似记忆（已合并强化原记忆，未重复入库）: " + branchSummary(branch)
          : "记忆已写入: " + branchSummary(branch) + relatedNote
      };
      if (dedup && mergedInto) out.mergedInto = mergedInto;
      return out;
    }
  }));

  tools.push(defineTool({
    name: "memory_read",
    description: "从海马体记忆库读取记忆（Agent 的长期记忆回忆，词法+语义+联想三阶段检索）。支持按 id 精确读取、按种类读取、或按关键词检索；读取会轻微加强记忆强度（再巩固）。工作时回忆用户偏好、交流方式、之前任务的工作状态时使用；长会话中建议配合 memory_context 刷新项目记忆包。",
    parameters: {
      id: { type: "string", description: "精确读取某条记忆分支的 id" },
      kind: { type: "string", enum: [...KINDS], description: "只读取某一种类的记忆" },
      q: { type: "string", description: "关键词，模糊匹配标题/正文/标签" },
      limit: { type: "integer", description: "最多返回条数（默认 8）" },
      scope: scopeParam()
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          branches: { type: "array", required: true, items: BRANCH_OUT }
        }
      },
      render: (_args, value) => [{
        type: "text",
        text: value.branches.length === 0
          ? "（海马体中没有匹配的记忆）"
          : value.branches.map((b) => "• " + b.title + " [" + (KIND_LABELS[b.kind] ?? b.kind) + "]\n  " + b.content).join("\n")
      }]
    },
    execute: async (args, exec) => {
      const agent = exec.agent ?? null;
      const { scope, scopePath } = (() => {
        const r = dbForScope(service, args.scope, agent);
        return { scope: r.scope, scopePath: r.scopePath };
      })();
      if (args.id) {
        const { branch } = await viaService(service, "get", { id: args.id, scope, scopePath }, agent);
        return { branches: [branch] };
      }
      const { branches } = await viaService(service, "list", { kind: args.kind, q: args.q ?? "", scope, scopePath }, agent);
      return { branches: branches.slice(0, args.limit ?? 8) };
    }
  }));

  tools.push(defineTool({
    name: "memory_search",
    description: "在海马体记忆库中做语义向量 + 词法 + 联想（含持久化突触连接）三阶段检索，返回按相关度排序的记忆分支（含相关度分数）。比 memory_read 更偏「检索」，适合精确回忆某条旧记忆或按语义找相关记忆时使用；命中会触发再巩固与连接强化；超过 30 天的过期记忆自动降权，匹配更聚焦当前项目与进度状态。",
    parameters: {
      q: { type: "string", required: true, description: "查询关键词或一句话" },
      limit: { type: "integer", description: "最多返回条数（默认 8，最多 50）" },
      scope: scopeParam()
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          results: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: true,
              properties: {
                branch: BRANCH_OUT,
                score: { type: "number", required: true }
              }
            }
          }
        }
      },
      render: (_args, value) => [{
        type: "text",
        text: value.results.length === 0
          ? "（没有匹配的记忆）"
          : value.results.map((r) => "• [" + r.score + "] " + r.branch.title + " [" + (KIND_LABELS[r.branch.kind] ?? r.branch.kind) + "]\n  " + r.branch.content).join("\n")
      }]
    },
    execute: async (args, exec) => {
      const agent = exec.agent ?? null;
      const { scope, scopePath } = (() => {
        const r = dbForScope(service, args.scope, agent);
        return { scope: r.scope, scopePath: r.scopePath };
      })();
      const { results } = await viaService(service, "search", { q: args.q, limit: args.limit, scope, scopePath }, agent);
      return { results };
    }
  }));

  tools.push(defineTool({
    name: "memory_edit",
    description: "修正/覆盖一条已有记忆（海马体校正）。当发现记忆内容有误、过时或需要人工校正语义时使用；也可以归档（status=archived）或调整强度。修正会写入历史记录，并重新计算语义向量。",
    parameters: {
      id: { type: "string", required: true, description: "要修正的记忆分支 id" },
      title: { type: "string", description: "新标题" },
      content: { type: "string", description: "新正文" },
      kind: { type: "string", enum: [...KINDS], description: "新种类" },
      tags: { type: "array", description: "新标签", items: { type: "string" } },
      status: { type: "string", enum: ["active", "archived"], description: "active=活跃, archived=归档" },
      strength: { type: "number", description: "新强度 0..1" },
      scope: scopeParam()
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          branch: BRANCH_OUT,
          message: { type: "string" }
        }
      },
      render: (_args, value) => [{
        type: "text",
        text: value.message ?? "记忆已修正: " + branchSummary(value.branch)
      }]
    },
    execute: async (args, exec) => {
      const agent = exec.agent ?? null;
      const { scope, scopePath } = (() => {
        const r = dbForScope(service, args.scope, agent);
        return { scope: r.scope, scopePath: r.scopePath };
      })();
      const patch = {};
      if (args.title !== void 0) patch.title = args.title;
      if (args.content !== void 0) patch.content = args.content;
      if (args.kind !== void 0) patch.kind = args.kind;
      if (args.tags !== void 0) patch.tags = args.tags;
      if (args.status !== void 0) patch.status = args.status;
      if (args.strength !== void 0) patch.strength = args.strength;
      const { branch } = await viaService(service, "update", { id: args.id, patch, by: "agent", scope, scopePath }, agent);
      return { branch, message: "记忆已修正: " + branchSummary(branch) };
    }
  }));

  tools.push(defineTool({
    name: "memory_forget",
    description: "遗忘一条记忆（海马体遗忘机制）。默认归档（保留历史、不再出现在活跃记忆与可视化中），hard=true 则彻底删除（含向量与突触连接）。当用户明确表示某条记忆不再需要、或记忆已确认作废时使用。",
    parameters: {
      id: { type: "string", required: true, description: "要遗忘的记忆分支 id" },
      hard: { type: "boolean", description: "true=彻底删除；默认 false=归档" },
      scope: scopeParam()
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          removed: { type: "boolean", required: true },
          hard: { type: "boolean", required: true },
          message: { type: "string" }
        }
      },
      render: (_args, value) => [{
        type: "text",
        text: value.message ?? (value.hard ? "记忆已彻底删除" : "记忆已归档")
      }]
    },
    execute: async (args, exec) => {
      const agent = exec.agent ?? null;
      const { scope, scopePath } = (() => {
        const r = dbForScope(service, args.scope, agent);
        return { scope: r.scope, scopePath: r.scopePath };
      })();
      const out = await viaService(service, "forget", { id: args.id, hard: args.hard === true, scope, scopePath }, agent);
      return { ...out, message: out.hard ? "记忆已彻底删除" : "记忆已归档（可在记忆页查看归档）" };
    }
  }));

  tools.push(defineTool({
    name: "memory_stats",
    description: "查看海马体记忆库的统计信息（记忆健康度）：各种类数量、平均强度、突触连接数、演化代际/epoch、已修剪数量、最近活动时间、库文件大小、最近轨迹喂养时间、过期清理数量等。用于评估记忆库状态、判断是否需要演化合并或修剪。",
    parameters: {
      scope: scopeParam()
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          counts: { type: "object", additionalProperties: true, required: true },
          meta: { type: "object", additionalProperties: true, required: true },
          scope: { type: "string", required: true },
          scopePath: { type: "string" },
          message: { type: "string" }
        }
      },
      render: (_args, value) => [{
        type: "text",
        text: value.message ?? "记忆库统计"
      }]
    },
    execute: async (args, exec) => {
      const agent = exec.agent ?? null;
      const { scope, scopePath } = (() => {
        const r = dbForScope(service, args.scope, agent);
        return { scope: r.scope, scopePath: r.scopePath };
      })();
      const { counts, meta } = await viaService(service, "stats", { scope, scopePath }, agent);
      const kindsLine = Object.entries(counts.kinds ?? {})
        .map(([k, v]) => (KIND_LABELS[k] ?? k) + "=" + v)
        .join(" · ");
      const sizeMb = ((meta.sizeBytes ?? 0) / (1024 * 1024)).toFixed(2);
      const message = [
        "【海马体统一记忆库统计】" + (scopePath ? " 当前目录: " + scopePath : "") + "（跨工作区目录打通）",
        "总数 " + counts.total + " · 活跃 " + counts.active + "（上限 " + MAX_NODES + "，超出自动淘汰最弱） · 归档 " + counts.archived,
        kindsLine,
        "突触连接 " + (meta.connections ?? 0) + " · 平均强度 " + (meta.fitness ?? 0).toFixed(3),
        "epoch " + (meta.epoch ?? 1) + " · generation " + (meta.generation ?? 0) + " · 已修剪 " + (meta.pruned ?? 0) + " · 已清理过期 " + (meta.staleCleaned ?? 0) + " · 上限淘汰 " + (meta.cappedRemoved ?? 0),
        "库大小 " + sizeMb + "MB（上限 1GB，超限自动优化）",
        meta.feedAt ? "最近轨迹喂养 " + new Date(meta.feedAt).toLocaleString("zh-CN") : "",
        meta.lastActivityAt ? "最近活动 " + new Date(meta.lastActivityAt).toLocaleString("zh-CN") : ""
      ].filter(Boolean).join("\n");
      return { counts, meta, scope: "unified", scopePath, message };
    }
  }));

  tools.push(defineTool({
    name: "memory_context",
    description: "获取当前作用域（默认当前项目）的「记忆包」浓缩版：按 强度×0.6+新鲜度×0.4 排序的关键记忆 + 最新工作状态 + 记忆库统计。用于长会话中刷新上下文锚点、避免把冗长历史反复堆进上下文造成的上下文污染；任务开始/中期/切换话题时调用，快速恢复项目记忆。",
    parameters: {
      scope: scopeParam(),
      topN: { type: "integer", description: "返回条数（默认 12，最多 30）" },
      maxLen: { type: "integer", description: "每条记忆正文截断长度（默认 200 字符）" }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          scope: { type: "string", required: true },
          projectPath: { type: "string" },
          text: { type: "string", required: true },
          top: { type: "array", required: true, items: BRANCH_OUT },
          workstate: BRANCH_OUT,
          stats: { type: "object", additionalProperties: true, required: true }
        }
      },
      render: (_args, value) => [{
        type: "text",
        text: value.text
      }]
    },
    execute: async (args, exec) => {
      const agent = exec.agent ?? null;
      const { scope, scopePath } = (() => {
        const r = dbForScope(service, args.scope, agent);
        return { scope: r.scope, scopePath: r.scopePath };
      })();
      const pack = await viaService(service, "context", { topN: args.topN, maxLen: args.maxLen, scope, scopePath }, agent);
      return pack;
    }
  }));

  tools.push(defineTool({
    name: "memory_evolve",
    description: "手动触发海马体记忆库演化：合并近重复记忆（相似度≥0.9，弱者归档并入强者）、修剪弱连接（<0.12）、应用遗忘曲线、计算适应度并推进代际。用于记忆库积累大量重复/噪声后整理，防止记忆库自身污染。",
    parameters: {
      scope: scopeParam()
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          merged: { type: "number", required: true },
          prunedLinks: { type: "number", required: true },
          epoch: { type: "number", required: true },
          generation: { type: "number", required: true },
          fitness: { type: "number", required: true },
          message: { type: "string" }
        }
      },
      render: (_args, value) => [{
        type: "text",
        text: value.message ?? "演化完成"
      }]
    },
    execute: async (args, exec) => {
      const agent = exec.agent ?? null;
      const { scope, scopePath } = (() => {
        const r = dbForScope(service, args.scope, agent);
        return { scope: r.scope, scopePath: r.scopePath };
      })();
      const g = await viaService(service, "evolve", { scope, scopePath }, agent);
      return {
        merged: g.merged ?? 0,
        prunedLinks: g.prunedLinks ?? 0,
        epoch: g.meta?.epoch ?? 1,
        generation: g.meta?.generation ?? 0,
        fitness: g.meta?.fitness ?? 0,
        message: "演化完成：合并 " + (g.merged ?? 0) + " 条近重复记忆，修剪 " + (g.prunedLinks ?? 0) + " 条弱连接；epoch " + (g.meta?.epoch ?? 1) + " · generation " + (g.meta?.generation ?? 0) + " · 适应度 " + (g.meta?.fitness ?? 0).toFixed(3)
      };
    }
  }));

  // v4 自循环演练分析（非破坏）
  tools.push(defineTool({
    name: "memory_analyze",
    description: "对海马体记忆库执行一次非破坏的「自循环演练分析」：诊断冗余（可合并的近重复对及其示例）、种类信息熵、强度衰减曲线（弱/中/强分布）、过期记忆数、突触连接健康（弱连接/孤儿向量）、网络密度与综合健康度，并给出是否建议演化的判定。只读分析，不修改任何记忆。用于洞察记忆库健康度、判断何时需要演化/清理。",
    parameters: {
      scope: scopeParam(),
      drill: { type: "boolean", description: "true 时额外做一次「进化演练」：模拟合并冗余、修剪弱连接后的净效果与演化建议（默认 true）" }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          nodes: { type: "number", required: true },
          links: { type: "number", required: true },
          entropy: { type: "number", required: true },
          redundancy: { type: "object", additionalProperties: true, required: true },
          decayCurve: { type: "object", additionalProperties: true, required: true },
          stale: { type: "number", required: true },
          health: { type: "number", required: true },
          simulation: { type: "object", additionalProperties: true },
          message: { type: "string", required: true }
        }
      },
      render: (_args, value) => [{
        type: "text",
        text: value.message
      }]
    },
    execute: async (args, exec) => {
      const agent = exec.agent ?? null;
      const { scope, scopePath } = (() => {
        const r = dbForScope(service, args.scope, agent);
        return { scope: r.scope, scopePath: r.scopePath };
      })();
      const drill = args.drill !== false;
      const analysis = drill
        ? await viaService(service, "drill", { scope, scopePath }, agent)
        : await viaService(service, "analyze", { scope, scopePath }, agent);
      const r = analysis.redundancy ?? {};
      const d = analysis.decayCurve ?? {};
      const sim = analysis.simulation ?? null;
      const lines = [
        "【海马体自循环演练分析】健康度 " + (analysis.health ?? 1) + "（建议演化：" + (sim ? (sim.recommended ? "是" : "否") : "—") + "）",
        "节点 " + analysis.nodes + " · 突触 " + analysis.links + " · 弱连接 " + (analysis.weakLinks ?? 0) + " · 孤儿向量 " + (analysis.orphans ?? 0) + " · 网络密度 " + (analysis.density ?? 0),
        "冗余重复对 " + (r.pairs ?? 0) + " 个" + ((r.examples ?? []).length ? "，例如：" + (r.examples ?? []).map((e) => e.a + "↔" + e.b + "(" + e.s + ")").join("、") : ""),
        "种类信息熵 " + analysis.entropy + " · 强度分布 弱 " + (d.weak ?? 0) + " / 中 " + (d.mid ?? 0) + " / 强 " + (d.strong ?? 0) + " · 过期 " + analysis.stale,
        "meta: epoch " + (analysis.meta?.epoch ?? 1) + " · generation " + (analysis.meta?.generation ?? 0) + " · fitness " + (analysis.meta?.fitness ?? 0) + " · lr " + (analysis.meta?.learningRate ?? 0.01)
      ];
      if (sim) lines.push("进化演练模拟：合并冗余可降节点 " + analysis.nodes + "→" + sim.predictedNodesAfterMerge + "，修剪弱连接 " + sim.pruneCandidates + " 条");
      return { ...analysis, message: lines.join("\n") };
    }
  }));

  // v5：记忆导入导出（Markdown）
  tools.push(defineTool({
    name: "memory_export",
    description: "导出海马体记忆库全部活跃记忆为 Markdown 文本（标题 + 种类/标签/强度元数据 + 正文）。用于备份、迁移到其它设备/项目、或交给用户存档。只读操作，不修改记忆。",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          text: { type: "string", required: true },
          message: { type: "string", required: true }
        }
      },
      render: (_args, value) => [{
        type: "text",
        text: value.message + "\n\n" + value.text
      }]
    },
    execute: async (args, exec) => {
      const agent = exec.agent ?? null;
      const { scope, scopePath } = (() => {
        const r = dbForScope(service, args.scope, agent);
        return { scope: r.scope, scopePath: r.scopePath };
      })();
      const { text } = await viaService(service, "exportAll", { scope, scopePath }, agent);
      const count = (text.match(/^##\s/gm) ?? []).length;
      return { text, message: "已导出 " + count + " 条记忆（Markdown）" };
    }
  }));

  tools.push(defineTool({
    name: "memory_import",
    description: "从 Markdown 文本导入记忆到海马体记忆库。接受 memory_export 的导出格式（## 标题 + _种类/标签/强度_ + 正文），或任何遵循该结构的记忆列表。导入会按相似度自动去重合并（≥0.9 同种类合并强化原记忆）。用于从备份/其它设备恢复记忆。",
    parameters: {
      text: { type: "string", required: true, description: "Markdown 格式的记忆内容（memory_export 的输出格式）" },
      scope: scopeParam()
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          imported: { type: "number", required: true },
          dedup: { type: "number", required: true },
          total: { type: "number", required: true },
          message: { type: "string", required: true }
        }
      },
      render: (_args, value) => [{
        type: "text",
        text: value.message
      }]
    },
    execute: async (args, exec) => {
      const agent = exec.agent ?? null;
      const { scope, scopePath } = (() => {
        const r = dbForScope(service, args.scope, agent);
        return { scope: r.scope, scopePath: r.scopePath };
      })();
      const out = await viaService(service, "importAll", { text: args.text, scope, scopePath }, agent);
      return { ...out, message: "导入完成：新增 " + out.imported + " 条，去重合并 " + out.dedup + " 条（共 " + out.total + " 条）" };
    }
  }));

  // v5：复习调度（间隔重复）
  tools.push(defineTool({
    name: "memory_review",
    description: "复习海马体记忆库中的记忆（间隔重复调度）。不传 id 时列出所有到期待复习的记忆（按到期先后），传 id 时对指定记忆执行复习强化（提升强度、刷新复习期）。长期记忆需要定期复习才能对抗遗忘曲线；适合在会话开始时或用户要求时执行。",
    parameters: {
      id: { type: "string", description: "要复习的记忆 id；留空则仅列出到期待复习列表" },
      review: { type: "boolean", description: "true 时对 id 指定的记忆执行复习强化（默认 false 仅列出）" },
      scope: scopeParam()
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          due: { type: "number", required: true },
          branches: { type: "array", items: BRANCH_OUT },
          reviewed: { type: "object", additionalProperties: true },
          message: { type: "string", required: true }
        }
      },
      render: (_args, value) => [{
        type: "text",
        text: value.message
      }]
    },
    execute: async (args, exec) => {
      const agent = exec.agent ?? null;
      const { scope, scopePath } = (() => {
        const r = dbForScope(service, args.scope, agent);
        return { scope: r.scope, scopePath: r.scopePath };
      })();
      if (args.id && args.review === true) {
        const reviewed = await viaService(service, "review", { id: args.id, scope, scopePath }, agent);
        return { due: 0, reviewed, message: "已复习并强化: " + branchSummary(reviewed) + "（强度 " + reviewed.strength.toFixed(2) + "）" };
      }
      const { due, branches } = await viaService(service, "reviewDue", { scope, scopePath }, agent);
      const lines = ["到期待复习记忆 " + due + " 条" + (due === 0 ? "（暂无到期记忆，记忆状态良好）" : "：")];
      for (const b of branches.slice(0, 20)) {
        lines.push("• " + b.id + " | " + b.title + "（强度 " + b.strength.toFixed(2) + "）");
      }
      return { due, branches, message: lines.join("\n") + (due > 0 ? "\n对指定 id 传 review=true 可执行复习强化。" : "") };
    }
  }));

  return tools;
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// v3.4：对话前记忆接入 —— 每次组装系统提示（每轮对话前）自动注入记忆包
// ---------------------------------------------------------------------------

/**
 * 构建对话前注入的记忆包文本（同步、轻量，30s 缓存）：
 * v5.4 上下文感知注入 = ① 本条消息预检索结果（agent/inbox/inserted 异步检索缓存，
 *   真正「先梳理检索再输出」—— 检索在模型输出消耗 token 之前完成）
 *                    + ② 激活锚点（工作记忆延续）
 *                    + ③ 核心记忆（强度×0.6+新鲜度×0.4，质量过滤）
 *                    + ④ 最近 1h 新增记忆
 * 通过 ctx.systemPrompt.section 注册为动态 section，每轮 turn 前自动求值。
 */
function registerPromptMemory(ctx, service, factory) {
  const sp = ctx.get("systemPrompt");
  if (!sp) return false;
  const promptCache = { at: 0, text: "" };
  const build = () => {
    const nowMs = now();
    if (nowMs - promptCache.at < 30000 && promptCache.text) return promptCache.text;
    let text = "";
    try {
      const udb = factory.getDb("unified");
      // ① 本条消息预检索结果（90s 内新鲜）
      const recall = factory.peekRecall(90000);
      // ② 激活锚点（当前工作记忆）
      const anchorList = factory.anchors ? factory.anchors.list(10) : [];
      const anchorBranches = anchorList.map((a) => udb.getByUid(a.id)).filter(Boolean);
      // ③ 核心记忆包（内部会激活 top8 锚点，维持连续性）
      const pack = udb.contextPack({ topN: 6, maxLen: 130, minQuality: 0.5 });
      // ④ 最近 1h 新增
      let recentRows = [];
      try {
        recentRows = udb.db.prepare(
          "SELECT * FROM branches WHERE status='active' AND created_at > ? ORDER BY created_at DESC LIMIT 4"
        ).all(nowMs - 3600000).map((r) => udb.rowToBranch(r));
      } catch { /* 查询失败忽略 */ }
      // 融合去重：预检索 → 锚点 → 核心 → 最近新增，最多 14 条
      const seen = new Set();
      const pick = [];
      const recallPick = [];
      for (const r of recall?.results ?? []) {
        if (!seen.has(r.id)) { seen.add(r.id); recallPick.push({ b: r, isRecall: true }); }
      }
      for (const rb of recallPick) pick.push(rb);
      for (const ab of anchorBranches) {
        if (!seen.has(ab.id)) { seen.add(ab.id); pick.push({ b: ab, tag: "⚓" }); }
      }
      for (const t of pack.top) {
        if (!seen.has(t.id)) { seen.add(t.id); pick.push({ b: t, tag: null }); }
      }
      for (const rb of recentRows) {
        if (!seen.has(rb.id)) { seen.add(rb.id); pick.push({ b: rb, tag: "✦" }); }
      }
      const items = pick.slice(0, 14);
      // v5.8：注入框架文本使用英文（token 更省）；记忆标题/内容为用户数据保持原文
      const lines = ["# Hippocampus Memory (auto-injected)",
        "Key long-term memories — prioritize these while working:"];
      if (recall && recall.results.length) {
        lines.push("▍Memories relevant to your current message (pre-retrieved):");
        for (const r of recall.results.slice(0, 6)) {
          lines.push("• [" + (r.kind ?? "other") + "|" + r.score + "] " + r.title + "：" + String(r.content).slice(0, 130));
        }
        lines.push("");
      }
      if (pack.workstate) lines.push("▶ Current work state:\n" + String(pack.workstate.content).slice(0, 260));
      for (const { b, tag, isRecall } of items) {
        if (pack.workstate && b.id === pack.workstate.id) continue;
        if (isRecall) continue; // 预检索结果已单独列出，避免重复
        lines.push("• [" + (tag ? tag + " " : "") + (b.kind ?? "other") + "|" + b.strength.toFixed(2) + "] " + b.title + "：" + String(b.content).slice(0, 130));
      }
      lines.push("Memory tools: memory_write/read/search/edit/forget/stats/context/evolve/analyze/export/import/review. ⚓=active in working memory, ✦=recently added. Trajectory auto-fed hourly.");
      text = lines.join("\n");
      udb.logInjection("auto", items.map((x) => x.b).concat(recallPick.map((x) => x.b)), pack.workstate?.id);
    } catch { text = ""; }
    promptCache.at = nowMs;
    promptCache.text = text;
    return text;
  };
  try {
    sp.section({
      name: "hippocampus:memory",
      order: 150,
      text: () => build()
    });
    return true;
  } catch { return false; }
}

export function apply(ctx) {
  const factory = new HippocampusDbFactory();
  const registry = new ActivityRegistry(path.join(dshHome(), "storages", "hippocampus", "registry.json"));
  const service = new HippocampusService(ctx, factory, registry);
  for (const tool of defineMemoryTools(service)) {
    ctx.tools.register(tool);
  }

  // v3.4：对话前记忆接入（systemPrompt 可用时注册；可用 DSH_HIPPOCAMPUS_PROMPT=0 关闭）
  if (process.env.DSH_HIPPOCAMPUS_PROMPT !== "0") {
    try {
      registerPromptMemory(ctx, service, factory);
    } catch { /* 注入失败不影响插件 */ }
  }

  // v5.4 主动记忆梳理（人脑式「先检索再输出」）：
  // 用户消息进入收件箱 → 立即异步检索相关记忆（语义+词法+联想+锚点加权）→
  // 缓存结果；随后系统提示组装（模型请求前）时由 registerPromptMemory 读取注入。
  // 检索发生在模型输出消耗 token 之前，且不阻塞消息处理（fire-and-forget + 超时兜底）。
  if (process.env.DSH_HIPPOCAMPUS_PROMPT !== "0") {
    try {
      ctx.on("agent/inbox/inserted", (payload) => {
        const agent = payload?.agent;
        const message = payload?.message;
        const text = messageTextOf(message);
        if (!text || text.trim().length < 2) return;
        const agentId = agent?.session?.id ?? null;
        const cwd = agent?.session?.header?.cwd ?? null;
        // 同一文本 30s 内不重复检索（防抖）
        const prev = factory.recallCache.get(agentId);
        if (prev && prev.q === text && now() - prev.at < 30000) return;
        void (async () => {
          try {
            const db = factory.getDb("unified");
            const q = text.trim().slice(0, 200);
            const out = await db.searchBranches(q, 8, cwd);
            factory.setRecall(agentId, {
              q,
              results: out.results.map((r) => ({
                id: r.branch.id,
                title: r.branch.title,
                kind: r.branch.kind,
                content: String(r.branch.content ?? "").slice(0, 160),
                score: r.score
              })),
              anchors: out.anchors ?? [],
              at: now()
            });
          } catch { /* 预检索失败不影响消息处理 */ }
        })();
      }, "hippocampus: recall");
    } catch { /* 监听失败不影响插件 */ }
  }

  // v3.3：打开 DSH 即预加载记忆 —— 立即初始化统一库并预热图数据缓存
  //（旧项目库合并/补向量在后台进行），记忆页打开时无需等待
  try {
    const udb = factory.getDb("unified");
    udb.graphData();
    udb.embedAll().catch(() => {});
  } catch { /* 预热失败不影响插件挂载 */ }

  // v3.1：每小时自动「轨迹喂养」—— 读取活跃会话的最近轨迹事件（v3.2 统一库：
  // 所有工作区目录的会话都喂进同一记忆库），随后过期清理 + 存储上限检查 +
  // 节点上限淘汰（超 1000 自动淘汰最弱）
  // v5.2：定时器句柄保存，dispose 时清理 —— 防止插件重载/更新后旧定时器残留双跑
  const feedTimer = setInterval(() => {
    void (async () => {
      try {
        const allIds = [...new Set(registry.recentProjects().flatMap((p) => p.sessionIds))];
        if (allIds.length > 0) {
          await service.feed({ scope: "unified", sessionIds: allIds });
        }
      } catch { /* 喂养失败不影响清理 */ }
      try {
        const udb = factory.getDb("unified");
        udb.purgeStale();
        await udb.checkSize();
        udb.enforceNodeCap();
      } catch { /* 清理失败忽略 */ }
      // v4 自循环进化演练：喂养/清理后按周期做一次演练分析，门控通过才真实演化
      try {
        const r = await service.autoEvolve();
        if (r.evolved) {
          console.log("[hippocampus] 自动演化完成：合并 " + r.merged + "，修剪 " + r.prunedLinks + "，fitness " + r.fitnessAfter + "，lr " + r.lr);
        }
      } catch { /* 自动演化失败不影响 */ }
    })();
  }, FEED_INTERVAL_MS);

  // v3.1 启动自检：DSH 启动后 5 秒自动执行一次增量喂养（启动即绑定记忆轨迹），
  // 并后台预热语义编码模型（避免首次检索/喂养卡顿）
  const bootTimer = setTimeout(() => {
    void (async () => {
      try {
        const allIds = [...new Set(registry.recentProjects().flatMap((p) => p.sessionIds))];
        if (allIds.length > 0) {
          await service.feed({ scope: "unified", sessionIds: allIds });
        }
      } catch { /* 启动喂养失败不影响 */ }
    })();
    embedText("海马体记忆预热").catch(() => {});
  }, 5000);

  ctx.on("dispose", () => {
    clearInterval(feedTimer);
    clearTimeout(bootTimer);
    // v5.2：注册表防抖写盘定时器一并清理
    if (registry._saveTimer) { clearTimeout(registry._saveTimer); registry._saveTimer = null; }
    for (const db of factory.dbs.values()) db.close();
  });
}

// 供独立测试 / 编程使用
export { HippocampusDb, HippocampusService, HippocampusDbFactory, ActivityRegistry, AnchorBank, segSegDist3, distillTrajectory };

// 海马体记忆 Agent —— 服务端半边（node half）v3（Wazome Memory Network v3.1）
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
export const inject = ["tools", "timer"];

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
  return path.join(dshHome(), "storages", "hippocampus", "models");
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
function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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

/** 提取消息文本（兼容 user/message、assistant/message、tool/result 各种 data 形状） */
function messageTextOf(ev) {
  const out = [];
  const data = ev?.data ?? ev;
  if (Array.isArray(data?.content)) extractBlocks(data.content, out);
  if (data?.message && Array.isArray(data.message.content)) extractBlocks(data.message.content, out);
  if (typeof data?.text === "string") out.push(data.text);
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

async function getExtractor() {
  if (extractorOk && extractorPromise) return extractorPromise;
  if (extractorPromise) return extractorPromise;
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
  } catch (err) {
    extractorPromise = null;
    throw err;
  }
  return extractorPromise;
}

/** 将文本编码为 512 维归一化向量（失败时返回 null，调用方回退词法） */
async function embedText(text) {
  try {
    const extractor = await getExtractor();
    const input = String(text ?? "").replace(/\s+/g, " ").slice(0, 4000);
    const out = await extractor(input, { pooling: "mean", normalize: true });
    return Float32Array.from(out.data);
  } catch (err) {
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
  constructor(scope, projectPath) {
    // v3.2：统一记忆库 —— 所有信息内容记忆在同一记录中，跨工作区目录打通
    this.scope = "unified";
    this.projectPath = projectPath ?? null;
    fs.mkdirSync(storeDir(scope, projectPath), { recursive: true });
    this.db = new Database(dbFile(scope, projectPath));
    this.db.loadExtension(getLoadablePath());
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA busy_timeout=5000;");
    this.initSchema();
    this.migrateLegacy();
    // v3.2：一次性合并旧「按项目分库」的数据进统一库（跨目录打通，保留历史记忆）
    this.migrateProjectStores();
    this.applyDecay();
    this.enforceNodeCap();
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
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    if (!row) return def;
    try { return JSON.parse(row.value); } catch { return row.value; }
  }
  setMeta(key, value) {
    this.db.prepare(
      "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    ).run(key, JSON.stringify(value));
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

  /** 遗忘曲线：按距上次访问的天数衰减强度（v3.3：偏好/交流核心永不自动降强） */
  applyDecay() {
    const ts = now();
    const rows = this.db.prepare("SELECT id, strength, last_access_at, updated_at FROM branches WHERE status='active' AND kind NOT IN ('preference','communication')").all();
    const upd = this.db.prepare("UPDATE branches SET strength=? WHERE id=?");
    const tx = this.db.transaction((items) => {
      for (const r of items) {
        const base = r.last_access_at || r.updated_at || ts;
        const days = Math.max(0, (ts - base) / DAY_MS);
        if (days >= 1) {
          const next = Math.max(STRENGTH_FLOOR, r.strength * Math.pow(DECAY_PER_DAY, days));
          upd.run(next, r.id);
        }
      }
    });
    tx(rows);
  }

  /** 为全部活跃分支补充/刷新向量（写入时调用，幂等） */
  async embedAll() {
    const rows = this.db.prepare(
      "SELECT b.id, b.title, b.content, b.tags FROM branches b WHERE b.status='active'"
    ).all();
    for (const r of rows) {
      try {
        const text = [r.title, safeJsonArray(r.tags, "[]").join(" "), r.content].filter(Boolean).join("。");
        const vec = await embedText(text);
        if (vec) this.storeEmbedding(r.id, vec);
      } catch { /* 单条补嵌入失败不中断 */ }
    }
  }

  /** 写入/替换某分支的向量（delete + insert 保证幂等） */
  storeEmbedding(branchId, vec) {
    this.db.prepare("DELETE FROM memories WHERE rowid=?").run(BigInt(branchId));
    this.db.prepare("INSERT INTO memories(rowid, embedding) VALUES (?,?)").run(BigInt(branchId), vecToBuffer(vec));
  }

  embedFor(branchId) {
    const row = this.db.prepare("SELECT embedding FROM memories WHERE rowid=?").get(BigInt(branchId));
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
    this.invalidateGraphCache();
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
    this.invalidateGraphCache();
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
    const text = [branch.title, branch.tags.join(" "), branch.content].filter(Boolean).join("。");
    const vec = await embedText(text);
    if (vec) {
      const sim = await this.findSimilar(vec, { limit: 3 });
      const top = sim[0];
      if (top && top.s >= DEDUP_THRESHOLD && top.b.kind === branch.kind && top.b.status === "active") {
        const existing = this.getByUid(top.b.id);
        const history = safeJsonArray(
          this.db.prepare("SELECT history FROM branches WHERE uid=?").get(existing.id)?.history, "[]"
        );
        history.push({ at: ts, by: "agent", summary: "检测到相似记忆（相似度 " + top.s.toFixed(2) + "），自动合并强化" });
        this.db.prepare(
          "UPDATE branches SET strength=?, last_access_at=?, updated_at=?, history=? WHERE uid=?"
        ).run(
          clamp(existing.strength + 0.06, 0, 1), ts, ts, JSON.stringify(history.slice(-HISTORY_LIMIT)), existing.id
        );
        return { branch: this.getByUid(existing.id), dedup: true, mergedInto: existing.id };
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
    this.invalidateGraphCache();
    // v3.2：节点上限检查（超过 1000 自动淘汰最弱）
    try { this.enforceNodeCap(); } catch { /* 淘汰失败不影响写入 */ }
    return { branch: this.getByUid(branch.uid), dedup: false, mergedInto: null };
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
    this.invalidateGraphCache();
    return this.getByUid(uid);
  }

  /** 遗忘：归档（默认）或彻底删除 */
  removeBranch(uid, hard) {
    const row = this.db.prepare("SELECT * FROM branches WHERE uid=?").get(uid);
    if (!row) throw new Error("hippocampus.forget: 记忆不存在: " + uid);
    if (hard === true) {
      this.db.prepare("DELETE FROM memories WHERE rowid=?").run(BigInt(row.id));
      this.db.prepare("DELETE FROM branches WHERE id=?").run(row.id);
      this.unlinkAll(uid);
      this.invalidateGraphCache();
      return { removed: true, hard: true };
    }
    this.db.prepare("UPDATE branches SET status='archived', updated_at=? WHERE uid=?").run(now(), uid);
    this.unlinkAll(uid);
    this.invalidateGraphCache();
    return { removed: true, hard: false };
  }

  getByUid(uid) {
    return this.rowToBranch(this.db.prepare("SELECT * FROM branches WHERE uid=?").get(uid));
  }

  /** 按标题精确查找（自动喂养 upsert 用） */
  findByTitle(title) {
    return this.rowToBranch(this.db.prepare("SELECT * FROM branches WHERE title=? AND status='active'").get(title));
  }

  /** 记忆库文件总大小（db + wal + shm） */
  dbSizeBytes() {
    let total = 0;
    for (const f of [dbFile(this.scope, this.projectPath), dbFile(this.scope, this.projectPath) + "-wal", dbFile(this.scope, this.projectPath) + "-shm"]) {
      try { total += fs.statSync(f).size; } catch { /* 文件可能不存在 */ }
    }
    return total;
  }

  /** 与某向量最相似的活跃分支（排除自身可选） */
  async findSimilar(vec, opts = {}) {
    if (!vec) return [];
    const { limit = 3, excludeUid = null, minScore = 0.4 } = opts;
    const active = this.db.prepare("SELECT * FROM branches WHERE status='active'").all().map((r) => this.rowToBranch(r));
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
    let rows = this.db.prepare(
      "SELECT * FROM branches" + (includeArchived ? "" : " WHERE status='active'")
    ).all().map((r) => this.rowToBranch(r));
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

  /** 读取单条（触发再巩固） */
  getBranch(uid) {
    const b = this.getByUid(uid);
    if (!b) throw new Error("hippocampus.get: 记忆不存在: " + uid);
    b.strength = clamp(b.strength + RECONSOLIDATE_BOOST, 0, 1);
    b.lastAccessAt = now();
    this.db.prepare("UPDATE branches SET strength=?, last_access_at=? WHERE uid=?").run(b.strength, b.lastAccessAt, uid);
    return { branch: this.sanitize(b) };
  }

  /** 三阶段检索：词法 + 语义(向量) + 联想(图扩散)，共激活 Hebbian 强化 */
  async searchBranches(q, limit) {
    if (typeof q !== "string" || !q.trim()) throw new Error("hippocampus.search: 缺少查询词 q");
    const n = typeof limit === "number" ? clamp(Math.floor(limit), 1, 50) : 8;
    const qTokens = tokensOf(q);
    const active = this.db.prepare("SELECT * FROM branches WHERE status='active'").all().map((r) => this.rowToBranch(r));

    // 阶段 1：词法
    const lex = active
      .map((b) => ({ b, s: scoreQuery(b, qTokens) }))
      .filter((x) => x.s > 0)
      .sort((x, y) => y.s - x.s)
      .slice(0, LEX_TOP_K);

    // 阶段 2：语义向量（rowid ↔ 分支映射：vec0 MATCH 返回数字 rowid）
    let sem = [];
    const qvec = await embedText(q);
    if (qvec) {
      const hits = this.db.prepare(
        "SELECT rowid, distance FROM memories WHERE embedding MATCH ? ORDER BY distance LIMIT ?"
      ).all(vecToBuffer(qvec), VEC_TOP_K);
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

    // 阶段 3：联想扩散 —— 从 top5 沿相似图（向量 + 突触连接）取邻居
    if (fused.length > 0) {
      const seeds = fused.slice(0, 5);
      const expanded = this.associateExpand(seeds, n, qvec);
      const seen = new Set(fused.map((x) => x.b.id));
      for (const e of expanded) {
        if (!seen.has(e.b.id)) {
          fused.push(e);
          seen.add(e.b.id);
        }
      }
    }
    fused = fused.slice(0, Math.max(n, 12)).sort((x, y) => y.s - x.s).slice(0, n);

    // 再巩固：命中前 3 条 + Hebbian 共激活强化（top6 两两连接 +0.02·s·s）
    const topHits = fused.slice(0, 6);
    for (let i = 0; i < topHits.length; i++) {
      for (let j = i + 1; j < topHits.length; j++) {
        this.strengthenLink(topHits[i].b.id, topHits[j].b.id, 0.02 * topHits[i].s * topHits[j].s);
      }
    }
    for (const { b } of topHits.slice(0, 3)) {
      b.strength = clamp(b.strength + RECONSOLIDATE_BOOST, 0, 1);
      b.lastAccessAt = now();
      this.db.prepare("UPDATE branches SET strength=?, last_access_at=? WHERE id=?").run(b.strength, b.lastAccessAt, b.id);
    }
    return { results: fused.map(({ b, s }) => ({ branch: this.sanitize(b), score: Number(clamp(s, 0, 1).toFixed(3)) })) };
  }

  /** 联想扩散：沿相似图（向量邻居 + 突触连接）从种子 BFS，返回补充结果 */
  associateExpand(seeds, n, qvec) {
    const active = this.db.prepare("SELECT * FROM branches WHERE status='active'").all().map((r) => this.rowToBranch(r));
    if (active.length <= 1) return [];
    const seedIds = new Set(seeds.map((x) => x.b.id));
    const neighbors = new Map();
    const byId = new Map(active.map((b) => [b.rowId ?? b.id, b]));
    for (const s of seeds) {
      const row = this.db.prepare("SELECT * FROM branches WHERE uid=?").get(s.b.id);
      if (!row) continue;
      // ① 向量邻居
      const emb = qvec ?? this.embedFor(row.id);
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
    return [...neighbors.values()]
      .map(({ b, w }) => ({ b, s: w * 0.85 }))
      .filter((x) => x.s > 0.12)
      .sort((x, y) => y.s - x.s);
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

    let merged = 0;
    const seenPairs = new Set();
    const active = this.db.prepare("SELECT * FROM branches WHERE status='active' ORDER BY strength DESC").all().map((r) => this.rowToBranch(r));
    const scan = active.slice(0, 40);
    for (const a of scan) {
      if (merged >= 5) break;
      const emb = this.embedFor(a.rowId);
      if (!emb) continue;
      const sim = await this.findSimilar(emb, { limit: 2, excludeUid: a.id, minScore: MERGE_THRESHOLD });
      const top = sim[0];
      if (!top || top.b.kind !== a.kind) continue;
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
    this.setMeta("fitness", Number(avg.toFixed(3)));
    this.invalidateGraphCache();
    const g = this.graphData();
    return { ...g, merged, prunedLinks };
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
    this.db.prepare("UPDATE branches SET status='archived', updated_at=? WHERE uid=?").run(ts, weaker.id);
    this.unlinkAll(weaker.id);
    this.setMeta("pruned", Number(this.getMeta("pruned", 0)) + 1);
    for (const l of this.linksOf(weaker.id)) {
      this.strengthenLink(stronger.id, l.other, l.weight * 0.6);
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
        this.unlinkAll(r.uid);
      }
    });
    tx(rows);
    const prunedLinks = this.db.prepare("DELETE FROM links WHERE weight < ?").run(LINK_PRUNE_THRESHOLD).changes;
    this.setMeta("pruned", Number(this.getMeta("pruned", 0)) + n);
    this.setMeta("lastActivityAt", ts);
    this.invalidateGraphCache();
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
   */
  distillStale() {
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
      this.updateBranch(existing.id, { content: content.slice(0, 8000), strength: clamp(existing.strength + 0.04, 0, 1) }, "system").catch(() => {});
    } else {
      this.writeBranch({ title, content: summary.slice(0, 8000), kind: "insight", tags: ["精华", "自动", "过期归档"], source: "system" }).catch(() => {});
    }
    let deleted = 0;
    for (const b of rows) {
      try { this.removeBranch(b.id, true); deleted++; } catch { /* 竞态忽略 */ }
    }
    this.setMeta("staleCleaned", Number(this.getMeta("staleCleaned", 0)) + deleted);
    return { distilled: rows.length, deleted };
  }

  /** 存储上限检查：超过 SIZE_LIMIT_BYTES 自动触发优化 */
  checkSize() {
    const size = this.dbSizeBytes();
    this.setMeta("sizeBytes", size);
    if (size > SIZE_LIMIT_BYTES) {
      return { ...this.optimizeForSize(), triggered: true };
    }
    return { ok: true, sizeBytes: size, optimized: false, triggered: false };
  }

  /**
   * 超限优化：① 提炼过期记忆精华（喂养）→ ② 清理过期/无效记忆 →
   * ③ 清除孤儿向量 → ④ checkpoint + VACUUM 压缩。
   */
  optimizeForSize() {
    const before = this.dbSizeBytes();
    let distilled = 0;
    let deleted = 0;
    try {
      const d = this.distillStale();
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
  async feedTrajectory(events, sessionId) {
    if (!Array.isArray(events) || events.length === 0) return { fed: 0, wrote: false };
    const ts = now();
    const text = distillTrajectory(events);
    if (!text) return { fed: events.length, wrote: false };
    // 小时窗口标题：同一小时的喂养归并到同一条「会话精华」
    const windowLabel = new Date(ts).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit" });
    const title = "会话精华 " + windowLabel;
    const existing = this.findByTitle(title);
    if (existing) {
      this.db.prepare(
        "UPDATE branches SET content=?, strength=?, updated_at=?, last_access_at=? WHERE uid=?"
      ).run(text, clamp(existing.strength + 0.05, 0, 1), ts, ts, existing.id);
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
    this.setMeta("feedAt", ts);
    this.invalidateGraphCache();
    return { fed: events.length, wrote: true, title, chars: text.length };
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
    // 核心：球心附近小团簇（偏好/交流）
    cores.forEach((b, i) => {
      const d = sphereDir(i, Math.max(1, cores.length), 1.7);
      const r = 0.08 + hash01("cr" + b.id) * 0.06;
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
      const r = 0.34 + hash01("wr" + w.path) * 0.08;
      nodes.push({
        id: this.workdirId(w.path), uid: this.workdirId(w.path), title: "📁 " + (w.name ?? w.path),
        kind: "workdir", strength: 0.85, status: "active", workdir: w.path,
        type: "workdir", ring: 1, activation: 0.85, ageDays: 0,
        x0: d.x * r, y0: d.y * r, z0: d.z * r
      });
    });
    // 衍生记忆：外球面，按所属工作区方向扇区扩散
    const wdirDirMap = new Map(wdirDirs.map(({ w, d }) => [w.path, d]));
    leaves.forEach((b, i) => {
      const wd = b.scopePath ?? null;
      const baseDir = wd && wdirDirMap.has(wd) ? wdirDirMap.get(wd) : sphereDir(i, Math.max(1, leaves.length), 3.3);
      const jitter = norm({
        x: baseDir.x * 0.72 + (hash01("jx" + b.id) - 0.5) * 0.9,
        y: baseDir.y * 0.72 + (hash01("jy" + b.id) - 0.5) * 0.9,
        z: baseDir.z * 0.72 + (hash01("jz" + b.id) - 0.5) * 0.9
      });
      const r = 0.78 + hash01("lr" + b.id) * 0.2;
      nodes.push({
        id: b.id, uid: b.id, title: b.title, kind: b.kind, strength: b.strength, status: b.status,
        type: "leaf", ring: 2, workdir: wd, activation: b.strength,
        ageDays: Math.max(0, (now() - (b.createdAt || now())) / DAY_MS),
        x0: jitter.x * r, y0: jitter.y * r, z0: jitter.z * r
      });
    });

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
    const total = this.db.prepare("SELECT COUNT(*) AS c FROM branches").get().c;
    const active = this.db.prepare("SELECT COUNT(*) AS c FROM branches WHERE status='active'").get().c;
    const kinds = {};
    for (const k of KINDS) kinds[k] = this.db.prepare("SELECT COUNT(*) AS c FROM branches WHERE kind=? AND status='active'").get(k).c;
    const links = this.db.prepare("SELECT COUNT(*) AS c FROM links WHERE weight >= ?").get(LINK_PRUNE_THRESHOLD).c;
    return {
      epoch: Number(this.getMeta("epoch", 1)),
      generation: Number(this.getMeta("generation", 0)),
      iteration: Number(this.getMeta("iteration", 0)),
      error: Number(this.getMeta("error", 0)),
      learningRate: Number(this.getMeta("learningRate", 0.01)),
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
  }

  /**
   * v3：项目记忆包 —— 长会话中刷新上下文锚点，缓解上下文污染。
   * 返回当前作用域浓缩记忆：按 强度×0.6 + 新鲜度×0.4 排序的 topN、
   * 最新工作状态、最新洞察、以及记忆库健康统计。
   */
  contextPack({ topN = 12, maxLen = 200 } = {}) {
    const ts = now();
    const n = clamp(Math.floor(topN ?? 12), 3, 30);
    const len = clamp(Math.floor(maxLen ?? 200), 60, 800);
    const active = this.db.prepare("SELECT * FROM branches WHERE status='active'").all().map((r) => this.rowToBranch(r));
    const scored = active.map((b) => {
      const ageDays = Math.max(0, (ts - (b.updatedAt || ts)) / DAY_MS);
      const recency = Math.max(0, 1 - ageDays / 30);
      return { b, s: b.strength * 0.6 + recency * 0.4 };
    }).sort((x, y) => y.s - x.s);
    const top = scored.slice(0, n).map(({ b, s }) => {
      const c = String(b.content ?? "");
      return { ...this.sanitize(b), content: c.length > len ? c.slice(0, len) + "…" : c, packScore: Number(s.toFixed(3)) };
    });
    const workstate = active.filter((b) => b.kind === "workstate").sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
    const insight = active.filter((b) => b.kind === "insight").sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
    const stats = this.buildMeta();
    const scopeName = "统一记忆库";
    const head = "【" + scopeName + " · 记忆包】" + (this.projectPath ? " 当前目录: " + this.projectPath : "");
    const lines = [head];
    if (workstate) lines.push("▶ 工作状态: " + String(workstate.content).slice(0, 300));
    for (const t of top) {
      lines.push("• [" + t.kind + "|" + t.strength.toFixed(2) + "|" + t.packScore.toFixed(2) + "] " + t.title + " — " + String(t.content).slice(0, len));
    }
    if (insight && !top.some((t) => t.id === insight.id)) {
      lines.push("• [洞察] " + insight.title + " — " + String(insight.content).slice(0, len));
    }
    lines.push("〔统计: 活跃 " + stats.counts.active + " · 连接 " + stats.connections + " · 强度均 " + (stats.fitness || 0).toFixed(2) + " · epoch " + stats.epoch + " · 归档 " + stats.counts.archived + " · 库大小 " + Math.round(stats.sizeBytes / 1024) + "KB〕");
    return {
      scope: this.scope,
      projectPath: this.projectPath ?? null,
      text: lines.join("\n"),
      top,
      workstate: workstate ? this.sanitize(workstate) : null,
      stats
    };
  }

  reportWork({ task, phase, progress, sessionId }) {
    this.setMeta("lastActivityAt", now());
    if (typeof sessionId === "string") this.setMeta("lastSessionId", sessionId);
    if (typeof task === "string") this.setMeta("lastTask", task.slice(0, 300));
    const qTokens = tokensOf("工作状态");
    const active = this.db.prepare("SELECT * FROM branches WHERE status='active'").all().map((r) => this.rowToBranch(r));
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
    return { counts: this.buildMeta().counts, meta: this.buildMeta(), graph: g };
  }

  sanitize(branch) {
    return { ...branch, history: (branch.history ?? []).slice(-10) };
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
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.map)));
    } catch { /* 注册表写失败不影响主流程 */ }
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
  }
  getDb(scope, projectPath) {
    // scope/scopePath 仅为向后兼容，统一返回同一个记忆库
    const key = "unified";
    let db = this.dbs.get(key);
    if (!db) {
      db = new HippocampusDb("global", null);
      this.dbs.set(key, db);
    }
    return db;
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
    const { q, limit } = isPlainObject(request) ? request : {};
    return this.dbOf(request).searchBranches(q, limit);
  }

  /** 可视化图 */
  async graph(request) {
    return this.dbOf(request).graphData();
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

  /** 项目记忆包（上下文刷新用） */
  async context(request) {
    const { topN, maxLen } = isPlainObject(request) ? request : {};
    return this.dbOf(request).contextPack({ topN, maxLen });
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
    events.sort((a, b) => a.time - b.time);
    const out = db.feedTrajectory(events, ids[0] ?? null);
    try { out.purged = db.purgeStale(); } catch { /* 清理失败不阻断 */ }
    try { out.size = db.checkSize(); } catch { /* 检查失败不阻断 */ }
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
  context: "context",
  reportWork: "reportWork",
  feed: "feed",
  optimize: "optimize",
  resolveProject: "resolveProject",
  archiveWorkdir: "archiveWorkdir"
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
      const { branch, dedup, mergedInto } = await viaService(service, "create", { title: args.title, content: args.content, kind: args.kind, tags: args.tags ?? [], strength: args.strength, source: "agent", scope, scopePath, sessionId }, agent);
      if (args.kind === "workstate" && !dedup) await viaService(service, "reportWork", { task: args.title, phase: "写入", progress: null, scope, scopePath }, agent).catch(() => {});
      return {
        ok: true,
        branch,
        dedup,
        mergedInto,
        message: dedup
          ? "检测到相似记忆（已合并强化原记忆，未重复入库）: " + branchSummary(branch)
          : "记忆已写入: " + branchSummary(branch)
      };
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
 * 统一记忆库的关键记忆（强度×0.6+新鲜度×0.4）+ 最新工作状态 + 一句工具提示。
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
      const pack = udb.contextPack({ topN: 8, maxLen: 130 });
      const lines = ["# 海马体记忆（对话前自动调取）", "以下是你的长期记忆（统一记忆库）中的关键内容，工作与回答时优先参考："];
      if (pack.workstate) lines.push("▶ 当前工作状态：\n" + String(pack.workstate.content).slice(0, 260));
      for (const t of pack.top) {
        if (pack.workstate && t.id === pack.workstate.id) continue;
        lines.push("• [" + (KIND_LABELS[t.kind] ?? t.kind) + "|" + t.strength.toFixed(2) + "] " + t.title + "：" + String(t.content).slice(0, 130));
      }
      lines.push("记忆工具：memory_write/memory_read/memory_search/memory_edit/memory_forget/memory_stats/memory_context/memory_evolve 可随时读写记忆；轨迹每小时自动喂养。");
      text = lines.join("\n");
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
  ctx.setInterval(() => {
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
        udb.checkSize();
        udb.enforceNodeCap();
      } catch { /* 清理失败忽略 */ }
    })();
  }, FEED_INTERVAL_MS);

  // v3.1 启动自检：DSH 启动后 5 秒自动执行一次增量喂养（启动即绑定记忆轨迹），
  // 并后台预热语义编码模型（避免首次检索/喂养卡顿）
  ctx.setTimeout(() => {
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
    for (const db of factory.dbs.values()) db.close();
  });
}

// 供独立测试 / 编程使用
export { HippocampusDb, HippocampusService, HippocampusDbFactory, ActivityRegistry, distillTrajectory };

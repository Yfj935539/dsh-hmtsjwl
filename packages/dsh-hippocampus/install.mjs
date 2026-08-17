// 海马体记忆 Agent —— 安装脚本（v2 稳定版）
// 作用：
//   1. 将插件包复制到 DSH profile（$DSH_HOME/profiles/node_modules/@local/dsh-hippocampus）
//   2. 运行时依赖 hoist 到 $DSH_HOME/profiles/node_modules 顶层（与宿主依赖同层，
//      避免插件子目录内 node_modules 被宿主/安装器反复处理导致原生模块残缺）
//   3. 插件 package.json 移除 dependencies（消除依赖重装诱因）
//   4. 在 cordis.patch.yml 注册插件行（幂等）
// 用法：node install.mjs [--dsh-home <路径>]
import { mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync, chmodSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const argHome = process.argv.indexOf("--dsh-home");
const HOME = argHome >= 0 ? process.argv[argHome + 1] : (process.env.DSH_HOME || path.join(os.homedir(), ".dsh"));
const PKG = "@local/dsh-hippocampus";
const NM_ROOT = path.join(HOME, "profiles", "node_modules");
const DEST = path.join(NM_ROOT, ...PKG.split("/"));
const PROFILE_DIR = path.join(HOME, "profiles", "web");
const PATCH = path.join(PROFILE_DIR, "cordis.patch.yml");

// 单文件复制失败不中断整体（应用运行中可能锁定 .node 原生模块）
function copyDir(from, to, skipExisting = false) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    const s = path.join(from, entry);
    const d = path.join(to, entry);
    try {
      if (statSync(s).isDirectory()) {
        if (skipExisting && existsSync(d)) continue;
        copyDir(s, d, skipExisting);
      } else {
        copyFileSync(s, d);
      }
    } catch {
      console.log("  ⚠️  跳过（可能被占用）: " + s);
    }
  }
}

// 递归清除只读位后删除（Windows 下复制回退的副本可能带只读属性，rmSync 会抛 EPERM）
function clearReadonly(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    try {
      if (ent.isDirectory()) clearReadonly(p);
      else chmodSync(p, 0o600);
    } catch {}
  }
  try { chmodSync(dir, 0o700); } catch {}
}
function safeRm(dir) {
  try { rmSync(dir, { recursive: true, force: true }); return; } catch {}
  clearReadonly(dir);
  try { rmSync(dir, { recursive: true, force: true }); } catch (e) {
    console.log("  ⚠️  删除失败（可能被占用）: " + dir + " — " + e.message);
  }
}

// 写入 package.json 并校验（后端进程占用时首次写入可能被清空，重试）
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function writePkgJson(file, pkg, retries = 5) {
  const raw = JSON.stringify(pkg, null, 2) + "\n";
  for (let i = 0; i < retries; i++) {
    writeFileSync(file, raw, "utf8");
    try {
      const back = JSON.parse(readFileSync(file, "utf8"));
      if (back && back.name === pkg.name) return;
    } catch {}
    console.log(`  ⚠️  package.json 写入校验未通过，${i + 1}/${retries} 重试…`);
    sleepSync(500);
  }
  throw new Error("package.json 写入校验失败: " + file);
}

console.log("🧠 海马体记忆 Agent 安装");
console.log("   源码:   " + SRC);
console.log("   DSH 家目录: " + HOME);

// 1. 复制插件包（不含 node_modules：依赖统一 hoist 到顶层）
safeRm(DEST);
mkdirSync(DEST, { recursive: true });
copyDir(path.join(SRC, "lib"), path.join(DEST, "lib"));
if (existsSync(path.join(SRC, "scripts"))) {
  copyDir(path.join(SRC, "scripts"), path.join(DEST, "scripts"));
}
{
  // package.json：移除 dependencies，避免宿主把插件识别为待安装依赖
  const pkg = JSON.parse(readFileSync(path.join(SRC, "package.json"), "utf8"));
  delete pkg.dependencies;
  writePkgJson(path.join(DEST, "package.json"), pkg);
}
console.log("✅ 插件已安装到 " + DEST + "（package.json " + statSync(path.join(DEST, "package.json")).size + " 字节）");

// 2. hoist 运行时依赖到顶层 node_modules（与宿主 junction 同层；已存在则跳过）
const SRC_NM = path.join(SRC, "node_modules");
if (existsSync(SRC_NM)) {
  copyDir(SRC_NM, NM_ROOT, true);
  console.log("✅ 运行时依赖已 hoist 到 " + NM_ROOT);
}

// 2.1 在插件自身 node_modules 下为 hoisted 包创建 junction
// DSH 的 ESM loader 在解析插件内的 bare specifier 时不向上遍历
// （解析链在 @local 作用域处断裂），必须在插件本地 node_modules 中可直接命中
const PLUGIN_NM = path.join(DEST, "node_modules");
mkdirSync(PLUGIN_NM, { recursive: true });
const JUNCTION_PKGS = [
  "better-sqlite3",
  "sqlite-vec",
  "@xenova/transformers",
];
for (const spec of JUNCTION_PKGS) {
  const src = path.join(NM_ROOT, ...spec.split("/"));
  const dst = path.join(PLUGIN_NM, ...spec.split("/"));
  if (!existsSync(src)) {
    console.log("  ⚠️  跳过（hoisted 源不存在）: " + spec);
    continue;
  }
  try {
    // 确保父目录存在（scoped 包）
    const parent = path.dirname(dst);
    mkdirSync(parent, { recursive: true });
    if (existsSync(dst)) safeRm(dst);
    // 使用 junction（Windows）/ symlink（POSIX），这里用 fs.symlinkSync 自动选择
    try {
      fs.symlinkSync(src, dst, "dir");
    } catch {
      // 回退：直接复制（若 symlink 权限不足）
      copyDir(src, dst);
    }
    console.log("✅ 已为本机 ESM 解析创建链接: " + spec);
  } catch (err) {
    console.log("  ⚠️  链接失败，回退为复制: " + spec + " — " + err.message);
    try { copyDir(src, dst); } catch {}
  }
}

// 3. 注册到 web profile
const INSERT = `- insert:
    - id: hippocampus
      name: '@local/dsh-hippocampus'`;
mkdirSync(PROFILE_DIR, { recursive: true });
let patch = "";
try {
  patch = readFileSync(PATCH, "utf8");
} catch {
  patch = "";
}
if (patch.includes("@local/dsh-hippocampus")) {
  console.log("⏭️  cordis.patch.yml 已包含插件行，跳过");
} else {
  // 移除孤立的空列表行 []（顶层列表不允许与列表项共存）
  patch = patch.replace(/^\s*\[\s*\]\s*$/m, "");
  const trimmed = patch.trim();
  patch = (trimmed.length > 0 ? trimmed + "\n\n" : "") + INSERT + "\n";
  writeFileSync(PATCH, patch, "utf8");
  console.log("✅ 已注册到 " + PATCH);
}

// 4. 提示重启
console.log("");
console.log("⚠️  需要重启 DeepSeek Harness 才能生效：");
console.log("   1) 关闭 Glass 应用（或托盘菜单 → 重启后端）");
console.log("   2) 重新打开，进入任意会话");
console.log("   3) 在「对话 / 轨迹」之后会出现「记忆」标签页");
console.log("");
console.log("🧰 我在任务中可用的记忆工具：memory_write / memory_read / memory_search / memory_edit / memory_forget");

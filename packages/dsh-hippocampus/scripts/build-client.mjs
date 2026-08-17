// 海马体记忆 Agent —— Client 打包脚本
// 作用：把 lib/client/ 多模块源码（CommonJS 风格的 require/exports 模块）
//       打包成 DSH 模块系统要求的单一 bundle（lib/client.js）。
// 用法：node scripts/build-client.mjs [--out lib/client.js]
// 说明：打包格式与 DSH 官方 client bundle 一致：
//       window.__ModuleLoader__.load({ id, factory }) + 模块注册表 + __req 解析器。
//       每个模块用普通函数包裹（module/exports/require），require 相对路径解析到
//       模块注册表；非相对裸 specifier（如 "react"）回退 __platformRequire。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, "..", "lib", "client");
const OUT = (() => {
  const i = process.argv.indexOf("--out");
  return i >= 0 ? path.resolve(process.argv[i + 1]) : path.resolve(__dirname, "..", "lib", "client.js");
})();
const PKG_ID = "@local/dsh-hippocampus";

// 收集 lib/client/ 下所有 .js 文件（相对路径 key，正斜杠）
function collectModules(dir, base = dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...collectModules(full, base));
    else if (ent.name.endsWith(".js")) {
      const rel = path.relative(base, full).replace(/\\/g, "/");
      out.push({ key: rel, code: fs.readFileSync(full, "utf8") });
    }
  }
  return out;
}

const modules = collectModules(SRC);
if (modules.length === 0) {
  console.error("❌ lib/client/ 下没有找到模块源码");
  process.exit(1);
}
if (!modules.some((m) => m.key === "index.js")) {
  console.error("❌ lib/client/index.js 缺失（bundle 入口）");
  process.exit(1);
}

// 头部 + 模块注册表 + 尾部模板（与 DSH 官方 bundle 格式一致）
const HEADER = `// 海马体记忆 Agent —— 浏览器半边（client half）v5.2
// 由 lib/client/ 多模块源码打包生成（DSH 模块系统要求每插件单一 bundle）
// 重新生成：node scripts/build-client.mjs
window.__ModuleLoader__.load({
\tid: "${PKG_ID}",
\tfactory: (__platformRequire) => {
\t\tvar __modules = {
`;
const FOOTER = `\t\t};
\t\tvar __cache = Object.create(null);
\t\tvar __base = "index.js";
\t\tfunction __norm(base, id) {
\t\t\tvar parts = base.split("/"); parts.pop();
\t\t\tfor (const seg of id.split("/")) {
\t\t\t\tif (seg === "." || seg === "") continue;
\t\t\t\tif (seg === "..") parts.pop(); else parts.push(seg);
\t\t\t}
\t\t\tvar r = parts.join("/");
\t\t\tif (!r.endsWith(".js")) r += ".js";
\t\t\treturn r;
\t\t}
\t\tfunction __req(id) {
\t\t\tvar key = id.charAt(0) === "." ? __norm(__base, id) : id;
\t\t\tvar m = __cache[key];
\t\t\tif (m) return m.exports;
\t\t\tvar fn = __modules[key];
\t\t\tif (!fn) return __platformRequire(id);
\t\t\tvar prev = __base; __base = key;
\t\t\tm = __cache[key] = { exports: {} };
\t\t\tfn(m, m.exports, __req);
\t\t\t__base = prev;
\t\t\treturn m.exports;
\t\t}
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
\t\treturn __req("index.js");
\t}
});
`;

let body = "";
for (const m of modules) {
  body += `      "${m.key}": function (module, exports, require) {\n`;
  body += m.code.replace(/\n$/, "") + "\n";
  body += `      },\n`;
}

const bundle = HEADER + body + FOOTER;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, bundle, "utf8");
console.log(`✅ 打包完成: ${modules.length} 个模块 → ${path.relative(process.cwd(), OUT)} (${bundle.length} 字节)`);
console.log(`   模块列表: ${modules.map((m) => m.key).join(", ")}`);

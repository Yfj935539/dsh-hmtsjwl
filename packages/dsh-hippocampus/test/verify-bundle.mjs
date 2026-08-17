// 验证打包脚本输出：结构 + 语法 + 模块完整性
import fs from "node:fs";
import path from "node:path";

const file = process.argv[2];
const code = fs.readFileSync(file, "utf8");

const keys = [...code.matchAll(/"([a-z0-9/_.-]+\.js)": function/g)].map((m) => m[1]);
console.log("模块 key (" + keys.length + "):", keys.join(", "));
console.log("含 __ModuleLoader__.load:", code.includes("__ModuleLoader__.load"));
console.log("含 __req 解析器:", code.includes("function __req"));
console.log("含 index.js 入口:", code.includes('__req("index.js")'));
console.log("含 platform require 回退:", code.includes("__platformRequire(id)"));
try {
  // 语法检查：bundle 在浏览器里由 ModuleLoader 调用；Node 里用 new Function 只验证语法
  new Function(code);
  console.log("语法检查: ✅ OK");
} catch (e) {
  console.log("语法检查: ❌ " + e.message);
  process.exit(1);
}
// 入口模块必须是 index.js
if (!keys.includes("index.js")) {
  console.log("❌ 缺少 index.js 入口");
  process.exit(1);
}
console.log("✅ bundle 验证通过");

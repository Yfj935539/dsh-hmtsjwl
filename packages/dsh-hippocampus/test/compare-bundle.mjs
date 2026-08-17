// 对比新旧 bundle 的模块清单（确保打包脚本无遗漏/无多余）
import fs from "node:fs";

const [oldF, newF] = [process.argv[2], process.argv[3]];
const keys = (s) => [...s.matchAll(/"([a-z0-9/_.-]+\.js)": function/g)].map((m) => m[1]);
const a = keys(fs.readFileSync(oldF, "utf8"));
const b = keys(fs.readFileSync(newF, "utf8"));
console.log("旧模块:", a.join(", "));
console.log("新模块:", b.join(", "));
console.log("缺失:", a.filter((k) => !b.includes(k)).length ? a.filter((k) => !b.includes(k)).join(", ") : "无");
console.log("新增:", b.filter((k) => !a.includes(k)).length ? b.filter((k) => !a.includes(k)).join(", ") : "无");

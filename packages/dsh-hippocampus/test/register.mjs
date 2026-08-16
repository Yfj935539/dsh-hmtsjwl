// 注册测试加载器：node --import ./test/register.mjs test/run.mjs
import { register } from "node:module";
import { pathToFileURL } from "node:url";
register("./loader.mjs", pathToFileURL("./test/"));

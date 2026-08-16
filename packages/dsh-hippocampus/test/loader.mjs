// 测试加载器：将 @deepseek-ai/* 映射到本地桩
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const stubs = {
  "@deepseek-ai/dsh-typert-protocol": path.join(dir, "stub-typert.mjs"),
  "@deepseek-ai/dsh-tools": path.join(dir, "stub-tools.mjs"),
};

export function resolve(specifier, context, nextResolve) {
  if (stubs[specifier]) {
    return { url: pathToFileURL(stubs[specifier]).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
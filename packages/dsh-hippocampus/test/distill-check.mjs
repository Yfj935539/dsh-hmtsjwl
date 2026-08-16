// 验证 distillTrajectory：长历史全量扫信号句，时间线保留最新部分
// 用法：node --import ./test/register.mjs test/distill-check.mjs
import { distillTrajectory } from "../lib/index.js";

const events = [];
for (let i = 1; i <= 8; i++) {
  events.push({
    type: i % 2 ? "user/message" : "assistant/message",
    time: Date.now() - (8 - i) * 60000,
    data: { content: [{ type: "text", text: "第" + i + "条消息：这是普通的讨论内容，没有关键信息，只是填充篇幅让时间线变长，用于验证提炼时是否保留最新内容。" + (i === 1 ? "开头的重要决定：技术栈定为 TypeScript。" : "") + (i === 8 ? "最后的决定：项目采用 Wazome 方案，下一步计划重构可视化。" : "") }] }
  });
}
const out = distillTrajectory(events, 600);
console.log("--- 输出长度:", out.length);
console.log(out);
const okLatest = out.includes("第8条消息");
const okSignal = out.includes("Wazome 方案") && out.includes("TypeScript");
const okHead = out.includes("◆ 关键句");
console.log("\n保留最新内容:", okLatest, "| 全量信号句(开头+结尾):", okSignal, "| 关键句头部:", okHead);
process.exit(okLatest && okSignal && okHead ? 0 : 1);

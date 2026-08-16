// 写入当前项目（dp 工作区）的工作状态记忆 —— 验证 v3 项目记忆网络真实可用
// 用法：node --import ./test/register.mjs test/write-workstate.mjs
import { HippocampusDb } from "../lib/index.js";

const project = "C:\\Users\\Administrator\\Desktop\\dp";
const db = new HippocampusDb("project", project);
const out = await db.writeBranch({
  title: "海马体记忆 v3 改写任务",
  content: "任务：基于 wazome memory network v3.1 深度改写海马体记忆插件（v3/v3.1）。阶段：已完成。进度：100%。成果：修复工具 schema bug 与语义检索 rowid bug；新增突触 links 表、去重合并、自动标签、真实演化/修剪、项目记忆包；每小时轨迹自动喂养、单工作区 1GB 上限自动优化、过期记忆（>30天）降权与清理；全局记忆仅存偏好/性格/需求。vision-eye v2 已移除视觉 tab，视觉嵌入模型工具并支持会话上传图片识别（vision_inbox + attachmentId）。更新于 " + new Date().toLocaleString("zh-CN"),
  kind: "workstate",
  tags: ["状态", "海马体", "v3", "记忆插件"],
  strength: 0.85,
  source: "agent",
  sessionId: "session-write-workstate"
});
console.log("写入结果: dedup=" + out.dedup + " id=" + out.branch.id);
const pack = db.contextPack({ topN: 5, maxLen: 150 });
console.log("\n--- 项目记忆包预览 ---\n" + pack.text.slice(0, 600));
db.close();

# dsh-hippocampus — 海马体记忆 Agent

[![GitHub](https://img.shields.io/badge/源码仓库-Yfj935539%2Fdsh-hmtsjwl-3d6df2?style=flat-square&logo=github)](https://github.com/Yfj935539/dsh-hmtsjwl)

DeepSeek Harness 插件：为 Agent 提供长期记忆能力 —— **3D 球形神经网络可视化**、跨工作区统一的记忆库、每小时轨迹自动喂养、**对话前自动注入**关键记忆、**间隔重复复习调度**、**标签管理与导入导出**。

仓库地址：https://github.com/Yfj935539/dsh-hmtsjwl

## 安装

```bash
git clone https://github.com/Yfj935539/dsh-hmtsjwl.git
cd dsh-hmtsjwl/packages/dsh-hippocampus
node install.mjs
```

重启 DeepSeek Harness 后，在「对话 / 轨迹」之后出现「记忆」标签页。

## 功能

| 能力 | 说明 |
| --- | --- |
| 统一记忆库 | 所有记忆保存在同一记录（`$DSH_HOME/storages/hippocampus/memory.db`），**跨工作区目录打通**；旧版按项目分库的数据启动时自动合并 |
| 3D 球形神经网络 | 球心 = 偏好/交流核心节点（永不自动衰减）；外球面 = 衍生记忆（按所属工作区方向扩散）；拖拽旋转、滚轮缩放、双击重置 |
| 动态连接 | 共激活记忆自动建连/强化（Hebbian）；**3 天无交互传输自动断开**；手动连接/断开（F5 按钮） |
| 对话前记忆注入 | 每次对话 turn 前自动把关键记忆注入系统提示；`DSH_HIPPOCAMPUS_PROMPT=0` 可关闭；注入日志（F9 按钮）可查看每轮注入的历史 |
| 注入日志（F9） | 记录每次对话前自动注入/工具调取/界面刷新的记忆包内容，透明展示 Agent 看到了哪些记忆 |
| 手动突触编辑（F5） | 在任意两个记忆之间显式建立或断开连接，权重可调，支持查看已有连接列表 |
| 演化日志（F6） | 展示自循环进化（合并/修剪/代际）的历史留痕，包含 epoch、generation、fitness 等指标 |
| 间隔重复复习 | 基于艾宾浩斯曲线（强度越高间隔越长），到期待复习记忆自动提醒，支持单条/批量复习强化 |
| 时间线视图 | 按时间倒序展示记忆创建、修改、归档、演化等事件的完整历史 |
| 标签管理 | 标签云展示（可折叠）、点击筛选、右键合并/重命名；支持批量操作 |
| 导入导出 | 导出全部活跃记忆为 Markdown 文本，支持从 Markdown 导入（自动去重合并） |
| 质量评分 | 每条记忆自动计算 0..1 质量分（完整性/清晰度/时效），卡片徽标展示优/中/低 |
| 每小时轨迹喂养 | 自动提炼会话轨迹写入「会话精华」分支；记忆页「喂养轨迹」按钮全量喂养 |
| 自动维护 | 记忆库上限 1GB 超限自动优化；过期记忆自动降权/归档/删除；活跃节点上限 1000 超出自动淘汰最弱 |
| 写入智能 | 自动去重合并（≥0.9 同种类强化原记忆）、自动生成高频词标签、与最相似记忆建立突触连接 |

## Agent 工具

`memory_write` · `memory_read` · `memory_search` · `memory_edit` · `memory_forget` · `memory_stats` · `memory_context` · `memory_evolve` · `memory_review`

## 配置

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_HIPPOCAMPUS_FEED_MS` | `3600000` | 轨迹喂养间隔（毫秒） |
| `DSH_HIPPOCAMPUS_SIZE_LIMIT` | `1073741824` | 记忆库上限（字节），超限自动优化 |
| `DSH_HIPPOCAMPUS_MAX_NODES` | `1000` | 活跃节点上限 |
| `DSH_HIPPOCAMPUS_PROMPT` | 开 | 设为 `0` 关闭对话前记忆注入 |
| `DSH_HIPPOCAMPUS_EVOLVE_MS` | `21600000` | 自动演化间隔（毫秒），默认 6h |

## License

MIT
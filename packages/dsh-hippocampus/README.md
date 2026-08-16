# dsh-hippocampus — 海马体记忆 Agent

DeepSeek Harness 插件：为 Agent 提供长期记忆能力 —— **3D 球形神经网络可视化**、跨工作区统一的记忆库、每小时轨迹自动喂养、以及**对话前自动注入**关键记忆。

仓库地址：https://gitee.com/yfj22011/dshmy

## 安装

```bash
git clone https://gitee.com/yfj22011/dshmy.git
cd dshmy/packages/dsh-hippocampus
node install.mjs
```

重启 DeepSeek Harness 后，在「对话 / 轨迹」之后出现「记忆」标签页。

## 功能

| 能力 | 说明 |
| --- | --- |
| 统一记忆库 | 所有记忆保存在同一记录（`$DSH_HOME/storages/hippocampus/memory.db`），**跨工作区目录打通**；旧版按项目分库的数据启动时自动合并 |
| 3D 球形神经网络 | 球心 = 偏好/交流核心节点（永不自动衰减）；第一层球面 = 工作区目录节点（与核心**永久连接**）；外球面 = 衍生记忆（按所属工作区方向扩散）；拖拽旋转、滚轮缩放、双击重置 |
| 动态连接 | 两节点交流（检索共激活）自动建连/强化（Hebbian）；**3 天无交互传输自动断开**；偏好/交流 ↔ 工作区目录为永久连接，除非用户主动归档工作区（右键节点） |
| 对话前记忆注入 | 每次对话 turn 前自动把关键记忆 + 最新工作状态注入系统提示；`DSH_HIPPOCAMPUS_PROMPT=0` 可关闭 |
| 每小时轨迹喂养 | 自动提炼会话轨迹（信号句 + 高频词）写入「会话精华」分支；「喂养轨迹」按钮全量喂养整个对话历史 |
| 自动维护 | 1GB 上限超限自动优化；过期记忆（>30 天）检索降权与清理；1000 节点上限自动淘汰最弱（工作状态/精华豁免） |
| 写入智能 | 自动去重合并（≥0.9 同种类）、自动高频词标签、与最相似记忆建立突触连接 |

## Agent 工具

`memory_write` · `memory_read` · `memory_search` · `memory_edit` · `memory_forget` · `memory_stats` · `memory_context` · `memory_evolve`

## 配置

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_HIPPOCAMPUS_FEED_MS` | `3600000` | 轨迹喂养间隔（毫秒） |
| `DSH_HIPPOCAMPUS_SIZE_LIMIT` | `1073741824` | 记忆库上限（字节），超限自动优化 |
| `DSH_HIPPOCAMPUS_MAX_NODES` | `1000` | 活跃节点上限 |
| `DSH_HIPPOCAMPUS_PROMPT` | 开 | 设为 `0` 关闭对话前记忆注入 |

## 架构

| 半边 | 文件 | 职责 |
| --- | --- | --- |
| 宿主端 | `lib/index.js` | 统一记忆库（SQLite-vec + bge 语义编码）、3D 图数据、突触/演化/清理、轨迹喂养调度、对话前记忆注入、记忆工具注册 |
| 浏览器端 | `lib/client.js` | 「记忆」标签页：3D 球形神经网络画布、分支列表/编辑、演化/修剪/喂养控制（自包含 bundle） |

## License

MIT

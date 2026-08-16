# dsh-hippocampus — 海马体记忆 Agent

DeepSeek Harness plugin: persistent long-term memory for agents, with a **3D spherical neural-network visualization**, a unified cross-workspace memory store, hourly trajectory feeding, and **pre-turn memory injection** into the model prompt.

仓库地址：https://gitee.com/yfj22011/mht

## 安装

```bash
git clone https://gitee.com/yfj22011/mht.git
cd mht/packages/dsh-hippocampus
node install.mjs
```

然后重启 DeepSeek Harness，在「对话 / 轨迹」之后出现「记忆」标签页。

发布到 DSH Hub 后也可直接：

```bash
npx -p @deepseek-ai/dsh dsh plugin --profile web add github:<你的用户名>/mht#<commit>
```

## 功能

| 能力 | 说明 |
| --- | --- |
| 统一记忆库 | 所有记忆在同一记录（`$DSH_HOME/storages/hippocampus/memory.db`），跨工作区目录打通；旧版按项目分库数据启动自动合并 |
| 3D 球形神经网络 | 球心=偏好/交流核心（永不衰减），第一层球面=工作区目录节点（与核心永久连接），外球面=衍生记忆；拖拽旋转、滚轮缩放、双击重置 |
| 动态连接 | 检索共激活自动建连/强化（Hebbian）；**3 天无交互自动断开**；偏好/交流↔工作区为永久连接（除非右键归档工作区） |
| 对话前记忆注入 | 每次对话 turn 前自动把关键记忆 + 工作状态注入系统提示（`DSH_HIPPOCAMPUS_PROMPT=0` 可关闭） |
| 每小时轨迹喂养 | 自动提炼会话轨迹（信号句+高频词）写入「会话精华」；记忆页「喂养轨迹」按钮全量喂养 |
| 自动维护 | 1GB 上限自动优化、过期记忆（>30 天）检索降权与清理、1000 节点上限自动淘汰最弱、启动即预加载 |

## Agent 工具

`memory_write` / `memory_read` / `memory_search` / `memory_edit` / `memory_forget` / `memory_stats` / `memory_context` / `memory_evolve`

## 配置

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_HIPPOCAMPUS_FEED_MS` | `3600000` | 轨迹喂养间隔（毫秒） |
| `DSH_HIPPOCAMPUS_SIZE_LIMIT` | `1073741824` | 记忆库上限（字节），超限自动优化 |
| `DSH_HIPPOCAMPUS_MAX_NODES` | `1000` | 活跃节点上限 |
| `DSH_HIPPOCAMPUS_PROMPT` | 开 | 设为 `0` 关闭对话前记忆注入 |

## License

MIT

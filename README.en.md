# dsh-hippocampus — Hippocampus Memory Agent

A DeepSeek Harness plugin that gives agents persistent long-term memory: **3D spherical neural-network visualization**, a unified cross-workspace memory store, hourly trajectory feeding, and automatic **pre-turn memory injection** into the model prompt.

Repository: https://gitee.com/yfj22011/dshmy

## Installation

```bash
git clone https://gitee.com/yfj22011/dshmy.git
cd dshmy/packages/dsh-hippocampus
node install.mjs
```

Restart DeepSeek Harness. A **记忆 (Memory)** tab appears after **对话 / 轨迹**.

## Features

| Capability | Description |
| --- | --- |
| Unified memory store | All memories live in one record (`$DSH_HOME/storages/hippocampus/memory.db`) — **shared across workspace directories**; legacy per-project stores are auto-merged at startup |
| 3D spherical neural network | Sphere center = preference/communication core nodes (never auto-decay); first sphere = workspace-directory nodes (one per workspace folder, **permanently linked** to every core); outer sphere = derived memories (spread by workspace direction). Drag = rotate, wheel = zoom, double-click = reset |
| Dynamic connections | Co-activated memories (retrieved together) build/strengthen links (Hebbian); links with **3 days of no transfer are auto-broken**; preference/communication ↔ workspace links are permanent unless the user explicitly archives the workspace (right-click a workspace node) |
| Pre-turn memory injection | Before every turn, the top memories (strength×0.6 + freshness×0.4) and the latest workstate are injected into the system prompt automatically; disable with `DSH_HIPPOCAMPUS_PROMPT=0` |
| Hourly trajectory feeding | The conversation trajectory is distilled automatically (signal sentences + high-frequency words) into a "会话精华" branch; the 喂养轨迹 button feeds the whole conversation history |
| Automatic maintenance | 1 GB store cap with over-limit auto-optimization (distill → delete stale → VACUUM); stale memories (>30 days) are down-weighted in retrieval and weak ones auto-archived/deleted; 1000-node cap auto-culls the weakest (workstate/精华 exempt) |
| Smart writes | Auto dedup (≥0.9 same-kind merges into the existing memory), auto high-frequency tags, synaptic links to the most similar memories |

## Agent Tools

`memory_write` · `memory_read` · `memory_search` · `memory_edit` · `memory_forget` · `memory_stats` · `memory_context` · `memory_evolve`

## Configuration

| Env | Default | Meaning |
| --- | --- | --- |
| `DSH_HIPPOCAMPUS_FEED_MS` | `3600000` | Trajectory feeding interval (ms) |
| `DSH_HIPPOCAMPUS_SIZE_LIMIT` | `1073741824` | Store size cap (bytes), auto-optimize when exceeded |
| `DSH_HIPPOCAMPUS_MAX_NODES` | `1000` | Active memory node cap |
| `DSH_HIPPOCAMPUS_PROMPT` | on | Set `0` to disable pre-turn memory injection |

## License

MIT

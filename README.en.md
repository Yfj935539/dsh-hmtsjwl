# dsh-hippocampus — Hippocampus Memory Agent

A DeepSeek Harness plugin that gives agents persistent long-term memory: **3D spherical neural-network visualization**, a unified cross-workspace memory store, hourly trajectory feeding, **automatic pre-turn memory injection**, **spaced repetition review**, **tag management with import/export**, and **injection/synapse/evolution log panels**.

Repository: https://github.com/Yfj935539/dsh-hmtsjwl

## Installation

```bash
git clone https://github.com/Yfj935539/dsh-hmtsjwl.git
cd dsh-hmtsjwl/packages/dsh-hippocampus
node install.mjs
```

Restart DeepSeek Harness. A **记忆 (Memory)** tab appears after **对话 / 轨迹**.

## Features

| Capability | Description |
| --- | --- |
| Unified memory store | All memories live in one record (`$DSH_HOME/storages/hippocampus/memory.db`) — **shared across workspace directories** |
| 3D spherical neural network | Sphere center = core nodes; outer sphere = derived memories. Drag to rotate, wheel to zoom, double-click to reset |
| Dynamic connections | Co-activated memories build/strengthen links (Hebbian); 3-day idle links auto-broken; manual link/unlink (F5 button) |
| Pre-turn memory injection | Top memories auto-injected into the system prompt before every turn. Toggle with `DSH_HIPPOCAMPUS_PROMPT=0` |
| Injection Log (F9) | Records every auto/tool/refresh memory injection, showing what the agent sees |
| Synapse Editor (F5) | Manually connect or disconnect any two memories with adjustable weight; view existing connections |
| Evolution Log (F6) | Displays evolution history (merge/prune/generation) including epoch, generation, fitness |
| Spaced Repetition Review | Ebbinghaus-curve-based review scheduling: due reminders, single/batch review reinforcement |
| Timeline View | Chronological event history of memory creation, modification, archiving, and evolution |
| Tag Management | Collapsible tag cloud, click-to-filter, right-click to merge/rename |
| Import/Export | Export all memories as Markdown; import from Markdown with auto-dedup |
| Quality Score | Auto-computed 0..1 quality score (completeness/clarity/freshness), displayed as Good/Medium/Low badge |
| Hourly trajectory feeding | Auto-distill conversation trajectory into "会话精华" branch; full-history feed button |
| Automatic maintenance | 1 GB cap with auto-optimization; stale memory down-weight/archive/delete; 1000-node cap with auto-cull |
| Smart writes | Auto-dedup (≥0.9 same-kind merge), auto tags, synaptic links to most similar memories |

## Agent Tools

`memory_write` · `memory_read` · `memory_search` · `memory_edit` · `memory_forget` · `memory_stats` · `memory_context` · `memory_evolve` · `memory_review`

## Configuration

| Env | Default | Meaning |
| --- | --- | --- |
| `DSH_HIPPOCAMPUS_FEED_MS` | `3600000` | Trajectory feeding interval (ms) |
| `DSH_HIPPOCAMPUS_SIZE_LIMIT` | `1073741824` | Store size cap (bytes), auto-optimize when exceeded |
| `DSH_HIPPOCAMPUS_MAX_NODES` | `1000` | Active memory node cap |
| `DSH_HIPPOCAMPUS_PROMPT` | on | Set `0` to disable pre-turn memory injection |
| `DSH_HIPPOCAMPUS_EVOLVE_MS` | `21600000` | Auto-evolution interval (ms), default 6h |

## License

MIT
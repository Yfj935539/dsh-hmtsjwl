# dsh-hippocampus

DeepSeek Harness plugin that gives agents persistent long-term memory with a **3D spherical neural-network visualization**, a unified cross-workspace memory store, hourly trajectory feeding, and automatic **pre-turn memory injection** into the model prompt.

Repo: https://gitee.com/yfj22011/mht

## Installation

```bash
git clone https://gitee.com/yfj22011/mht.git
cd mht/packages/dsh-hippocampus
node install.mjs
```

Or, once published to a DSH Hub–style registry:

```bash
npx -p @deepseek-ai/dsh dsh plugin --profile web add github:<yourname>/mht#<commit>
```

Then restart DeepSeek Harness. A **记忆 (Memory)** tab appears after **对话 / 轨迹**.

## Usage

The plugin registers memory tools and injects a compact memory pack into the system prompt before every turn:

| Tool | Purpose |
| --- | --- |
| `memory_write` | Write or update a memory (auto dedup ≥0.9, auto tags, synaptic links) |
| `memory_read` | Read memories by id / kind / keyword |
| `memory_search` | Hybrid retrieval: lexical + semantic vector + associative (synaptic) expansion |
| `memory_edit` | Correct/archive a memory (history recorded, vector re-embedded) |
| `memory_forget` | Archive (default) or hard-delete a memory |
| `memory_stats` | Memory health: counts, strength, synapses, epochs, size, feeding status |
| `memory_context` | Compact memory pack for long-session context refresh (anti context pollution) |
| `memory_evolve` | Merge near-duplicates, prune weak synapses, advance generation |

### Pre-turn memory injection

Before each model step, the plugin renders a dynamic prompt section (`hippocampus:memory`) with the top memories (strength×0.6 + freshness×0.4) and the latest workstate — no manual tool call needed. Disable with `DSH_HIPPOCAMPUS_PROMPT=0`.

### 3D spherical neural network

- **Core**: preference / communication memories at the sphere center (never decay).
- **Workspace ring**: one node per workspace directory, permanently linked to every core node (weight 0.55, exempt from TTL, decay and stale cleanup — unless the user explicitly archives the workspace via right-click).
- **Memory shell**: derived memories (workstate / insight / other) spread on the outer sphere by workspace direction.
- Interactions: drag = rotate, wheel = zoom, click = inspect, double-click = reset view.

### Dynamic connections

- Co-activated memories (retrieved together) strengthen their link (Hebbian).
- Links with no transfer for **3 days** are automatically broken (`LINK_TTL_DAYS`).
- Preference/communication ↔ workspace links are permanent.

### Automatic maintenance

- **Hourly trajectory feeding**: reads the current conversation trajectory (`sessionQuery.readSurface`) and distills key sentences + high-frequency words into a "会话精华" branch (full-history feeding via the 喂养轨迹 button).
- **1 GB size cap** per unified store: over-limit auto-optimization (distill → delete stale → VACUUM).
- **Stale memories (>30 days)**: retrieval down-weighting ×0.55 (core nodes exempt); weak stale memories auto-archived/deleted.
- **1000 node cap**: weakest nodes auto-culled (workstate/精华 exempt) via `DSH_HIPPOCAMPUS_MAX_NODES`.
- **Unified store**: all memories live in one SQLite+vector database (`$DSH_HOME/storages/hippocampus/memory.db`), shared across all workspace directories (old per-project stores are auto-merged once at startup).

### Configuration

| Env | Default | Meaning |
| --- | --- | --- |
| `DSH_HIPPOCAMPUS_FEED_MS` | `3600000` | Trajectory feeding interval (ms) |
| `DSH_HIPPOCAMPUS_SIZE_LIMIT` | `1073741824` | Store size cap (bytes), auto-optimize when exceeded |
| `DSH_HIPPOCAMPUS_MAX_NODES` | `1000` | Active memory node cap |
| `DSH_HIPPOCAMPUS_PROMPT` | (on) | Set `0` to disable pre-turn memory injection |

## Architecture

| Half | File | Responsibility |
| --- | --- | --- |
| Host | `lib/index.js` | `HippocampusDb` (SQLite-vec + bge-small-zh embedding + decay + hybrid retrieval + synapses + evolution), `hippocampus` Remote service, memory tools, prompt-section injection, hourly feeding scheduler |
| Browser | `lib/client.js` | 记忆 tab: 3D spherical neural-network canvas, branch list/editor, evolution/prune/feed controls (self-contained bundle) |

Storage: `$DSH_HOME/storages/hippocampus/memory.db` — `branches` (metadata), `memories` (vec0 embeddings), `links` (synapses), `workdirs` (workspace nodes), `meta`.

## License

MIT

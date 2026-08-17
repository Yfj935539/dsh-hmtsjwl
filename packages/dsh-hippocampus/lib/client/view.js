// 主视图：记忆标签页装配（数据加载 / 搜索 / 演化 / 列表 / 画布 / 面板）
const React = require("react");
const { useState, useEffect, useRef, useMemo, useCallback, Fragment, createElement: h } = React;
const { zh } = require("./i18n.js");
const { KIND_COLORS, KINDS, REASONS } = require("./constants.js");
const { remoteCall } = require("./remote.js");
const { GraphCanvas } = require("./components/canvas.js");
const { BranchCard, EditorModal } = require("./components/list.js");

// —— 模块级数据缓存：与轨迹/对话一致，数据预加载好，点开标签页直接展示 ——
// 切换会话/窗口重新挂载时复用，避免每次全量重取（list + graph）。
const MEM_CACHE = { branches: null, graph: null, meta: null, at: 0, loading: false };
const CACHE_FRESH_MS = 60 * 1000;

// 预加载：插件装载时（apply 内）后台拉取一次，首次点开即展示
function prefetchMemory(ctx) {
	if (MEM_CACHE.branches || MEM_CACHE.loading) return;
	MEM_CACHE.loading = true;
	Promise.all([
		remoteCall(ctx, "list", { includeArchived: true, scope: "unified" }),
		remoteCall(ctx, "graph", { scope: "unified" }).catch(() => ({ ok: false }))
	]).then(([listRes, graphRes]) => {
		if (listRes.ok) {
			MEM_CACHE.branches = listRes.value.branches ?? [];
			MEM_CACHE.meta = listRes.value.meta ?? null;
		}
		if (graphRes.ok) MEM_CACHE.graph = graphRes.value;
		MEM_CACHE.at = Date.now();
	}).finally(() => { MEM_CACHE.loading = false; });
}

function MemoryView(props) {
	const { t: tIn } = props;
	const t = (key) => (tIn ? tIn(key) : (zh[key] ?? key));
	const [branches, setBranches] = useState(MEM_CACHE.branches);
	const [graph, setGraph] = useState(MEM_CACHE.graph);
	const [meta, setMeta] = useState(MEM_CACHE.meta);
	const [loading, setLoading] = useState(!MEM_CACHE.branches);
	const [error, setError] = useState(null);
	const [search, setSearch] = useState("");
	const [kindFilter, setKindFilter] = useState(null);
	const [selectedId, setSelectedId] = useState(null);
	const [editing, setEditing] = useState(null);
	const [isNew, setIsNew] = useState(false);
	const [running, setRunning] = useState(true);
	const [toast, setToast] = useState(null);
	const [showTutorial, setShowTutorial] = useState(false);
	const [tagFilter, setTagFilter] = useState(null);
	const importRef = useRef(null);
	const toastTimer = useRef(null);

	const ctx = useMemo(() => props.__ctx ?? null, [props.__ctx]);

	// 统一记忆库：所有信息内容记忆在同一记录中，跨工作区目录打通。
	// 不再有 项目/全局 作用域切换；projectPath 仅用于显示当前工作目录。
	const [projectPath, setProjectPath] = useState(null);

	// 当前会话 id：优先框架注入（inject: (sessionId) => …），反射兜底
	const sessionIdOf = useCallback(() => {
		if (typeof props.sessionId === "string" && props.sessionId) return props.sessionId;
		try {
			const sessions = ctx?.reflect?.get("sessions", false);
			const info = sessions?.currentProvideInfo?.getSnapshot?.();
			return info?.sessionId ?? null;
		} catch { return null; }
	}, [ctx, props.sessionId]);

	// 初始化时解析当前会话的工作目录（cwd）用于展示；
	// 解析链：① 宿主端权威解析（sessionQuery.readSession → header.cwd）
	//        ② 反射兜底（修正 getSnapshot 链）③ 5 秒后重试一次（启动绑定）
	useEffect(() => {
		let alive = true;
		let tried = false;
		const resolve = async () => {
			try {
				// ① 宿主端权威解析
				const sid = sessionIdOf();
				if (sid) {
					const res = await remoteCall(ctx, "resolveProject", { sessionId: sid });
					if (res.ok && typeof res.value?.cwd === "string" && res.value.cwd) {
						if (alive) setProjectPath(res.value.cwd);
						return true;
					}
				}
			} catch { /* 走兜底 */ }
			try {
				// ② 反射兜底（hooks.session 是 HostObservable，需 getSnapshot()）
				const sessions = ctx?.reflect?.get("sessions", false);
				const info = sessions?.currentProvideInfo?.getSnapshot?.();
				const sessionObj = info?.hooks?.session;
				const cwd = sessionObj && typeof sessionObj.getSnapshot === "function"
					? sessionObj.getSnapshot()?.header?.cwd
					: sessionObj?.header?.cwd;
				if (typeof cwd === "string" && cwd) {
					if (alive) setProjectPath(cwd);
					return true;
				}
			} catch { /* 走回退 */ }
			return false;
		};
		void resolve();
		// ③ 启动/切换会话时若未就绪，5 秒后重试一次
		const retryTimer = setTimeout(() => {
			if (alive && !tried) {
				tried = true;
				void resolve();
			}
		}, 5000);
		return () => { alive = false; clearTimeout(retryTimer); };
	}, [ctx, sessionIdOf]);

	// 统一库请求参数：仅携带当前目录（供宿主端登记会话来源），不再区分作用域
	const scopeArgs = useMemo(() =>
		projectPath ? { scope: "unified", scopePath: projectPath } : { scope: "unified" },
	[projectPath]);

	const notify = useCallback((msg) => {
		setToast(msg);
		if (toastTimer.current) clearTimeout(toastTimer.current);
		toastTimer.current = setTimeout(() => setToast(null), 2600);
	}, []);

	const loadAll = useCallback(async (force) => {
		// 非强制且缓存新鲜：跳过全量重取（点开即展示，不重新跑一遍）
		if (!force && MEM_CACHE.branches && Date.now() - MEM_CACHE.at < CACHE_FRESH_MS) return;
		setLoading(true);
		setError(null);
		try {
			// 并行拉取列表与图（此前串行导致切换项目时加载明显变慢）
			const [listRes, graphRes] = await Promise.all([
				remoteCall(ctx, "list", { includeArchived: true, ...scopeArgs }),
				remoteCall(ctx, "graph", scopeArgs).catch(() => ({ ok: false }))
			]);
			if (!listRes.ok) throw new Error(listRes.error?.message ?? "list failed");
			setBranches(listRes.value.branches ?? []);
			setMeta(listRes.value.meta ?? null);
			if (graphRes.ok) setGraph(graphRes.value);
			// 写回模块级缓存，供其它会话/窗口点开即展示
			MEM_CACHE.branches = listRes.value.branches ?? [];
			MEM_CACHE.meta = listRes.value.meta ?? null;
			if (graphRes.ok) MEM_CACHE.graph = graphRes.value;
			MEM_CACHE.at = Date.now();
		} catch (err) {
			setError(String(err?.message ?? err));
		} finally {
			setLoading(false);
		}
	}, [ctx, scopeArgs]);

	// 挂载：缓存命中直接展示（无 loading）；未命中则拉取。仅执行一次。
	useEffect(() => {
		if (MEM_CACHE.branches) {
			setLoading(false);
			setError(null);
			// 缓存过期才静默后台刷新，避免每次打开重新跑一遍
			if (Date.now() - MEM_CACHE.at > CACHE_FRESH_MS) loadAll();
		} else {
			loadAll();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// projectPath 解析完成后，以正确的 scopePath 静默后台刷新（统一库数据一致）
	const lastPathRef = useRef(null);
	useEffect(() => {
		if (!projectPath || lastPathRef.current === projectPath) return;
		lastPathRef.current = projectPath;
		const timer = setTimeout(() => loadAll(), 0);
		return () => clearTimeout(timer);
	}, [projectPath, loadAll]);

	useEffect(() => { setSelectedId(null); }, [projectPath]);
	useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

	// 搜索输入变化 → 调用服务端真实三阶段检索（语义+词法+联想+突触共激活）
	// → 把【真实命中分数】与【真实共激活边】挂到画布。画布上的激活/脉冲/命中环都是这次检索
	// 的真实结果投射，而非客户端近似或装饰动画。
	const [graphHits, setGraphHits] = useState(null);
	useEffect(() => {
		const q = search.trim();
		if (!q) { setGraphHits(null); return; }
		const timer = setTimeout(async () => {
			try {
				const res = await remoteCall(ctx, "search", { q, limit: 12, ...scopeArgs });
				if (!res.ok) return;
				const hits = new Map((res.value?.results ?? []).map((r) => [String(r.branch?.id), Number(r.score ?? 0)]));
				const edges = (res.value?.signals?.edges ?? []).map((e) => ({ a: String(e.a), b: String(e.b), weight: Number(e.weight ?? 0) }));
				setGraphHits({ q: q.toLowerCase(), hits, edges, at: Date.now() });
			} catch { /* 检索失败忽略，画布保持静态真实投射 */ }
		}, 250);
		return () => clearTimeout(timer);
	}, [search, ctx, scopeArgs]);

	const saveBranch = useCallback(async (data) => {
		if (editing && !isNew) {
			const res = await remoteCall(ctx, "update", { id: editing.id, patch: data, by: "user", ...scopeArgs });
			if (!res.ok) throw new Error(res.error?.message ?? "update failed");
		} else {
			const res = await remoteCall(ctx, "create", { ...data, source: "user", ...scopeArgs });
			if (!res.ok) throw new Error(res.error?.message ?? "create failed");
			if (res.value?.dedup) notify("检测到相似记忆，已合并强化原记忆");
		}
		setEditing(null);
		notify(t("saved"));
		await loadAll(true);
	}, [ctx, editing, isNew, loadAll, notify, t, scopeArgs]);

	const archiveBranch = useCallback(async (branch) => {
		const res = await remoteCall(ctx, "update", { id: branch.id, patch: { status: branch.status === "active" ? "archived" : "active" }, by: "user", ...scopeArgs });
		if (!res.ok) return;
		notify(branch.status === "active" ? t("archived") : t("restored"));
		await loadAll(true);
	}, [ctx, loadAll, notify, t, scopeArgs]);

	const deleteBranch = useCallback(async (branch) => {
		if (!window.confirm(t("confirm.delete"))) return;
		const res = await remoteCall(ctx, "forget", { id: branch.id, hard: true, ...scopeArgs });
		if (!res.ok) return;
		notify(t("deleted"));
		if (selectedId === branch.id) setSelectedId(null);
		await loadAll(true);
	}, [ctx, loadAll, notify, selectedId, t, scopeArgs]);

	// 真实演化（宿主端合并近重复 + 修剪弱连接 + 代际推进）
	const evolve = useCallback(async () => {
		const res = await remoteCall(ctx, "evolve", scopeArgs);
		if (!res.ok) return;
		const v = res.value ?? {};
		notify(t("evolved") + "：合并 " + (v.merged ?? 0) + " · 修剪连接 " + (v.prunedLinks ?? 0) + " · Gen " + (v.meta?.generation ?? 0));
		setGraph(res.value);
		await loadAll(true);
	}, [ctx, loadAll, notify, t, scopeArgs]);

	// 真实修剪（宿主端归档弱且久的记忆）
	const prune = useCallback(async () => {
		const res = await remoteCall(ctx, "prune", scopeArgs);
		if (!res.ok) return;
		const v = res.value ?? {};
		notify(t("prunedDone") + "：归档 " + (v.pruned ?? 0) + " 条弱记忆 · 修剪连接 " + (v.prunedLinks ?? 0));
		setGraph(res.value);
		await loadAll(true);
	}, [ctx, loadAll, notify, t, scopeArgs]);

	// 仅切换画布内「弱连接隐藏」（E 键视觉开关）
	const [pruneTick, setPruneTick] = useState(0);
	const doPruneView = useCallback(() => {
		setPruneTick((v) => v + 1);
		notify("已隐藏弱连接（<0.3）；再次按 E 恢复显示");
	}, [notify]);

	// 轨迹喂养：把当前对话的「轨迹」内容（用户/助手/工具消息，
	// 与轨迹标签页同源）喂养到本项目记忆。手动点击 = 全量喂养整个对话历史；
	// 每小时定时任务自动增量喂养。显式携带 sessionId，确保命中当前会话轨迹。
	const feed = useCallback(async () => {
		const res = await remoteCall(ctx, "feed", { ...scopeArgs, sessionId: sessionIdOf(), sinceMs: 0 });
		if (!res.ok) { notify("喂养失败：" + (res.error?.message ?? "未知")); return; }
		const v = res.value ?? {};
		const detail = v.wrote
			? " → 写入「" + (v.title ?? "会话精华") + "」（" + (v.chars ?? 0) + " 字）"
			: v.reason
				? "（" + v.reason + "）"
				: "";
		notify("轨迹喂养：" + (v.fed ?? 0) + " 条事件" + detail + (v.size?.triggered ? " · 存储超限已自动优化" : ""));
		await loadAll(true);
	}, [ctx, loadAll, notify, scopeArgs]);

	// ---- v5 复习调度：间隔重复到期计算（与后端 reviewIntervalDays 同公式） ----
	// 注意：必须定义在 filtered 之前（filtered 会引用 showReviewOnly / dueIds）
	const REVIEW_DAY = 86400000;
	const reviewIntervalDays = useCallback((strength) => Math.min(28, Math.max(1, Math.round(1 + strength * 27))), []);
	const reviewDueAt = useCallback((b) => (b.lastAccessAt || b.updatedAt || b.createdAt || 0) + reviewIntervalDays(Number(b.strength) || 0.5) * REVIEW_DAY, [reviewIntervalDays]);
	const dueIds = useMemo(() => {
		const s = new Set();
		const ts = Date.now();
		for (const b of branches ?? []) {
			if (b.status !== "active") continue;
			if (reviewDueAt(b) <= ts) s.add(b.id);
		}
		return s;
	}, [branches, reviewDueAt]);
	const dueCount = dueIds.size;
	const [showReviewOnly, setShowReviewOnly] = useState(false);

	const filtered = useMemo(() => {
		if (!branches) return [];
		let list = branches.slice().sort((a, b) => {
			if (a.status !== b.status) return a.status === "active" ? -1 : 1;
			return b.updatedAt - a.updatedAt;
		});
		if (kindFilter) list = list.filter((b) => b.kind === kindFilter);
		if (tagFilter) list = list.filter((b) => (b.tags ?? []).includes(tagFilter));
		if (showReviewOnly) list = list.filter((b) => dueIds.has(b.id));
		if (search.trim()) {
			const q = search.trim().toLowerCase();
			list = list.filter((b) =>
				b.title.toLowerCase().includes(q) ||
				b.content.toLowerCase().includes(q) ||
				(b.tags ?? []).some((tag) => tag.toLowerCase().includes(q)));
		}
		return list;
	}, [branches, kindFilter, tagFilter, search, showReviewOnly, dueIds]);

	const activeCount = useMemo(() => (branches ?? []).filter((b) => b.status === "active").length, [branches]);
	const archivedCount = useMemo(() => (branches ?? []).filter((b) => b.status === "archived").length, [branches]);

	const stats = graph?.meta ?? meta ?? {};
	// 选中节点 —— 分支列表优先，工作区目录等图节点从 graph 解析
	const selectedNode = useMemo(() => {
		const b = (branches ?? []).find((x) => x.id === selectedId);
		if (b) return b;
		return (graph?.nodes ?? []).find((n) => n.id === selectedId) ?? null;
	}, [branches, graph, selectedId]);

	// 用户主动归档工作区目录（断开其全部连接，含偏好/交流永久连接）
	const archiveWorkdir = useCallback(async (workdirPath) => {
		const res = await remoteCall(ctx, "archiveWorkdir", { path: workdirPath });
		if (!res.ok) { notify("归档失败：" + (res.error?.message ?? "未知")); return; }
		notify("已归档工作区「" + (workdirPath.split(/[/\\]+/).filter(Boolean).pop() ?? workdirPath) + "」，连接已断开");
		await loadAll(true);
	}, [ctx, loadAll, notify]);

	// 节点度数（来自突触图）
	const degreeMap = useMemo(() => {
		const m = new Map();
		for (const e of graph?.edges ?? []) {
			m.set(e.a, (m.get(e.a) ?? 0) + 1);
			m.set(e.b, (m.get(e.b) ?? 0) + 1);
		}
		return m;
	}, [graph]);

	// 标签云：从分支数据统计（含归档），用于标签筛选与合并
	const tagCloud = useMemo(() => {
		const map = new Map();
		for (const b of branches ?? []) {
			for (const t of b.tags ?? []) {
				if (!t) continue;
				map.set(t, (map.get(t) ?? 0) + 1);
			}
		}
		return [...map.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count).slice(0, 30);
	}, [branches]);

	// 导出记忆为 Markdown 文件
	const onExport = useCallback(async () => {
		const res = await remoteCall(ctx, "exportAll", scopeArgs);
		if (!res.ok) { notify("导出失败：" + (res.error?.message ?? "未知")); return; }
		const text = res.value?.text ?? "";
		const count = (text.match(/^##\s/gm) ?? []).length;
		const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = "hippocampus-memory-" + new Date().toISOString().slice(0, 10) + ".md";
		a.click();
		URL.revokeObjectURL(url);
		notify("已导出 " + count + " 条记忆（.md）");
	}, [ctx, notify, scopeArgs]);

	// 导入记忆（Markdown/文本）
	const onImportFile = useCallback(async (e) => {
		const file = e.target?.files?.[0];
		if (e.target) e.target.value = "";
		if (!file) return;
		try {
			const text = await file.text();
			const res = await remoteCall(ctx, "importAll", { text, ...scopeArgs });
			if (!res.ok) { notify("导入失败：" + (res.error?.message ?? "未知")); return; }
			notify("导入完成：新增 " + (res.value?.imported ?? 0) + " · 去重合并 " + (res.value?.dedup ?? 0));
			await loadAll(true);
		} catch (err) {
			notify("导入失败：" + String(err?.message ?? err));
		}
	}, [ctx, loadAll, notify, scopeArgs]);

	// 合并/重命名标签
	const mergeTag = useCallback(async (tag) => {
		const to = window.prompt("把标签「" + tag + "」合并/重命名为：", tag);
		if (!to || to.trim() === tag) return;
		const res = await remoteCall(ctx, "tagRename", { from: tag, to: to.trim(), ...scopeArgs });
		if (!res.ok) { notify("合并失败：" + (res.error?.message ?? "未知")); return; }
		notify("已合并 " + (res.value?.renamed ?? 0) + " 条记忆的标签");
		await loadAll(true);
	}, [ctx, loadAll, notify, scopeArgs]);

	const [viewMode, setViewMode] = useState("list");
	const [timelineEvents, setTimelineEvents] = useState(null);
	// 标签云折叠：默认展开，过长时可收起为一行计数，释放左侧面板空间
	const [tagCloudOpen, setTagCloudOpen] = useState(true);
	// v5.2：头部「工具」下拉收纳（导出/导入/F9/F5/F6），减少顶栏拥挤
	const [toolsOpen, setToolsOpen] = useState(false);
	const toolsRef = useRef(null);
	// 批3：注入日志 / 手动连线 / 演化日志 面板
	const [showInjectLog, setShowInjectLog] = useState(false);
	const [injectLogData, setInjectLogData] = useState(null);
	const [showLinker, setShowLinker] = useState(false);
	const [linkA, setLinkA] = useState("");
	const [linkB, setLinkB] = useState("");
	const [linkWeight, setLinkWeight] = useState(0.6);
	const [linkRelations, setLinkRelations] = useState(null);
	const [showEvolog, setShowEvolog] = useState(false);
	const [evologData, setEvologData] = useState(null);

	// v5.2：点击工具下拉外部时关闭（轻量全局点击处理）
	useEffect(() => {
		if (!toolsOpen) return;
		const onDocClick = (e) => {
			if (toolsRef.current && !toolsRef.current.contains(e.target)) setToolsOpen(false);
		};
		document.addEventListener("pointerdown", onDocClick);
		return () => document.removeEventListener("pointerdown", onDocClick);
	}, [toolsOpen]);

	const INJECT_MODES = { auto: "对话前自动", tool: "工具调取", refresh: "界面刷新" };
	const fmtTime = useCallback((ts) => {
		if (!ts) return "";
		const d = new Date(ts);
		const p = (n) => String(n).padStart(2, "0");
		return (d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
	}, []);

	// 复习一条记忆
	const doReview = useCallback(async (id) => {
		const res = await remoteCall(ctx, "review", { id, ...scopeArgs });
		if (!res.ok) { notify("复习失败：" + (res.error?.message ?? "未知")); return; }
		notify("已复习强化：「" + (res.value?.title ?? "") + "」 强度 " + (res.value?.strength ?? 0).toFixed(2));
		await loadAll(true);
	}, [ctx, loadAll, notify, scopeArgs]);

	// 批量复习全部到期记忆
	const reviewAllDue = useCallback(async () => {
		if (dueIds.size === 0) return;
		let done = 0;
		for (const id of dueIds) {
			try { await remoteCall(ctx, "review", { id, ...scopeArgs }); done++; } catch { /* 单条失败继续 */ }
		}
		notify("已复习 " + done + "/" + dueIds.size + " 条到期记忆");
		setShowReviewOnly(false);
		await loadAll(true);
	}, [ctx, dueIds, loadAll, notify, scopeArgs]);

	// 切换时间线视图时拉取一次
	const loadTimeline = useCallback(async () => {
		if (timelineEvents) return;
		const res = await remoteCall(ctx, "timeline", { limit: 120, ...scopeArgs });
		if (res.ok) setTimelineEvents(res.value?.events ?? []);
	}, [ctx, scopeArgs, timelineEvents]);
	const toggleView = useCallback((mode) => {
		setViewMode(mode);
		if (mode === "timeline") loadTimeline();
	}, [loadTimeline]);

	// 注入日志面板：打开时拉取一次
	const openInjectLog = useCallback(async () => {
		setShowInjectLog(true);
		if (!injectLogData) {
			const res = await remoteCall(ctx, "injectLog", { limit: 80, ...scopeArgs });
			if (res.ok) setInjectLogData(res.value?.events ?? []);
		}
	}, [ctx, injectLogData, scopeArgs]);

	// 演化日志面板：打开时拉取一次
	const openEvolog = useCallback(async () => {
		setShowEvolog(true);
		if (!evologData) {
			const res = await remoteCall(ctx, "evolog", { limit: 60, ...scopeArgs });
			if (res.ok) setEvologData(res.value?.events ?? []);
		}
	}, [ctx, evologData, scopeArgs]);

	// 手动连线面板：打开时拉取选中记忆的既有连接
	const openLinker = useCallback(async () => {
		setShowLinker(true);
		const id = selectedId;
		if (id) {
			const res = await remoteCall(ctx, "linksOf", { id, ...scopeArgs }).catch(() => ({ ok: false }));
			if (res.ok) setLinkRelations(res.value?.links ?? null);
		}
	}, [ctx, selectedId, scopeArgs]);

	// 手动连接突触
	const doLink = useCallback(async () => {
		if (!linkA || !linkB || linkA === linkB) return;
		const res = await remoteCall(ctx, "linkManual", { a: linkA, b: linkB, weight: linkWeight, ...scopeArgs });
		if (!res.ok) { notify("连接失败：" + (res.error?.message ?? "未知")); return; }
		notify("已连接两记忆，权重 " + (res.value?.weight ?? linkWeight).toFixed(2));
		setShowLinker(false);
		await loadAll(true);
	}, [ctx, linkA, linkB, linkWeight, loadAll, notify, scopeArgs]);

	// 手动断开突触
	const doUnlink = useCallback(async () => {
		if (!linkA || !linkB || linkA === linkB) return;
		const res = await remoteCall(ctx, "unlinkManual", { a: linkA, b: linkB, ...scopeArgs });
		if (!res.ok) { notify("断开失败：" + (res.error?.message ?? "未知")); return; }
		notify(res.value?.unlinked ? "已断开两记忆间的连接" : "两记忆间原本无连接");
		setShowLinker(false);
		await loadAll(true);
	}, [ctx, linkA, linkB, loadAll, notify, scopeArgs]);

	// 左侧控制面板（图例 + 自学习 + 自演化 —— 真实数据与操作）
	const leftPanel = h("div", { className: "hp-left" },
		h("div", { className: "hp-panel" },
			h("div", { className: "hp-panel-title" },
				h("i", { style: { color: "#4fc3f7" } }),
				t("legend.title")),
			h("div", { className: "hp-legend" },
				KINDS.map((k) => h("div", { className: "hp-legend-row", key: k },
					h("span", { className: "hp-legend-dot", style: { background: KIND_COLORS[k] ?? KIND_COLORS.other, color: KIND_COLORS[k] ?? KIND_COLORS.other } }),
					t("kind." + k))),
				h("div", { className: "hp-legend-row", key: "workdir" },
					h("span", { className: "hp-legend-dot", style: { background: KIND_COLORS.workdir, color: KIND_COLORS.workdir } }),
					t("kind.workdir")),
				h("div", { className: "hp-legend-hint" },
					h("span", { className: "hp-legend-size" }),
					t("legend.activation")),
				h("div", { className: "hp-legend-hint" },
					h("span", { className: "hp-legend-size" }),
					t("legend.links")))),
		h("div", { className: "hp-panel" },
			h("div", { className: "hp-panel-title" },
				h("i", { style: { color: "#7fa8ff" } }),
				"连接含义"),
			h("div", { className: "hp-legend" },
				REASONS.map((r) => h("div", { className: "hp-legend-row", key: r.label },
					h("span", { className: "hp-legend-line", style: { background: r.color, color: r.color } }),
					r.label)))),
		h("div", { className: "hp-panel" },
			h("div", { className: "hp-panel-title hp-collapse", onClick: () => setTagCloudOpen((v) => !v), title: tagCloudOpen ? "折叠标签云" : "展开标签云" },
				h("i", { style: { color: "#ffd479" } }),
				"标签云 · 点击筛选 / 右键合并",
				h("span", { className: "hp-collapse-arrow" }, tagCloudOpen ? "▾" : "▸")),
			tagCloudOpen ? h("div", { className: "hp-tag-cloud" },
				tagCloud.length === 0 ? h("div", { className: "hp-legend-hint" }, "暂无标签") : null,
				tagCloud.map(({ tag, count }) => h("span", { key: tag, className: "hp-tag-chip", "data-on": tagFilter === tag || undefined, title: "点击筛选 · 右键合并", onClick: () => setTagFilter(tagFilter === tag ? null : tag), onContextMenu: (e) => { e.preventDefault(); mergeTag(tag); } }, tag + " " + count)))
				: null),
		h("div", { className: "hp-panel" },
			h("div", { className: "hp-panel-title" },
				h("i", { style: { color: "#81c784" } }),
				t("ctrl.learning.en")),
			h("span", { className: "hp-ctrl-status", "data-off": !running || undefined },
				running ? t("ctrl.active") : t("ctrl.paused")),
			h("div", { className: "hp-ctrl-row" }, h("span", null, t("ctrl.neurons")), h("b", null, String(stats.neurons ?? activeCount))),
			h("div", { className: "hp-ctrl-row" }, h("span", null, t("ctrl.synapses")), h("b", null, String(stats.connections ?? 0))),
			h("div", { className: "hp-ctrl-row" }, h("span", null, t("ctrl.fitness")), h("b", null, (stats.fitness ?? 0).toFixed(3))),
			h("div", { className: "hp-ctrl-btns" },
				h("button", { className: "hp-btn", onClick: () => setRunning((r) => !r) }, t("ctrl.toggle")))),
		// 小白教程：置于「开关学习」按钮下方，解释工具是什么/能力/做了什么/为什么
		h("button", { className: "hp-tut-toggle", onClick: () => setShowTutorial((v) => !v) }, (showTutorial ? "▾ " : "▸ ") + "📖 小白教程"),
		showTutorial ? h("div", { className: "hp-tut" },
			h("div", { className: "hp-tut-item" }, h("b", null, "这是什么："), "海马体记忆是 Agent 的「长期记忆」插件，像大脑的海马体一样把信息沉淀下来。"),
			h("div", { className: "hp-tut-item" }, h("b", null, "执行什么能力："), "「记忆」标签页 + memory_write/read/search/edit/forget 等工具 + 3D 神经网络可视化 + 自学习/自演化。"),
			h("div", { className: "hp-tut-item" }, h("b", null, "做了什么："), "每条记忆是一个神经元，相关记忆自动连线（突触）；搜索时相关节点点亮、无关变暗；定期合并重复、修剪弱连接。"),
			h("div", { className: "hp-tut-item" }, h("b", null, "为什么要这样："), "模型本身不记得上次对话；把关键信息存下来并在需要时自动注入，Agent 才能记住你的偏好与项目进度，避免重复提问和上下文污染。"))
			: null,
		h("div", { className: "hp-panel" },
			h("div", { className: "hp-panel-title" },
				h("i", { style: { color: "#ba68c8" } }),
				t("ctrl.evolution.en")),
			h("div", { className: "hp-ctrl-row" }, h("span", null, t("ctrl.gen")), h("b", null, String(stats.generation ?? 0))),
			h("div", { className: "hp-ctrl-row" }, h("span", null, t("ctrl.merged")), h("b", null, String(stats.merged ?? 0))),
			h("div", { className: "hp-ctrl-row" }, h("span", null, t("ctrl.pruned")), h("b", null, String(stats.pruned ?? 0))),
			h("div", { className: "hp-ctrl-btns" },
				h("button", { className: "hp-btn hp-btn-primary", onClick: () => { evolve(); } }, t("ctrl.evolve")),
				h("button", { className: "hp-btn", onClick: () => { prune(); } }, t("ctrl.pruneWeak")),
				h("button", { className: "hp-btn", onClick: () => { feed(); } }, t("btn.feed")),
				h("button", { className: "hp-btn", onClick: doPruneView }, t("ctrl.prune")))));

	return h("div", { className: "hp-root" },
			h("div", { className: "hp-header" },
				h("div", { className: "hp-scope", style: { display: "flex", alignItems: "center", gap: "8px", background: "var(--dsw-alias-bg-elevated,#0e1420)", border: "1px solid var(--dsw-alias-border-l2,#232b3a)", borderRadius: "10px", padding: "5px 12px" } },
					h("span", { style: { fontSize: "13px", fontWeight: 600, color: "var(--dsw-alias-label-primary,#e6edf3)" } }, "🧠 " + t("view.memory")),
					h("span", { style: { fontSize: "9px", color: "#5b6472", fontFamily: "ui-monospace,Menlo,monospace" } }, "UNIFIED"),
					projectPath ? h("span", { title: projectPath, style: { fontSize: "10px", color: "var(--dsw-alias-label-tertiary,#7d8590)", maxWidth: "180px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, "📁 " + projectPath.split(/[/\\]+/).pop() ?? "") : null),
				h("div", { className: "hp-stats" },
					h("div", { className: "hp-stat" }, h("span", { className: "hp-stat-v" }, String(stats.neurons ?? activeCount)), h("span", { className: "hp-stat-k" }, t("stats.neurons"))),
					h("div", { className: "hp-stat" }, h("span", { className: "hp-stat-v" }, String(stats.connections ?? 0)), h("span", { className: "hp-stat-k" }, t("stats.connections"))),
					h("div", { className: "hp-stat" }, h("span", { className: "hp-stat-v" }, Number(stats.activation ?? stats.fitness ?? 0).toFixed(2)), h("span", { className: "hp-stat-k" }, t("stats.activation"))),
					h("div", { className: "hp-stat" }, h("span", { className: "hp-stat-v" }, String(stats.epoch ?? 1)), h("span", { className: "hp-stat-k" }, t("stats.epoch"))),
					h("div", { className: "hp-stat" }, h("span", { className: "hp-stat-v" }, String(stats.fitness ?? 0)), h("span", { className: "hp-stat-k" }, t("stats.fitness")))),
				h("input", { className: "hp-search", placeholder: t("search.placeholder"), value: search, onChange: (e) => setSearch(e.target.value) }),
				h("div", { className: "hp-chips" },
					h("button", { className: "hp-chip", "data-on": kindFilter === null || undefined, onClick: () => setKindFilter(null) }, t("filter.all")),
					KINDS.map((k) => h("button", { className: "hp-chip", "data-on": kindFilter === k || undefined, key: k, onClick: () => setKindFilter(kindFilter === k ? null : k) }, t("kind." + k)))),
				h("button", { className: "hp-btn hp-btn-primary", onClick: () => { setIsNew(true); setEditing({}); } }, t("btn.new")),
				dueCount > 0 ? h("button", { className: "hp-btn hp-review", "data-on": showReviewOnly || undefined, onClick: () => setShowReviewOnly((v) => !v), title: "间隔重复到期待复习" }, "待复习 " + dueCount) : null,
				h("button", { className: "hp-btn", onClick: loadAll }, t("btn.refresh")),
				// v5.2：次要工具收纳进「工具」下拉（导出/导入/F9/F5/F6），顶栏不再拥挤
				h("div", { className: "hp-tools", ref: toolsRef },
					h("button", { className: "hp-btn" + (toolsOpen ? " hp-btn-primary" : ""), onClick: () => setToolsOpen((v) => !v), title: "导出/导入/注入日志/手动连线/演化日志" }, "⚙ 工具 " + (toolsOpen ? "▾" : "▸")),
					toolsOpen ? h("div", { className: "hp-tools-menu" },
						h("button", { className: "hp-tools-item", onClick: () => { setToolsOpen(false); onExport(); } }, "⬇ 导出 .md"),
						h("button", { className: "hp-tools-item", onClick: () => { setToolsOpen(false); importRef.current?.click(); } }, "⬆ 导入 .md"),
						h("button", { className: "hp-tools-item", onClick: () => { setToolsOpen(false); openInjectLog(); } }, "F9 · 注入日志"),
						h("button", { className: "hp-tools-item", onClick: () => { setToolsOpen(false); openLinker(); }, disabled: !selectedId }, "F5 · 手动连线" + (selectedId ? "" : "（需选中）")),
						h("button", { className: "hp-tools-item", onClick: () => { setToolsOpen(false); openEvolog(); } }, "F6 · 演化日志"))
						: null),
				h("input", { ref: importRef, type: "file", accept: ".md,.markdown,.txt,text/markdown,text/plain", style: { display: "none" }, onChange: onImportFile })),
			h("div", { className: "hp-body" },
			loading
				? h("div", { className: "hp-loading", style: { flex: 1 } }, t("loading"))
				: error
					? h("div", { className: "hp-error", style: { flex: 1 } }, t("error") + " " + error)
					: h(Fragment, null,
						leftPanel,
						h(GraphCanvas, {
							graph: graph ?? { nodes: [], edges: [], meta: {} },
							selectedId,
							selectedNode,
							onSelect: (id) => {
								setSelectedId(id);
								const el = document.querySelector(".hp-card[data-id=\"" + id + "\"]");
								el?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
							},
							onReset: () => { },
							onEvolve: () => { evolve(); },
							onPrune: doPruneView,
							running,
							setRunning,
							t,
							empty: activeCount === 0,
							pruneSignal: pruneTick,
							searchQuery: search,
							searchHits: graphHits,
							onArchiveWorkdir: archiveWorkdir
						}),
							h("div", { className: "hp-list" },
								archivedCount > 0 ? h("div", { className: "hp-card-meta", style: { padding: "0 4px" } }, "活跃 " + activeCount + " · 归档 " + archivedCount) : null,
								filtered.map((branch) => h(BranchCard, {
									key: branch.id,
									branch,
									selected: branch.id === selectedId,
									degree: degreeMap.get(branch.id) ?? 0,
									due: branch.status === "active" && dueIds.has(branch.id),
									onSelect: setSelectedId,
									onEdit: (b) => { setIsNew(false); setEditing(b); },
									onArchive: archiveBranch,
									onRestore: archiveBranch,
									onDelete: deleteBranch,
									t
								})),
								filtered.length === 0 ? h("div", { className: "hp-loading" }, t("empty.title")) : null))),
			editing ? h(EditorModal, {
				branch: isNew ? null : editing,
				isNew,
				onSave: saveBranch,
				onClose: () => { setEditing(null); setIsNew(false); },
				t
			}) : null,
			toast ? h("div", { className: "hp-toast" }, toast) : null,
			// F9：注入日志模态框
			showInjectLog ? h("div", { className: "hp-modal", onClick: () => setShowInjectLog(false) },
				h("div", { className: "hp-modal-box", onClick: (e) => e.stopPropagation() },
					h("div", { className: "hp-modal-title" }, "F9 注入日志（对话前自动/工具/刷新）"),
					h("div", { className: "hp-inject-log" },
						injectLogData ? injectLogData.map((e) =>
							h("div", { key: e.id, className: "hp-log-row" },
								h("span", { className: "hp-log-time" }, fmtTime(e.ts)),
								h("span", { className: "hp-log-mode", "data-mode": e.mode }, INJECT_MODES[e.mode] ?? e.mode),
								h("span", { className: "hp-log-count" }, e.count + " 条"),
								h("span", { className: "hp-log-chars" }, e.chars + " 字"),
								e.title ? h("span", { className: "hp-log-title" }, e.title) : null
							)
						) : h("div", { className: "hp-loading" }, "加载中…")))) : null,
			// F5：手动突触连接/断开模态框
			showLinker ? h("div", { className: "hp-modal", onClick: () => setShowLinker(false) },
				h("div", { className: "hp-modal-box", onClick: (e) => e.stopPropagation() },
					h("div", { className: "hp-modal-title" }, "F5 手动突触编辑（连接/断开）"),
					h("div", { className: "hp-field" },
						h("label", null, "记忆 A id"),
						h("input", { className: "hp-input", type: "text", value: linkA, onChange: (e) => setLinkA(e.target.value), placeholder: selectedId ? selectedId : "输入记忆 id" })),
					h("div", { className: "hp-field" },
						h("label", null, "记忆 B id"),
						h("input", { className: "hp-input", type: "text", value: linkB, onChange: (e) => setLinkB(e.target.value), placeholder: "输入记忆 id" })),
					h("div", { className: "hp-field" },
						h("label", null, "连接权重 " + linkWeight.toFixed(2)),
						h("input", { className: "hp-range", type: "range", min: "0.05", max: "1", step: "0.05", value: linkWeight, onChange: (e) => setLinkWeight(parseFloat(e.target.value)) }),
						h("span", { className: "hp-range-val" }, linkWeight.toFixed(2))),
					linkRelations && linkRelations.length > 0 ? h("div", { className: "hp-field" },
						h("label", null, "当前连接（" + selectedId + "）"),
						h("div", { className: "hp-link-list" },
							linkRelations.map((l) => h("span", { key: l.other, className: "hp-link-item", onClick: () => l.other === linkA ? setLinkB(l.other) : setLinkA(l.other), title: "点击填入 " + l.title }, l.title + " (" + l.weight.toFixed(2) + ")")))) : null,
					h("div", { className: "hp-modal-actions" },
						h("button", { className: "hp-btn hp-btn-primary", onClick: doLink, disabled: !linkA || !linkB || linkA === linkB }, "建立连接"),
						h("button", { className: "hp-btn", onClick: doUnlink, disabled: !linkA || !linkB || linkA === linkB }, "断开连接"),
						h("button", { className: "hp-btn", onClick: () => setShowLinker(false) }, "取消")))) : null,
			// F6：演化日志模态框
			showEvolog ? h("div", { className: "hp-modal", onClick: () => setShowEvolog(false) },
				h("div", { className: "hp-modal-box", onClick: (e) => e.stopPropagation() },
					h("div", { className: "hp-modal-title" }, "F6 演化日志（自循环进化历史）"),
					h("div", { className: "hp-evolog-list" },
						evologData ? evologData.map((e) =>
							h("div", { key: e.id, className: "hp-evolog-row" },
								h("div", { className: "hp-evolog-head" },
									h("span", { className: "hp-evolog-epoch" }, "Epoch " + e.epoch + " · Gen " + e.generation),
									h("span", { className: "hp-evolog-time" }, fmtTime(e.ts))),
								h("div", { className: "hp-evolog-stats" },
									h("span", null, "合并: " + e.merged),
									h("span", null, "修剪: " + e.prunedLinks),
									h("span", null, "fitness: " + (e.fitnessAfter ?? 0).toFixed(3)),
									h("span", null, "lr: " + (e.lr ?? 0.01).toFixed(3)))
							)
						) : h("div", { className: "hp-loading" }, "加载中…")))) : null
		);
}

exports.MemoryView = MemoryView;
exports.prefetchMemory = prefetchMemory;
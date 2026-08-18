// 海马体记忆 Agent —— 浏览器半边（client half）v5.2
// 由 lib/client/ 多模块源码打包生成（DSH 模块系统要求每插件单一 bundle）
// 重新生成：node scripts/build-client.mjs
window.__ModuleLoader__.load({
	id: "@local/dsh-hippocampus",
	factory: (__platformRequire) => {
		var __modules = {
      "components/canvas.js": function (module, exports, require) {
// 3D 神经网络可视化画布组件（GraphCanvas）
const React = require("react");
const { useState, useEffect, useRef, useMemo, useCallback, createElement: h } = React;
const { buildSim } = require("../sim.js");
const { rotate3 } = require("../sim.js");
const { draw } = require("../draw.js");

function GraphCanvas({ graph, selectedId, selectedNode, onSelect, onReset, onEvolve, onPrune, running, setRunning, t, empty, pruneSignal, searchQuery, searchHits, onArchiveWorkdir, focusMode, onToggleFocus, anchors }) {
	const canvasRef = useRef(null);
	const wrapRef = useRef(null);
	const simRef = useRef(null);
	const sizeRef = useRef({ w: 0, h: 0 });
	const fpsRef = useRef({ frames: 0, last: performance.now(), fps: 0 });
	// 滚轮缩放（0.35x ~ 3.5x），围绕画布中心
	const zoomRef = useRef(1);
	const [zoom, setZoom] = useState(1);
	// 相机：聚焦缓动动画 + 惯性滑行，让旋转与聚焦都平滑稳定
	const camRef = useRef({ focus: null, velX: 0, velY: 0, dragging: false });

	// 把服务端真实检索结果（命中分数 + 真实共激活边）挂到 sim
	useEffect(() => {
		if (simRef.current) simRef.current.searchHits = searchHits;
	}, [searchHits]);

	// v5.4：激活锚点经 ref 传递（避免 rAF tick 依赖数组重建）
	const anchorsRef = useRef(anchors);
	useEffect(() => { anchorsRef.current = anchors; }, [anchors]);

	const onWheel = (e) => {
		e.preventDefault();
		const next = Math.min(3.5, Math.max(0.35, zoomRef.current * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
		zoomRef.current = next;
		camRef.current.focus = null; // 打断聚焦动画
		setZoom(next);
	};

	useEffect(() => {
		simRef.current = buildSim(graph, simRef.current);
	}, [graph]);

	useEffect(() => {
		const sim = simRef.current;
		if (sim) sim.prune = !sim.prune;
	}, [pruneSignal]);

	useEffect(() => {
		const wrap = wrapRef.current;
		const canvas = canvasRef.current;
		if (!wrap || !canvas) return;
		const ro = new ResizeObserver(() => {
			const rect = wrap.getBoundingClientRect();
			sizeRef.current = { w: rect.width, h: rect.height - 26 };
			const dpr = Math.min(2, window.devicePixelRatio || 1);
			canvas.width = Math.max(1, Math.floor(rect.width * dpr));
			canvas.height = Math.max(1, Math.floor((rect.height - 26) * dpr));
			canvas.style.width = rect.width + "px";
			canvas.style.height = (rect.height - 26) + "px";
		});
		ro.observe(wrap);
		return () => ro.disconnect();
	}, []);

	// 平滑聚焦：把节点转到画面正前方（缓动动画，先快后慢）
	const focusOn = useCallback((id) => {
		const sim = simRef.current;
		const cam = camRef.current;
		if (!sim) return;
		const node = sim.nodes.find((n) => n.id === id);
		if (!node) return;
		const x = node.x, y = node.y, z = node.z;
		const z1 = Math.sqrt(x * x + z * z) || 1e-6;
		cam.focus = {
			t0: performance.now(), dur: 700,
			fx: sim.rotX, fy: sim.rotY, fz: zoomRef.current,
			tx: Math.atan2(y, z1), ty: Math.atan2(-x, z),
			tz: Math.max(zoomRef.current, 1.15)
		};
		cam.velX = 0; cam.velY = 0; cam.dragging = false;
	}, []);

	// 复位相机（双击 / 复位视图）
	const resetCam = useCallback(() => {
		const sim = simRef.current;
		const cam = camRef.current;
		if (!sim) return;
		cam.focus = {
			t0: performance.now(), dur: 700,
			fx: sim.rotX, fy: sim.rotY, fz: zoomRef.current,
			tx: -0.35, ty: 0.6, tz: 1
		};
		cam.velX = 0; cam.velY = 0;
	}, []);

	// 选中节点（画布点击 / 列表点击）→ 平滑聚焦到该点
	useEffect(() => {
		if (selectedId) focusOn(selectedId);
	}, [selectedId, focusOn]);

	useEffect(() => {
		let raf = 0;
		const tick = () => {
			const sim = simRef.current;
			const cam = camRef.current;
			const fps = fpsRef.current;
			fps.frames++;
			const elapsed = performance.now() - fps.last;
			if (elapsed >= 500) {
				fps.fps = Math.round(fps.frames / (elapsed / 1000));
				fps.frames = 0;
				fps.last = performance.now();
			}
			if (sim) {
				sim.t += 1;
				// 真实联通投射：节点能量基础 = 真实 strength（无随机注入）
				// 搜索态：命中节点能量拉升到【真实检索分数】
				const sr = sim.searchHits;
				const activeQ = searchQuery && searchQuery.trim() ? searchQuery.trim().toLowerCase() : null;
				const hasSignal = !!(sr && activeQ && sr.q === activeQ);
				// 相机：聚焦缓动（easeOutCubic）+ 释放后惯性滑行
				if (cam.focus) {
					const f = cam.focus;
					const k = Math.min(1, (performance.now() - f.t0) / f.dur);
					const e = 1 - Math.pow(1 - k, 3);
					if (k >= 1) {
						sim.rotX = f.tx; sim.rotY = f.ty;
						zoomRef.current = f.tz; setZoom(f.tz);
						cam.focus = null;
					} else {
						sim.rotX = f.fx + (f.tx - f.fx) * e;
						sim.rotY = f.fy + (f.ty - f.fy) * e;
						zoomRef.current = f.fz + (f.tz - f.fz) * e;
					}
					sim.rotX = Math.max(-1.55, Math.min(1.55, sim.rotX));
				} else if (!cam.dragging && (Math.abs(cam.velX) > 1e-4 || Math.abs(cam.velY) > 1e-4)) {
					sim.rotY += cam.velX;
					sim.rotX = Math.max(-1.55, Math.min(1.55, sim.rotX + cam.velY));
					cam.velX *= 0.9;
					cam.velY *= 0.9;
				} else if (!cam.dragging && sim.running && !hasSignal) {
					// v5.2 空闲自转：无交互/无检索时球体以极慢速度自转，
					// 让深度/透视在静止状态下持续可见 —— 消除「二维贴图感」
					sim.rotY += 0.00055;
				}
				// 3D 球形无物理布局：坐标由宿主端 x0/y0/z0 给出，动画在下方呼吸/能量逻辑中执行
				// v5.2 修复能量衰减：非搜索态能量向「真实强度基线」收敛（不衰减到全黑）；
				// 搜索态命中拉升到真实分数，未命中冷却到基线半亮 —— 画布始终可读、反映真实数据
				for (const node of sim.nodes) {
					const base = node.base ?? node.strength ?? 0.4;
					if (hasSignal) {
						const sc = sr.hits.get(node.id);
						if (typeof sc === "number") node.energy = Math.min(1, Math.max(node.energy, 0.3 + sc * 0.7));
						else node.energy += ((base * 0.5) - node.energy) * 0.05;
					} else {
						node.energy += (base - node.energy) * 0.02;
					}
					node.energy = Math.max(0, Math.min(1, node.energy));
				}
				if (sim.running && hasSignal) {
					for (const e of sim.edges) {
						const a = sim.nodes.find((x) => x.id === e.a);
						const b = sim.nodes.find((x) => x.id === e.b);
						if (!a || !b) continue;
						const flow = (a.energy - b.energy) * 0.08 * e.weight;
						a.energy -= flow;
						b.energy += flow;
					}
				}
				// 3D 呼吸动画（球体轻微脉动，仅视觉装饰，保持活性但不杂乱）
				if (sim.running) {
					for (const node of sim.nodes) {
						const amp = 0.012 + node.energy * 0.02;
						node.x = node.x0 + Math.sin(sim.t * 0.002 + node.phase) * amp;
						node.y = node.y0 + Math.cos(sim.t * 0.0021 + node.phase) * amp;
						node.z = node.z0 + Math.sin(sim.t * 0.0018 + node.phase * 1.3) * amp;
					}
				}
				draw(canvasRef.current, sim, selectedId, sizeRef.current, searchQuery && searchQuery.trim() ? searchQuery.trim() : null, {
					rotX: sim.rotX, rotY: sim.rotY, zoom: zoomRef.current, dragging: cam.dragging
				}, anchorsRef.current);
			}
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [selectedId, searchQuery]);

	useEffect(() => {
		const onKey = (e) => {
			if (document.querySelector(".hp-modal") !== null) return;
			const tag = e.target?.tagName;
			if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
			if (e.code === "Space") {
				e.preventDefault();
				setRunning((r) => !r);
			} else if (e.key === "f" || e.key === "F") {
				onEvolve();
			} else if (e.key === "e" || e.key === "E") {
				onPrune();
			} else if (e.key === "Escape" && focusMode) {
				onToggleFocus();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onEvolve, onPrune, setRunning, focusMode, onToggleFocus]);

	// 3D 命中：投影后按屏幕距离判定（v5.2：命中半径随 zoom 缩放，与渲染一致）
	const hitTest = useCallback((sim, cx, cy) => {
		const rect = canvasRef.current?.getBoundingClientRect();
		if (!rect) return null;
		const w = rect.width;
		const h = Math.max(1, rect.height - 26);
		const scale = Math.min(w, h) * 0.46 * (zoomRef.current || 1);
		const fov = 2.1;
		let best = null;
		let bestD = Infinity;
		for (const node of sim.nodes) {
			const r3 = rotate3(node.x, node.y, node.z, sim.rotX, sim.rotY);
			const depth = fov + r3.z;
			const k = scale / depth;
			const sx = w / 2 + r3.x * k;
			const sy = h / 2 - r3.y * k;
			const px = (cx - rect.left);
			const py = (cy - rect.top);
			const d = Math.sqrt((sx - px) * (sx - px) + (sy - py) * (sy - py));
			const hitR = Math.max(8, node.r * 1.8 * (k / (scale / fov)) * (zoomRef.current || 1));
			if (d < hitR && d < bestD) {
				bestD = d;
				best = node;
			}
		}
		return best;
	}, []);

	const pointer = useRef(null);
	const onPointerDown = (e) => {
		const sim = simRef.current;
		if (!sim) return;
		const cam = camRef.current;
		cam.focus = null; // 打断聚焦动画
		cam.dragging = false;
		const hit = hitTest(sim, e.clientX, e.clientY);
		const rect = canvasRef.current?.getBoundingClientRect();
		pointer.current = { x: e.clientX, y: e.clientY, moved: false, hit };
		if (sim.mouse) sim.mouse = { x: e.clientX - (rect?.left || 0), y: e.clientY - (rect?.top || 0), inside: true };
		// 命中节点：记录待选中；空白处：进入球体旋转
		if (!hit) {
			canvasRef.current?.setPointerCapture?.(e.pointerId);
		}
	};
	const onPointerMove = (e) => {
		const sim = simRef.current;
		if (!sim) return;
		const rect = canvasRef.current?.getBoundingClientRect();
		const mx = e.clientX - (rect?.left || 0);
		const my = e.clientY - (rect?.top || 0);
		if (sim.mouse) sim.mouse = { x: mx, y: my, inside: true };
		const cam = camRef.current;
		const down = pointer.current;
		if (down && down.moved === false) {
			const dx = e.clientX - down.x;
			const dy = e.clientY - down.y;
			if (dx * dx + dy * dy > 16) down.moved = true;
		}
		if (down && !down.hit && down.moved) {
			// 空白拖拽 = 3D 球体旋转（带惯性速度）
			const dx = (e.clientX - down.x) * 0.005;
			const dy = (e.clientY - down.y) * 0.005;
			cam.velX = dx;
			cam.velY = dy;
			sim.rotY += dx;
			sim.rotX = Math.max(-1.55, Math.min(1.55, sim.rotX + dy));
			down.x = e.clientX;
			down.y = e.clientY;
			cam.dragging = true;
			sim.hover = null;
			return;
		}
		const hit = hitTest(sim, e.clientX, e.clientY);
		sim.hover = hit?.id ?? null;
	};
	const onPointerUp = (e) => {
		const sim = simRef.current;
		if (!sim) return;
		const cam = camRef.current;
		const moved = pointer.current?.moved === true;
		const hit = pointer.current?.hit ?? null;
		if (cam) cam.dragging = false; // 松开后由惯性滑行收尾
		if (!moved && hit) onSelect(hit.id);
		pointer.current = null;
	};
	const onPointerLeave = () => {
		const sim = simRef.current;
		if (sim?.mouse) sim.mouse.inside = false;
		if (sim) sim.hover = null;
	};
	const onContextMenu = (e) => {
		e.preventDefault();
		const sim = simRef.current;
		if (!sim) return;
		const hit = hitTest(sim, e.clientX, e.clientY);
		// 右键工作区目录节点 → 主动归档（断开其全部连接，含偏好/交流永久连接）
		if (hit && hit.type === "workdir") {
			if (window.confirm(t("confirm.archiveWdir", { t: hit.title }))) {
				onArchiveWorkdir?.(hit.workdir);
			}
			return;
		}
		onSelect(null);
	};
	const onDoubleClick = () => {
		resetCam();
		onSelect(null);
		onReset?.();
	};

	const fps = fpsRef.current?.fps ?? 0;
	const m = graph?.meta ?? {};
	const sel = selectedNode ?? null;

	return h("div", { className: "hp-canvas-wrap" + (focusMode ? " hp-canvas-full" : ""), ref: wrapRef, style: { position: "relative" } },
		h("canvas", { className: "hp-canvas", ref: canvasRef, onPointerDown, onPointerMove, onPointerUp, onPointerLeave, onContextMenu, onDoubleClick, onWheel }),
		// v5.3：全屏专注模式的退出按钮（右上角悬浮，Esc 亦可）
		focusMode ? h("button", { className: "hp-exit-focus", onClick: () => onToggleFocus?.() }, t("exit.fullscreen")) : null,
		empty ? h("div", { className: "hp-empty-overlay", style: { bottom: 26 } },
			h("div", { style: { fontSize: 20, opacity: 0.5 } }, "🧠"),
			h("div", { style: { fontSize: 13 } }, t("empty.title")),
			h("div", { style: { fontSize: 11 } }, t("empty.body"))) : null,
		h("div", { className: "hp-hints", style: { bottom: 34 } },
			h("span", null, t("canvas.click")),
			h("span", null, t("canvas.drag")),
			h("span", null, t("canvas.zoom")),
			h("span", null, t("canvas.reset")),
			h("span", null, running ? "▸" : "▮")),
		h("div", { className: "hp-statusbar" },
				sel
					? h("div", { className: "hp-sel" },
						h("span", null, t("status.selected") + ": ", h("b", null, sel.id)),
						h("span", null, t("status.kind") + ": ", h("b", null, sel.type === "workdir" ? t("kind.workdir") : t("kind." + (sel.kind ?? "other")))),
						h("span", null, t("status.activation") + ": ", h("b", null, (sel.strength ?? 0).toFixed(3))),
						h("span", null, t("status.degree") + ": ", h("b", null, String(sel.degree ?? 0))),
						sel.type === "workdir" && sel.workdir ? h("span", { style: { color: "#9aa4b2" } }, sel.workdir) : null)
					: h("div", { className: "hp-sel" }, h("span", { style: { color: "#7d8590" } }, t("status.none"))),
				h("div", { className: "hp-status-right" },
					h("span", null, "Zoom: ", h("b", null, Math.round(zoom * 100) + "%")),
					h("span", null, t("status.fps") + ": ", h("b", null, String(fps))),
					h("span", null, t("status.gen") + ": ", h("b", null, String(m.epoch ?? "—"))),
					h("span", null, t("status.lr") + ": ", h("b", null, (m.learningRate ?? 0.01).toFixed(4))),
					h("span", null, t("status.fit") + ": ", h("b", null, (m.fitness ?? 0).toFixed(3)))))
	);
}

exports.GraphCanvas = GraphCanvas;
      },
      "components/list.js": function (module, exports, require) {
// 记忆分支列表卡片 + 新建/编辑弹窗
const React = require("react");
const { useState, useEffect, Fragment, createElement: h } = React;
const { KIND_COLORS, KINDS } = require("../constants.js");
const { zh } = require("../i18n.js");

function strengthLabel(s, t) {
	if (s >= 0.75) return t("strength.high");
	if (s >= 0.45) return t("strength.mid");
	return t("strength.low");
}

function ageText(ms, t) {
	const days = Math.max(0, (Date.now() - ms) / 86400000);
	if (days < 1) return Math.max(1, Math.round(days * 24)) + "h";
	return Math.round(days) + "d";
}

function BranchCard({ branch, selected, degree, due, onSelect, onEdit, onArchive, onRestore, onDelete, t }) {
	const color = KIND_COLORS[branch.kind] ?? KIND_COLORS.other;
	const strength = Number(branch.strength) || 0;
	const q = Number(branch.quality) || 0.5;
	const qLvl = q >= 0.75 ? "good" : q >= 0.5 ? "mid" : "low";
	const date = new Date(branch.updatedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
	// 卡片精简，默认折叠；展开 = 选中（点击聚焦的同时展开详情，再次点击收起）
	const open = !!selected;
	return h("div", { className: "hp-card" + (due ? " hp-due" : ""), "data-id": branch.id, "data-selected": selected || undefined, onClick: () => onSelect(open ? null : branch.id) },
		h("div", { className: "hp-card-top" },
			h("span", { className: "hp-badge", style: { background: color } }, t("kind." + branch.kind)),
			h("span", { className: "hp-card-title", title: branch.title }, branch.title),
			due ? h("span", { className: "hp-due-badge", title: t("btn.review") }, "🔔") : null,
			h("span", { className: "hp-quality", "data-q": qLvl, title: t("quality.prefix") + " " + q.toFixed(2) }, qLvl === "good" ? t("quality.good") : qLvl === "mid" ? t("quality.mid") : t("quality.low")),
			typeof degree === "number" && degree > 0 ? h("span", { className: "hp-degree", title: t("status.degree") }, "⚡" + degree) : null,
			h("span", { className: "hp-age", title: t("status.age") }, ageText(branch.updatedAt, t)),
			h("span", { className: "hp-card-meta", style: { color: open ? "#7ea6ff" : "#5b6472" } }, open ? "▾" : "▸")),
		h("div", { className: "hp-strength", title: t("field.strength") + " " + strength.toFixed(2) + " · " + strengthLabel(strength, t) },
			h("i", { style: { width: Math.round(strength * 100) + "%" } })),
		open ? h(Fragment, null,
			h("div", { className: "hp-card-content" }, branch.content),
			branch.tags.length > 0 ? h("div", { className: "hp-tags" }, branch.tags.map((tag) => h("span", { className: "hp-tag", key: tag }, "#" + tag))) : null,
			h("div", { className: "hp-card-meta" }, (branch.source === "user" ? t("source.user") : branch.source === "agent" ? t("source.agent") : t("source.system")) + " · " + date),
			h("div", { className: "hp-card-actions", onClick: (e) => e.stopPropagation() },
				h("button", { className: "hp-mini", onClick: () => onEdit(branch) }, t("btn.edit")),
				branch.status === "active"
					? h("button", { className: "hp-mini", onClick: () => onArchive(branch) }, t("btn.archive"))
					: h("button", { className: "hp-mini", onClick: () => onRestore(branch) }, t("btn.restore")),
				h("button", { className: "hp-mini", style: { color: "#ff7b72" }, onClick: () => onDelete(branch) }, t("btn.delete"))))
			: null);
}

function EditorModal(props) {
	// t 兜底：调用方未传词典时回退 zh，避免渲染崩溃
	const { branch, isNew, onSave, onClose } = props;
	const t = typeof props.t === "function" ? props.t : (k) => (zh[k] ?? k);
	const [title, setTitle] = useState("");
	const [kind, setKind] = useState("other");
	const [tags, setTags] = useState("");
	const [content, setContent] = useState("");
	const [strength, setStrength] = useState(0.6);
	const [status, setStatus] = useState("active");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(null);

	useEffect(() => {
		setTitle(branch?.title ?? "");
		setKind(branch?.kind ?? "other");
		setTags((branch?.tags ?? []).join(", "));
		setContent(branch?.content ?? "");
		setStrength(branch?.strength ?? 0.6);
		setStatus(branch?.status ?? "active");
		setBusy(false);
		setError(null);
	}, [branch]);

	const submit = async () => {
		if (!title.trim()) {
			setError(t("err.title.empty"));
			return;
		}
		setBusy(true);
		try {
			await onSave({
				title: title.trim(),
				kind,
				tags: tags.split(/[,，]/).map((x) => x.trim()).filter(Boolean),
				content,
				strength: Number(strength),
				status
			});
		} catch (err) {
			setError(String(err?.message ?? err));
		} finally {
			setBusy(false);
		}
	};

	return h("div", { className: "hp-modal", onMouseDown: (e) => { if (e.target === e.currentTarget) onClose(); } },
		h("div", { className: "hp-modal-box" },
			h("div", { className: "hp-modal-title" }, isNew ? t("new.title") : t("edit.title")),
			h("div", { className: "hp-field" },
				h("label", null, t("field.title")),
				h("input", { className: "hp-input", value: title, onChange: (e) => setTitle(e.target.value), placeholder: t("field.title.placeholder") })),
			h("div", { className: "hp-row" },
				h("div", { className: "hp-field" },
					h("label", null, t("field.kind")),
					h("select", { className: "hp-input", value: kind, onChange: (e) => setKind(e.target.value) },
						KINDS.map((k) => h("option", { key: k, value: k }, t("kind." + k))))),
				h("div", { className: "hp-field" },
					h("label", null, t("field.status")),
					h("select", { className: "hp-input", value: status, onChange: (e) => setStatus(e.target.value) },
						h("option", { value: "active" }, t("status.active")),
						h("option", { value: "archived" }, t("status.archived"))))),
			h("div", { className: "hp-field" },
				h("label", null, t("field.tags")),
				h("input", { className: "hp-input", value: tags, onChange: (e) => setTags(e.target.value), placeholder: t("field.tags.placeholder") })),
			h("div", { className: "hp-field" },
				h("label", null, t("field.content")),
				h("textarea", { className: "hp-textarea", value: content, onChange: (e) => setContent(e.target.value) })),
			h("div", { className: "hp-field" },
				h("label", null, t("field.strength") + ": " + Number(strength).toFixed(2) + " · " + strengthLabel(Number(strength), t)),
				h("input", { className: "hp-range", type: "range", min: 0, max: 1, step: 0.05, value: strength, onChange: (e) => setStrength(e.target.value) })),
			error ? h("div", { className: "hp-error" }, error) : null,
			h("div", { className: "hp-modal-actions" },
				h("button", { className: "hp-btn", onClick: onClose }, t("btn.cancel")),
				h("button", { className: "hp-btn hp-btn-primary", onClick: submit, disabled: busy }, busy ? "…" : t("btn.save"))),
			!isNew && (branch.history ?? []).length > 0
				? h("div", { className: "hp-history" },
					h("div", null, t("history")),
					branch.history.slice(-4).reverse().map((row, i) => h("div", { key: i }, t("hist.row", { time: new Date(row.at).toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }), by: row.by, summary: String(row.summary ?? "").slice(0, 80) }))))
				: null)
	);
}

exports.BranchCard = BranchCard;
exports.EditorModal = EditorModal;
      },
      "constants.js": function (module, exports, require) {
// 视觉常量：节点颜色 / 记忆种类 / 连接原因（图例与着色共用）
const KIND_COLORS = {
	preference: "#4fc3f7",
	communication: "#ffb74d",
	workstate: "#81c784",
	insight: "#ba68c8",
	other: "#90a4ae",
	workdir: "#ffd479"
};

const KINDS = ["preference", "communication", "workstate", "insight", "other"];

// 连接含义（颜色 = 原因，用于连线着色与图例）
const REASONS = [
	{ label: "永久锚定", color: "#ffd479" },
	{ label: "项目归属", color: "#ffb74d" },
	{ label: "核心协同", color: "#4fc3f7" },
	{ label: "核心关联", color: "#7fa8ff" },
	{ label: "同项目", color: "#81c784" },
	{ label: "语义相似", color: "#ba68c8" }
];

exports.KIND_COLORS = KIND_COLORS;
exports.KINDS = KINDS;
exports.REASONS = REASONS;
      },
      "draw.js": function (module, exports, require) {
// 3D 渲染：深度透视 + 球体体积感 + 层级轨道。
// v5.6：主题自适应（浅/深色）+ 旋转参照（轨道卫星点/增强网格）+ 方位罗盘（镜头朝向）。
const { rotate3, lexScore } = require("./sim.js");

// —— v5.6 主题调色板：从 DSH CSS 变量读取背景色，自动适配浅色/深色主题 ——
const DARK_PALETTE = {
	dark: true,
	bgTop: "#0b1220", bgBottom: "#060a12",
	grid: "rgba(90,110,160,0.05)",
	floor: "rgba(130,165,220,0.16)",
	floorDot: "rgba(130,165,220,0.30)",
	shell: ["rgba(150,190,255,0.34)", "rgba(255,206,130,0.28)", "rgba(200,170,255,0.24)"],
	shellSat: ["rgba(170,205,255,0.75)", "rgba(255,220,150,0.7)", "rgba(215,185,255,0.65)"],
	layerText: "rgba(150,180,230,0.62)",
	labelBg: "rgba(6,10,18,0.88)", labelText: "#ffffff",
	hitRing: "rgba(255,255,255,0.8)",
	selRing: "rgba(255,255,255,0.98)",
	hoverRing: "rgba(255,255,255,0.35)",
	compassBg: "rgba(6,10,18,0.72)", compassText: "#cfe0ff",
	axisX: "#ff6b6b", axisY: "#69db7c", axisZ: "#74c0fc"
};
const LIGHT_PALETTE = {
	dark: false,
	bgTop: "#eef2f8", bgBottom: "#dde4ef",
	grid: "rgba(60,80,120,0.12)",
	floor: "rgba(70,100,160,0.30)",
	floorDot: "rgba(70,100,160,0.55)",
	shell: ["rgba(80,110,180,0.36)", "rgba(190,140,70,0.32)", "rgba(140,100,190,0.28)"],
	shellSat: ["rgba(60,90,160,0.85)", "rgba(170,120,50,0.8)", "rgba(120,80,170,0.75)"],
	layerText: "rgba(70,95,150,0.75)",
	labelBg: "rgba(255,255,255,0.92)", labelText: "#16202e",
	hitRing: "rgba(30,60,100,0.85)",
	selRing: "rgba(20,40,80,0.95)",
	hoverRing: "rgba(60,90,150,0.6)",
	compassBg: "rgba(255,255,255,0.85)", compassText: "#3a4a68",
	axisX: "#e05b5b", axisY: "#3da35d", axisZ: "#3a7fc9"
};

let _themeCache = { at: 0, p: null };
function luminanceOf(hex) {
	try {
		const n = parseInt(hex.slice(1), 16);
		const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
		return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
	} catch { return 0; }
}
/** 读取当前主题调色板（2s 缓存；首次/主题切换后自动刷新） */
function themePalette() {
	const nowMs = Date.now();
	if (_themeCache.p && nowMs - _themeCache.at < 2000) return _themeCache.p;
	let p = DARK_PALETTE;
	try {
		if (typeof document !== "undefined") {
			const cs = getComputedStyle(document.documentElement);
			const read = (n, fb) => { const v = cs.getPropertyValue(n).trim(); return v && v.startsWith("#") ? v : fb; };
			const bgBase = read("--dsw-alias-bg-base", "#0b1018");
			if (luminanceOf(bgBase) >= 0.5) p = LIGHT_PALETTE;
		}
	} catch { /* 读取失败保持深色 */ }
	_themeCache = { at: nowMs, p };
	return p;
}

// 边连接含义：颜色 = 原因（图例 / 连线着色 / 标注共用）
function edgeReason(a, b) {
	if (a.type === "workdir" || b.type === "workdir") {
		const other = a.type === "workdir" ? b : a;
		if (other.type === "core") return { label: "永久锚定", color: "#ffd479" };
		if (other.type === "workdir") return { label: "目录关联", color: "#f2b36b" };
		return { label: "项目归属", color: "#ffb74d" };
	}
	if (a.type === "core" && b.type === "core") return { label: "核心协同", color: "#4fc3f7" };
	if (a.type === "core" || b.type === "core") return { label: "核心关联", color: "#7fa8ff" };
	if (a.workdir && a.workdir === b.workdir) return { label: "同项目", color: "#81c784" };
	return { label: "语义相似", color: "#ba68c8" };
}

function hexA(hex, a) {
	const n = parseInt(hex.slice(1), 16);
	return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a.toFixed(3) + ")";
}

// 明暗偏移（正=提亮，负=压暗），用于球体光照
function shade(hex, amt) {
	const n = parseInt(hex.slice(1), 16);
	const r = Math.max(0, Math.min(255, ((n >> 16) & 255) + amt));
	const g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amt));
	const b = Math.max(0, Math.min(255, (n & 255) + amt));
	return "rgb(" + r + "," + g + "," + b + ")";
}

function distToSeg(px, py, x1, y1, x2, y2) {
	const dx = x2 - x1, dy = y2 - y1;
	const l2 = dx * dx + dy * dy;
	if (l2 === 0) return Math.hypot(px - x1, py - y1);
	let tt = ((px - x1) * dx + (py - y1) * dy) / l2;
	tt = Math.max(0, Math.min(1, tt));
	return Math.hypot(px - (x1 + tt * dx), py - (y1 + tt * dy));
}

/** 画一条 3D 空间中的环（绕 Y 轴圆环经投影），并返回环上各标记点 */
function traceRing(ctx, r, rotX, rotY, scale, fov, cx, cy, n = 60) {
	const pts = [];
	ctx.beginPath();
	for (let i = 0; i <= n; i++) {
		const th = (i / n) * Math.PI * 2;
		const p = rotate3(Math.cos(th) * r, 0, Math.sin(th) * r, rotX, rotY);
		const k = scale / (fov + p.z);
		const sx = cx + p.x * k, sy = cy - p.y * k;
		if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
		pts.push({ sx, sy, depth: fov + p.z, th });
	}
	ctx.stroke();
	return pts;
}

/**
 * v5.6 方位罗盘：右下角小型 3D 坐标轴指示器 —— 随时知道镜头朝向。
 * X=红(右) Y=绿(上) Z=蓝(前)；蓝点即「镜头正对方向」，拖拽时跟随旋转。
 */
function drawCompass(ctx, w, h, rotX, rotY, p) {
	const cxp = w - 46, cyp = h - 44, R = 17;
	ctx.save();
	ctx.globalAlpha = 0.9;
	// 底盘
	ctx.fillStyle = p.compassBg;
	ctx.beginPath();
	ctx.arc(cxp, cyp, R + 7, 0, Math.PI * 2);
	ctx.fill();
	ctx.strokeStyle = p.dark ? "rgba(120,150,210,0.4)" : "rgba(70,100,160,0.4)";
	ctx.lineWidth = 1;
	ctx.stroke();
	// 坐标轴（与主视图同旋转）
	const axes = [
		{ v: rotate3(1, 0, 0, rotX, rotY), color: p.axisX, label: "X" },
		{ v: rotate3(0, 1, 0, rotX, rotY), color: p.axisY, label: "Y" },
		{ v: rotate3(0, 0, 1, rotX, rotY), color: p.axisZ, label: "Z" }
	];
	for (const a of axes) {
		ctx.globalAlpha = 0.95;
		ctx.strokeStyle = a.color;
		ctx.lineWidth = 1.6;
		ctx.beginPath();
		ctx.moveTo(cxp, cyp);
		ctx.lineTo(cxp + a.v.x * R, cyp - a.v.y * R);
		ctx.stroke();
	}
	// 前向标记（Z+ 蓝点 = 镜头正对方向）
	const f = rotate3(0, 0, 1, rotX, rotY);
	ctx.globalAlpha = 1;
	ctx.fillStyle = p.axisZ;
	ctx.beginPath();
	ctx.arc(cxp + f.x * R, cyp - f.y * R, 3, 0, Math.PI * 2);
	ctx.fill();
	ctx.strokeStyle = p.dark ? "#0b1220" : "#ffffff";
	ctx.lineWidth = 1;
	ctx.stroke();
	// 中心点
	ctx.fillStyle = p.compassText;
	ctx.beginPath();
	ctx.arc(cxp, cyp, 2.2, 0, Math.PI * 2);
	ctx.fill();
	// 方位文本（前/后/上/下 的当前朝向）
	const front = Math.round((((rotY % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 2));
	const faces = ["前", "右", "后", "左"];
	const face = faces[front % 4];
	const pitch = rotX > 0.35 ? "下" : rotX < -0.35 ? "上" : "平视";
	ctx.globalAlpha = 0.95;
	ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
	ctx.textAlign = "center";
	ctx.fillStyle = p.compassText;
	ctx.fillText(face + "·" + pitch, cxp, cyp + R + 14);
	ctx.textAlign = "left";
	ctx.restore();
}

// 3D 球形渲染 —— 旋转 + 透视投影 + 深度排序 + 背面衰减
// v5.4：draw 增加 anchors 参数（激活锚点集合 → 金色锚环 + 呼吸脉冲可视化工作记忆）
function draw(canvas, sim, selectedId, size, searchQuery, view, anchors) {
	if (!canvas || size.w === 0) return;
	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	const P = themePalette(); // v5.6 主题调色板
	const anchorSet = anchors && anchors.size ? anchors : null;
	const dpr = Math.min(2, window.devicePixelRatio || 1);
	const w = size.w;
	const h = size.h;
	const rotX = view.rotX ?? -0.35;
	const rotY = view.rotY ?? 0.6;
	const zoom = view.zoom || 1;
	const dragging = view.dragging ?? false;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	// 背景（主题自适应：浅色主题 → 浅色渐变背景）
	const bg = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.75);
	bg.addColorStop(0, P.bgTop);
	bg.addColorStop(1, P.bgBottom);
	ctx.fillStyle = bg;
	ctx.fillRect(0, 0, w, h);
	// 点阵星空（主题化）
	ctx.fillStyle = P.grid;
	for (let gx = 18; gx < w; gx += 18) {
		for (let gy = 18; gy < h; gy += 18) ctx.fillRect(gx, gy, 1, 1);
	}
	// 投影参数
	const scale = Math.min(w, h) * 0.46 * zoom;
	const fov = 2.1;
	const cx = w / 2;
	const cy = h / 2;
	// 节点投影（含 3D 旋转）
	const pts = sim.nodes.map((node) => {
		const r3 = rotate3(node.x, node.y, node.z, rotX, rotY);
		const depth = fov + r3.z;
		const k = scale / depth;
		return { node, depth, k, sx: cx + r3.x * k, sy: cy - r3.y * k };
	});
	const byId = new Map(pts.map((p) => [p.node.id, p]));
	const q = searchQuery ? searchQuery.toLowerCase() : null;
	// 搜索态用【服务端真实检索命中】决定变暗/命中环/共激活脉冲
	const sr = q && sim.searchHits && sim.searchHits.q === q ? sim.searchHits : null;
	const nowMs = Date.now();
	const edgeSignal = new Map();
	if (sr) for (const e of sr.edges) edgeSignal.set(e.a + "|" + e.b, e);
	const dim = (node) => {
		if (!q) return 1;
		if (sr) return sr.hits.has(node.id) ? 1 : 0.32;
		return lexScore(node, q) > 0 ? 1 : 0.35;
	};
	// 选中节点关联高亮：计算与 selectedId 直接相连的节点集合和边集合
	const connectedIds = new Set();
	const highlightedEdgeSet = new Set();
	if (selectedId) {
		for (const e of sim.edges) {
			if (e.a === selectedId || e.b === selectedId) {
				highlightedEdgeSet.add(e.a + "|" + e.b);
				highlightedEdgeSet.add(e.b + "|" + e.a);
				if (e.a !== selectedId) connectedIds.add(e.a);
				if (e.b !== selectedId) connectedIds.add(e.b);
			}
		}
	}
	const isHighlighted = (nodeId) => !!selectedId && (nodeId === selectedId || connectedIds.has(nodeId));
	// 选中时非关联节点大幅变暗
	const dimWithSelection = (node) => {
		if (selectedId && !isHighlighted(node.id)) return 0.18;
		return dim(node);
	};
	// 背面衰减（z 深入背面时变暗变小）—— 立体感的「视觉修正」核心
	const faceA = (p) => Math.max(0.16, Math.min(1, 1.55 - p.depth / fov));

	// —— 层级轨道：三层壳赤道环 ——
	// v5.6：轨道环上带「卫星标记点」—— 环随球体旋转时标记点明显移动，
	// 让「球在转」可感知（解决主体变化不明显/看不出在动的问题）
	const SHELLS = [
		{ r: 0.08, label: "核心 · 中枢" },
		{ r: 0.34, label: "工作区 · 项目" },
		{ r: 0.78, label: "衍生 · 记忆" }
	];
	ctx.lineWidth = 1;
	SHELLS.forEach((sh, idx) => {
		ctx.strokeStyle = P.shell[idx];
		const ringPts = traceRing(ctx, sh.r, rotX, rotY, scale, fov, cx, cy);
		// 卫星标记点：环上 3 个均匀分布的点，随旋转移动（方位参照）
		ctx.fillStyle = P.shellSat[idx];
		for (const mk of [0.33, 0.66, 0.99]) {
			const m = ringPts[Math.floor(mk * (ringPts.length - 1))];
			if (!m || m.depth < 0.25) continue; // 背面的标记点不画（避免视觉歧义）
			const sz = idx === 0 ? 2 : 2.5;
			ctx.beginPath();
			ctx.arc(m.sx, m.sy, sz, 0, Math.PI * 2);
			ctx.fill();
		}
	});
	// 层标签（左上角固定，主题化）
	ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
	ctx.textBaseline = "top";
	SHELLS.forEach((sh, i) => {
		const ly = 30 + i * 18;
		ctx.fillStyle = P.labelBg;
		ctx.fillRect(10, ly - 1, 142, 17);
		ctx.fillStyle = P.shell[i];
		ctx.fillText(sh.label, 15, ly);
	});
	ctx.textBaseline = "alphabetic";

	// —— 透视地平线网格（y=-1.55 平面，随球体旋转）—— v5.6 增强：透明度提升 + 交点小点 ——
	const FLOOR_Y = -1.55, FLOOR_HALF = 2.2, GRID_N = 6;
	const proj3 = (v) => { const dd = fov + v.z; if (dd < 0.25) return null; return { x: cx + v.x * (scale / dd), y: cy - v.y * (scale / dd) }; };
	ctx.lineWidth = 1;
	ctx.strokeStyle = P.floor;
	for (let i = 0; i <= GRID_N; i++) {
		const t = -1 + (2 * i) / GRID_N;
		const p1 = proj3(rotate3(t * FLOOR_HALF, FLOOR_Y, -FLOOR_HALF, rotX, rotY));
		const p2 = proj3(rotate3(t * FLOOR_HALF, FLOOR_Y, FLOOR_HALF, rotX, rotY));
		const p3 = proj3(rotate3(-FLOOR_HALF, FLOOR_Y, t * FLOOR_HALF, rotX, rotY));
		const p4 = proj3(rotate3(FLOOR_HALF, FLOOR_Y, t * FLOOR_HALF, rotX, rotY));
		if (p1 && p2) { ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke(); }
		if (p3 && p4) { ctx.beginPath(); ctx.moveTo(p3.x, p3.y); ctx.lineTo(p4.x, p4.y); ctx.stroke(); }
	}
	// 网格交点小点（v5.6：让网格运动更可感知）
	ctx.fillStyle = P.floorDot;
	for (let i = 0; i <= GRID_N; i += 2) {
		for (let j = 0; j <= GRID_N; j += 2) {
			const pv = proj3(rotate3(-1 + (2 * i) / GRID_N * FLOOR_HALF, FLOOR_Y, -1 + (2 * j) / GRID_N * FLOOR_HALF, rotX, rotY));
			if (pv) { ctx.fillRect(pv.x - 1, pv.y - 1, 2, 2); }
		}
	}

	// —— 连接（真实突触权重；按连接原因着色；悬停/选中边标注原因+权重）——
	let hoverEdge = null;
	if (sim.mouse && sim.mouse.inside && !dragging) {
		let bd = 9;
		for (const e of sim.edges) {
			const pa = byId.get(e.a), pb = byId.get(e.b);
			if (!pa || !pb) continue;
			if (sim.prune && e.weight < 0.3) continue;
			if (Math.min(faceA(pa), faceA(pb)) < 0.5) continue;
			const d = distToSeg(sim.mouse.x, sim.mouse.y, pa.sx, pa.sy, pb.sx, pb.sy);
			if (d < bd) { bd = d; hoverEdge = e; }
		}
	}
	sim.hoverEdge = hoverEdge;
	for (const e of sim.edges) {
		const pa = byId.get(e.a);
		const pb = byId.get(e.b);
		if (!pa || !pb) continue;
		if (sim.prune && e.weight < 0.3) continue;
		const ad = dimWithSelection(pa.node) * dimWithSelection(pb.node);
		if (ad <= 0.05) continue;
		const back = Math.min(faceA(pa), faceA(pb));
		const reason = edgeReason(pa.node, pb.node);
		const isHoverEdge = hoverEdge === e;
		const isFocusEdge = isHoverEdge || (selectedId && highlightedEdgeSet.has(e.a + "|" + e.b));
		const lwScale = Math.min(2.2, Math.max(0.6, zoom));
		if (isFocusEdge) {
			ctx.strokeStyle = "rgba(255,255,255," + Math.min(0.96, (0.6 + e.weight * 0.4) * back).toFixed(3) + ")";
			ctx.lineWidth = (1.8 + e.weight * 2.2) * lwScale;
			ctx.shadowColor = reason.color;
			ctx.shadowBlur = 9 * Math.min(1.6, zoom);
		} else {
			ctx.strokeStyle = hexA(reason.color, (0.06 + e.weight * 0.20) * ad * back);
			ctx.lineWidth = (0.4 + e.weight * 0.8) * lwScale;
			ctx.shadowBlur = 0;
		}
		ctx.beginPath();
		ctx.moveTo(pa.sx, pa.sy);
		ctx.lineTo(pb.sx, pb.sy);
		ctx.stroke();
		ctx.shadowBlur = 0;
		// 脉冲：只对【真实共激活边】在真实检索发生后播放一次（从 a→b）
		const sig = sr ? edgeSignal.get(e.a + "|" + e.b) : null;
		if (sig && (nowMs - sr.at) < 2000) {
			const tt = Math.min(1, (nowMs - sr.at) / 2000);
			const ix = pa.node.x + (pb.node.x - pa.node.x) * tt;
			const iy = pa.node.y + (pb.node.y - pa.node.y) * tt;
			const iz = pa.node.z + (pb.node.z - pa.node.z) * tt;
			const r3i = rotate3(ix, iy, iz, rotX, rotY);
			const ki = scale / (fov + r3i.z);
			ctx.fillStyle = "rgba(170,225,255," + Math.max(0, (0.45 + sig.weight * 0.4) * (1 - tt * 0.6) * ad * back).toFixed(3) + ")";
			ctx.beginPath();
			ctx.arc(cx + r3i.x * ki, cy - r3i.y * ki, 1.6 + sig.weight * 1.6, 0, Math.PI * 2);
			ctx.fill();
		}
		// 连接原因标注（主题化标签底）
		if (isFocusEdge) {
			const mx = (pa.sx + pb.sx) / 2;
			const my = (pa.sy + pb.sy) / 2;
			const label = reason.label + " · " + e.weight.toFixed(2);
			ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
			const tw = ctx.measureText(label).width;
			const bx = Math.min(w - tw - 10, Math.max(6, mx - tw / 2));
			const byy = Math.max(18, my - 8);
			ctx.fillStyle = P.labelBg;
			ctx.beginPath();
			ctx.roundRect ? ctx.roundRect(bx - 5, byy - 13, tw + 10, 18, 4) : ctx.rect(bx - 5, byy - 13, tw + 10, 18);
			ctx.fill();
			ctx.fillStyle = reason.color;
			ctx.fillText(label, bx, byy);
		}
	}
	// 节点：按深度从远到近绘制（画家算法）
	pts.sort((a, b) => b.depth - a.depth);
	for (const p of pts) {
		const node = p.node;
		const d = dimWithSelection(node);
		const back = faceA(p);
		const base = (p.k / (scale / fov)) * zoom;
		// v5.5：节点半径已在 sim 端按 强度×连接度×层级 综合计算，此处不再重复放大
		const r = Math.max(1.5, node.r * base);
		const highlighted = isHighlighted(node.id);
		const isSelected = node.id === selectedId;
		const glow = isSelected ? 12 + node.energy * 14
			: highlighted ? 8 + node.energy * 10
			: 1.5 + node.energy * 4;
		ctx.shadowColor = isSelected ? "#ffffff" : (highlighted ? "#aaddff" : node.color);
		ctx.shadowBlur = glow;
		ctx.globalAlpha = (0.55 + node.strength * 0.45) * d * back;
		if (node.type === "workdir") {
			// v5.7 工作区目录：真正 3D 立方体 —— 8 顶点旋转投影 + 面深度排序 + 明暗面，
			// 旋转时有体积感（此前是 2D 扁平圆角矩形，看起来像贴图）
			ctx.globalAlpha = 1; // 面的透明度由 hexA 控制（避免与 globalAlpha 双重叠加）
			const hs = (r / Math.max(1e-6, p.k)) * 0.95; // 世界半边长（把屏幕半径换算回世界单位）
			const V = [
				[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
				[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]
			];
			const corners = [];
			for (const [sx, sy, sz] of V) {
				const wv = rotate3(node.x + sx * hs, node.y + sy * hs, node.z + sz * hs, rotX, rotY);
				const dd = fov + wv.z;
				const kk = scale / dd;
				corners.push({ x: cx + wv.x * kk, y: cy - wv.y * kk, depth: dd });
			}
			const faces = [
				{ idx: [0, 1, 2, 3], c: shade(node.color, 60) },   // z- 主面
				{ idx: [4, 7, 6, 5], c: shade(node.color, -20) },  // z+ 背面
				{ idx: [0, 1, 5, 4], c: shade(node.color, -50) },  // y- 底面
				{ idx: [3, 2, 6, 7], c: shade(node.color, 30) },   // y+ 顶面
				{ idx: [0, 3, 7, 4], c: shade(node.color, -60) },  // x- 左面
				{ idx: [1, 2, 6, 5], c: shade(node.color, 10) }    // x+ 右面
			];
			faces.forEach((f) => { f.depth = f.idx.reduce((s, vi) => s + corners[vi].depth, 0) / 4; });
			faces.sort((a, b) => a.depth - b.depth); // 画家算法：远 → 近
			for (const f of faces) {
				ctx.fillStyle = hexA(f.c, 0.88 * back);
				ctx.beginPath();
				f.idx.forEach((vi, i) => { i ? ctx.lineTo(corners[vi].x, corners[vi].y) : ctx.moveTo(corners[vi].x, corners[vi].y); });
				ctx.closePath();
				ctx.fill();
				ctx.strokeStyle = "rgba(255,255,255," + (0.14 * back).toFixed(2) + ")";
				ctx.lineWidth = 0.7;
				ctx.stroke();
			}
			// 顶面高光角点（增强体积感）
			const topIdx = [3, 2, 6, 7];
			ctx.fillStyle = "rgba(255,255,255," + (0.18 * back).toFixed(2) + ")";
			ctx.beginPath();
			topIdx.forEach((vi, i) => { i ? ctx.lineTo(corners[vi].x, corners[vi].y) : ctx.moveTo(corners[vi].x, corners[vi].y); });
			ctx.closePath();
			ctx.fill();
		} else {
			// 球体体积感：径向渐变（左上亮 / 右下暗）+ 单一玻璃高光 + 边缘暗环
			const rg = ctx.createRadialGradient(p.sx - r * 0.4, p.sy - r * 0.45, r * 0.1, p.sx, p.sy, r * 1.05);
			rg.addColorStop(0, shade(node.color, 120));
			rg.addColorStop(0.55, node.color);
			rg.addColorStop(1, shade(node.color, -70));
			ctx.fillStyle = rg;
			ctx.beginPath();
			ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2);
			ctx.fill();
			// 单一玻璃高光点（不叠加多个光斑，保持干净）
			if (back > 0.6) {
				ctx.fillStyle = "rgba(255,255,255," + (0.45 * back).toFixed(2) + ")";
				ctx.beginPath();
				ctx.arc(p.sx - r * 0.35, p.sy - r * 0.4, Math.max(1.2, r * 0.16), 0, Math.PI * 2);
				ctx.fill();
			}
			// 边缘暗环（环境光遮蔽），增强体积与明暗转折
			const rim = ctx.createRadialGradient(p.sx, p.sy, r * 0.78, p.sx, p.sy, r);
			rim.addColorStop(0, "rgba(0,0,0,0)");
			rim.addColorStop(1, "rgba(3,6,14," + (0.4 * back).toFixed(2) + ")");
			ctx.fillStyle = rim;
			ctx.beginPath();
			ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2);
			ctx.fill();
		}
		ctx.globalAlpha = 1;
		// 搜索命中环（主题化）
		const isHit = sr ? sr.hits.has(node.id) : !!(q && lexScore(node, q) > 0);
		if (isHit && !highlighted) {
			ctx.shadowBlur = 0;
			ctx.strokeStyle = P.hitRing;
			ctx.lineWidth = 1.1;
			ctx.setLineDash([3, 3]);
			ctx.beginPath();
			ctx.arc(p.sx, p.sy, r + 3, 0, Math.PI * 2);
			ctx.stroke();
			ctx.setLineDash([]);
		}
		// 选中/关联节点高亮环（主题化）
		if (highlighted) {
			ctx.shadowBlur = 0;
			ctx.strokeStyle = isSelected
				? P.selRing
				: "rgba(170,220,255," + (0.85 * back).toFixed(2) + ")";
			ctx.lineWidth = isSelected ? 2.4 : 1.6;
			ctx.beginPath();
			ctx.arc(p.sx, p.sy, r + (isSelected ? 5 : 4), 0, Math.PI * 2);
			ctx.stroke();
			// 选中节点额外发光圈
			if (isSelected) {
				ctx.strokeStyle = "rgba(255,255,255," + (0.35 * back).toFixed(2) + ")";
				ctx.lineWidth = 5;
				ctx.beginPath();
				ctx.arc(p.sx, p.sy, r + 8, 0, Math.PI * 2);
				ctx.stroke();
			}
		}
		ctx.shadowBlur = 0;
		// 标签：仅聚焦（选中）节点显示名称并放大（主题化标签底）
		if (isSelected) {
			ctx.font = "bold 16px ui-sans-serif, system-ui, sans-serif";
			const tw = ctx.measureText(node.title).width;
			const tx = Math.min(w - tw - 6, Math.max(6, p.sx - tw / 2));
			const ty = Math.max(18, p.sy - r - 15);
			ctx.fillStyle = P.labelBg;
			ctx.fillRect(tx - 6, ty - 14, tw + 12, 20);
			ctx.fillStyle = P.labelText;
			ctx.fillText(node.title, tx, ty);
		} else if (node.id === sim.hover && !highlighted) {
			// 悬停反馈：仅细光环（主题化）
			ctx.shadowBlur = 0;
			ctx.strokeStyle = P.hoverRing;
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.arc(p.sx, p.sy, r + 2, 0, Math.PI * 2);
			ctx.stroke();
		}
		// v5.4 激活锚点：金色锚环 + 呼吸脉冲
		if (anchorSet && anchorSet.has(node.id) && !highlighted) {
			const breath = 0.5 + 0.5 * Math.sin(sim.t * 0.05 + (hash01(node.id) * 6.28));
			const ar = r + 7 + breath * 2;
			ctx.shadowBlur = 0;
			ctx.strokeStyle = "rgba(255,212,121," + (0.30 + breath * 0.35).toFixed(2) + ")";
			ctx.lineWidth = 1.4;
			ctx.beginPath();
			ctx.arc(p.sx, p.sy, ar, 0, Math.PI * 2);
			ctx.stroke();
			ctx.strokeStyle = "rgba(255,212,121," + (0.16 + breath * 0.2).toFixed(2) + ")";
			ctx.setLineDash([2, 3]);
			ctx.beginPath();
			ctx.arc(p.sx, p.sy, ar + 3, 0, Math.PI * 2);
			ctx.stroke();
			ctx.setLineDash([]);
		}
		// v5.5 联想交汇节点标识：紫色星标
		if (node.title && node.title.startsWith("⟡") && !highlighted && !anchorSet?.has(node.id)) {
			const tw = ctx.measureText("⟡").width;
			ctx.shadowBlur = 0;
			ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
			ctx.fillStyle = "rgba(186,104,200," + (0.55 + node.energy * 0.35).toFixed(2) + ")";
			ctx.fillText("⟡", p.sx - tw / 2, p.sy - r - 6);
			ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
		}
	}

	// v5.6 方位罗盘：右下角，随时知道镜头朝向（前/后/左/右 + 上/下/平视）
	drawCompass(ctx, w, h, rotX, rotY, P);
}

// 字符串哈希（锚点呼吸相位用，与 sim.js 同构）
function hash01(str) {
	let x = 0;
	for (let i = 0; i < str.length; i++) x = (x * 31 + str.charCodeAt(i)) >>> 0;
	return x / 4294967296;
}

exports.draw = draw;
      },
      "i18n.js": function (module, exports, require) {
// 词典（中 / 英）—— 记忆页 UI 完整双语（可手动切换，不依赖 DSH 全局语言）
// 支持 {param} 插值：t("key", { a: 1 })
const zh = {
	"view.memory": "记忆",
	"tab.hint": "海马体记忆",
	"stats.neurons": "神经元",
	"stats.connections": "突触",
	"stats.activation": "激活强度",
	"stats.epoch": "Epoch",
	"stats.fitness": "适应度",
	"search.placeholder": "搜索记忆…（驱动网络激活）",
	"filter.all": "全部",
	"kind.preference": "偏好",
	"kind.communication": "交流方式",
	"kind.workstate": "工作状态",
	"kind.insight": "洞察",
	"kind.other": "其他",
	"kind.workdir": "工作区目录",
	"btn.new": "＋ 新建分支",
	"btn.refresh": "刷新",
	"btn.edit": "编辑",
	"btn.archive": "归档",
	"btn.restore": "恢复",
	"btn.delete": "删除",
	"btn.save": "保存",
	"btn.cancel": "取消",
	"btn.export": "导出",
	"btn.import": "导入",
	"btn.review": "待复习",
	"btn.fullscreen": "⛶ 全屏",
	"btn.tools": "⚙ 工具",
	"btn.tools.export": "⬇ 导出 .md",
	"btn.tools.import": "⬆ 导入 .md",
	"btn.tools.inject": "F9 · 注入日志",
	"btn.tools.link": "F5 · 手动连线",
	"btn.tools.linkNeed": "F5 · 手动连线（需选中）",
	"btn.tools.evolog": "F6 · 演化日志",
	"exit.fullscreen": "✕ 退出全屏",
	"empty.title": "海马体还没有记忆",
	"empty.body": "点击「新建分支」手动写入，或让我在任务中用 memory_write 记录你的偏好、交流方式与工作状态。",
	"loading": "记忆读取中…",
	"loading2": "加载中…",
	"error": "记忆服务不可用：",
	"edit.title": "编辑记忆分支",
	"new.title": "新建记忆分支",
	"field.title": "标题",
	"field.kind": "种类",
	"field.tags": "标签（逗号分隔，留空自动生成）",
	"field.content": "内容",
	"field.strength": "强度",
	"field.status": "状态",
	"field.title.placeholder": "一句话概括这条记忆",
	"field.tags.placeholder": "例如: 偏好, 中文, 任务A（留空自动生成）",
	"status.active": "活跃",
	"status.archived": "已归档",
	"history": "修正历史",
	"saved": "已保存 ✓",
	"deleted": "已删除",
	"archived": "已归档",
	"restored": "已恢复",
	"confirm.delete": "确定彻底删除这条记忆？此操作不可恢复。",
	"err.title.empty": "标题不能为空",
	"source.agent": "Agent",
	"source.user": "用户",
	"source.system": "系统",
	"strength.high": "牢固",
	"strength.mid": "稳定",
	"strength.low": "易忘",
	"legend.title": "图例",
	"legend.activation": "激活强度",
	"legend.links": "突触连接",
	"legend.anchor": "金色锚环 = 工作记忆激活",
	"legend.cross": "⟡ 紫色星标 = 联想交汇（连线交叉产生的新想法）",
	"conn.legend": "连接含义",
	"tagcloud.title": "标签云 · 点击筛选 / 右键合并",
	"tagcloud.empty": "暂无标签",
	"ctrl.learning.en": "SELF-LEARNING",
	"ctrl.evolution.en": "SELF-EVOLUTION",
	"ctrl.neurons": "神经元",
	"ctrl.synapses": "突触",
	"ctrl.fitness": "适应度",
	"ctrl.pruned": "已修剪",
	"ctrl.merged": "已合并",
	"ctrl.gen": "代际",
	"ctrl.active": "ACTIVE",
	"ctrl.paused": "PAUSED",
	"ctrl.toggle": "开关学习 空格",
	"ctrl.evolve": "演化：合并近重复",
	"ctrl.prune": "修剪弱连接",
	"ctrl.pruneWeak": "修剪弱记忆",
	"tut.title": "📖 小白教程",
	"tut.what": "这是什么：",
	"tut.what.desc": "海马体记忆是 Agent 的「长期记忆」插件，像大脑的海马体一样把信息沉淀下来。",
	"tut.cap": "执行什么能力：",
	"tut.cap.desc": "「记忆」标签页 + memory_write/read/search/edit/forget 等工具 + 3D 神经网络可视化 + 自学习/自演化。",
	"tut.done": "做了什么：",
	"tut.done.desc": "每条记忆是一个神经元，相关记忆自动连线（突触）；搜索时相关节点点亮、无关变暗；定期合并重复、修剪弱连接。",
	"tut.why": "为什么要这样：",
	"tut.why.desc": "模型本身不记得上次对话；把关键信息存下来并在需要时自动注入，Agent 才能记住你的偏好与项目进度。",
	"status.selected": "选中",
	"status.kind": "种类",
	"status.activation": "激活",
	"status.degree": "连接",
	"status.age": "年龄",
	"status.none": "未选中节点 — 点击节点检视",
	"status.fps": "FPS",
	"status.gen": "Gen",
	"status.lr": "LR",
	"status.fit": "Fit",
	"canvas.click": "单击节点 = 聚焦",
	"canvas.drag": "拖拽 = 旋转",
	"canvas.zoom": "滚轮 = 缩放",
	"canvas.reset": "双击 = 重置视图",
	"quality.good": "优",
	"quality.mid": "中",
	"quality.low": "低",
	"quality.prefix": "质量",
	"list.active": "活跃",
	"list.archived": "归档",
	"f9.title": "F9 注入日志（对话前自动/工具/刷新）",
	"f5.title": "F5 手动突触编辑（连接/断开）",
	"f6.title": "F6 演化日志（自循环进化历史）",
	"link.a": "记忆 A id",
	"link.b": "记忆 B id",
	"link.weight": "连接权重",
	"link.current": "当前连接",
	"link.connect": "建立连接",
	"link.disconnect": "断开连接",
	"evo.epochGen": "Epoch {e} · Gen {g}",
	"evo.merged": "合并:",
	"evo.pruned": "修剪:",
	"evo.fitness": "fitness:",
	"evo.lr": "lr:",
	"evolved": "演化完成",
	"prunedDone": "修剪完成",
	"btn.feed": "喂养轨迹",
	"notify.dedup": "检测到相似记忆，已合并强化原记忆",
	"notify.hideWeak": "已隐藏弱连接（<0.3）；再次按 E 恢复显示",
	"notify.fed": "轨迹喂养：{n} 条事件 → 写入「{t}」（{c} 字）",
	"notify.fedReason": "轨迹喂养：{n} 条事件（{r}）",
	"notify.fedFail": "喂养失败：",
	"notify.evolved": "演化完成：合并 {m} · 修剪连接 {p} · Gen {g}",
	"notify.pruned": "修剪完成：归档 {n} 条弱记忆 · 修剪连接 {p}",
	"notify.export": "已导出 {n} 条记忆（.md）",
	"notify.exportFail": "导出失败：",
	"notify.import": "导入完成：新增 {i} · 去重合并 {d}",
	"notify.importFail": "导入失败：",
	"notify.mergeTag": "已合并 {n} 条记忆的标签",
	"notify.mergeTagFail": "合并失败：",
	"notify.link": "已连接两记忆，权重 {w}",
	"notify.linkFail": "连接失败：",
	"notify.unlink": "已断开两记忆间的连接",
	"notify.unlinkNone": "两记忆间原本无连接",
	"notify.unlinkFail": "断开失败：",
	"notify.review": "已复习强化：「{t}」 强度 {s}",
	"notify.reviewFail": "复习失败：",
	"notify.reviewAll": "已复习 {d}/{n} 条到期记忆",
	"notify.archiveWdir": "已归档工作区「{n}」，连接已断开",
	"notify.archiveFail": "归档失败：",
	"confirm.archiveWdir": "归档工作区「{t}」？\n将断开该工作区的全部连接（含与偏好/交流的永久连接），除非再次使用该目录，否则不再重建。",
	"hist.row": "· {time} — {by}：{summary}"
};

const en = {
	"view.memory": "Memory",
	"tab.hint": "Hippocampus Memory",
	"stats.neurons": "Neurons",
	"stats.connections": "Links",
	"stats.activation": "Activation",
	"stats.epoch": "Epoch",
	"stats.fitness": "Fitness",
	"search.placeholder": "Search memory… (drives network)",
	"filter.all": "All",
	"kind.preference": "Preference",
	"kind.communication": "Style",
	"kind.workstate": "Work state",
	"kind.insight": "Insight",
	"kind.other": "Other",
	"kind.workdir": "Workspace",
	"btn.new": "+ New branch",
	"btn.refresh": "Refresh",
	"btn.edit": "Edit",
	"btn.archive": "Archive",
	"btn.restore": "Restore",
	"btn.delete": "Delete",
	"btn.save": "Save",
	"btn.cancel": "Cancel",
	"btn.export": "Export",
	"btn.import": "Import",
	"btn.review": "Due",
	"btn.fullscreen": "⛶ Full",
	"btn.tools": "⚙ Tools",
	"btn.tools.export": "⬇ Export .md",
	"btn.tools.import": "⬆ Import .md",
	"btn.tools.inject": "F9 · Inject log",
	"btn.tools.link": "F5 · Link",
	"btn.tools.linkNeed": "F5 · Link (select first)",
	"btn.tools.evolog": "F6 · Evolve log",
	"exit.fullscreen": "✕ Exit",
	"empty.title": "No memory yet",
	"empty.body": "Click + New branch, or ask the agent to record preferences / work state with memory_write.",
	"loading": "Loading memory…",
	"loading2": "Loading…",
	"error": "Memory service unavailable:",
	"edit.title": "Edit branch",
	"new.title": "New branch",
	"field.title": "Title",
	"field.kind": "Kind",
	"field.tags": "Tags (comma-separated, empty = auto)",
	"field.content": "Content",
	"field.strength": "Strength",
	"field.status": "Status",
	"field.title.placeholder": "One-line summary of this memory",
	"field.tags.placeholder": "e.g. preference, chinese (empty = auto)",
	"status.active": "Active",
	"status.archived": "Archived",
	"history": "History",
	"saved": "Saved ✓",
	"deleted": "Deleted",
	"archived": "Archived",
	"restored": "Restored",
	"confirm.delete": "Permanently delete this memory? This cannot be undone.",
	"err.title.empty": "Title cannot be empty",
	"source.agent": "Agent",
	"source.user": "User",
	"source.system": "System",
	"strength.high": "Strong",
	"strength.mid": "Stable",
	"strength.low": "Weak",
	"legend.title": "Legend",
	"legend.activation": "Activation",
	"legend.links": "Synapses",
	"legend.anchor": "Gold ring = active working memory",
	"legend.cross": "⟡ purple star = cross-link idea (new thought from intersecting links)",
	"conn.legend": "Link types",
	"tagcloud.title": "Tag cloud · click filter / right-click merge",
	"tagcloud.empty": "No tags yet",
	"ctrl.learning.en": "SELF-LEARNING",
	"ctrl.evolution.en": "SELF-EVOLUTION",
	"ctrl.neurons": "Neurons",
	"ctrl.synapses": "Synapses",
	"ctrl.fitness": "Fitness",
	"ctrl.pruned": "Pruned",
	"ctrl.merged": "Merged",
	"ctrl.gen": "Gen",
	"ctrl.active": "ACTIVE",
	"ctrl.paused": "PAUSED",
	"ctrl.toggle": "Toggle learning (Space)",
	"ctrl.evolve": "Evolve: merge near-dups",
	"ctrl.prune": "Prune weak links",
	"ctrl.pruneWeak": "Prune weak memories",
	"tut.title": "📖 Tutorial",
	"tut.what": "What is this: ",
	"tut.what.desc": "Hippocampus Memory is the agent's long-term memory plugin — like the brain's hippocampus, it consolidates information.",
	"tut.cap": "Capabilities: ",
	"tut.cap.desc": "Memory tab + memory_write/read/search/edit/forget tools + 3D neural network visualization + self-learning / self-evolution.",
	"tut.done": "What it does: ",
	"tut.done.desc": "Each memory is a neuron; related memories auto-connect (synapses); searching lights up relevant nodes and dims others; duplicates merge and weak links are pruned.",
	"tut.why": "Why: ",
	"tut.why.desc": "The model doesn't remember previous chats; storing key info and auto-injecting it keeps the agent aligned with your preferences and project progress.",
	"status.selected": "Selected",
	"status.kind": "Kind",
	"status.activation": "Activation",
	"status.degree": "Links",
	"status.age": "Age",
	"status.none": "No node selected — click to inspect",
	"status.fps": "FPS",
	"status.gen": "Gen",
	"status.lr": "LR",
	"status.fit": "Fit",
	"canvas.click": "Click node = focus",
	"canvas.drag": "Drag = rotate",
	"canvas.zoom": "Wheel = zoom",
	"canvas.reset": "Double-click = reset",
	"quality.good": "Good",
	"quality.mid": "Fair",
	"quality.low": "Weak",
	"quality.prefix": "Quality",
	"list.active": "Active",
	"list.archived": "Archived",
	"f9.title": "F9 Inject log (auto / tool / refresh)",
	"f5.title": "F5 Manual synapse edit (link / unlink)",
	"f6.title": "F6 Evolve log (self-evolution history)",
	"link.a": "Memory A id",
	"link.b": "Memory B id",
	"link.weight": "Link weight",
	"link.current": "Current links",
	"link.connect": "Connect",
	"link.disconnect": "Disconnect",
	"evo.epochGen": "Epoch {e} · Gen {g}",
	"evo.merged": "Merged:",
	"evo.pruned": "Pruned:",
	"evo.fitness": "fitness:",
	"evo.lr": "lr:",
	"evolved": "Evolved",
	"prunedDone": "Pruned",
	"btn.feed": "Feed trajectory",
	"notify.dedup": "Similar memory found, merged & reinforced",
	"notify.hideWeak": "Weak links hidden (<0.3); press E to restore",
	"notify.fed": "Trajectory fed: {n} events → 「{t}」({c} chars)",
	"notify.fedReason": "Trajectory fed: {n} events ({r})",
	"notify.fedFail": "Feed failed: ",
	"notify.evolved": "Evolved: merged {m} · pruned {p} · Gen {g}",
	"notify.pruned": "Pruned: archived {n} weak memories · trimmed {p} links",
	"notify.export": "Exported {n} memories (.md)",
	"notify.exportFail": "Export failed: ",
	"notify.import": "Imported: {i} new · {d} deduped",
	"notify.importFail": "Import failed: ",
	"notify.mergeTag": "Merged tag on {n} memories",
	"notify.mergeTagFail": "Merge failed: ",
	"notify.link": "Linked two memories, weight {w}",
	"notify.linkFail": "Link failed: ",
	"notify.unlink": "Unlinked two memories",
	"notify.unlinkNone": "No link existed between them",
	"notify.unlinkFail": "Unlink failed: ",
	"notify.review": "Reviewed & reinforced 「{t}」 strength {s}",
	"notify.reviewFail": "Review failed: ",
	"notify.reviewAll": "Reviewed {d}/{n} due memories",
	"notify.archiveWdir": "Archived workspace 「{n}」，links removed",
	"notify.archiveFail": "Archive failed: ",
	"confirm.archiveWdir": "Archive workspace 「{t}」?\nAll its links (incl. permanent preference/style links) will be removed, and won't rebuild unless the workspace is used again.",
	"hist.row": "· {time} — {by}: {summary}"
};

exports.zh = zh;
exports.en = en;
      },
      "index.js": function (module, exports, require) {
// 插件入口：注册词典 / 挂载 Remote / 注入「记忆」标签页
const { zh, en } = require("./i18n.js");
const { CONTRIBUTION } = require("./remote.js");
const { MemoryView, prefetchMemory } = require("./view.js");
const { injectStyles } = require("./styles.js");

const NS = "hippocampus";

// 样式在插件装载时注入一次
injectStyles();

const inject = ["slots", "locale", "remote"];

async function apply(ctx) {
	ctx.effect(() => ctx.locale.register(NS, { zh, en }), "hippocampus: dictionaries");
	const t = ctx.locale.bind(NS);
	const remote = ctx.get("remote");
	await remote.$mount(CONTRIBUTION);
	// 与轨迹/对话一致：预加载记忆数据，点开标签页直接展示
	prefetchMemory(ctx);
	ctx.slots.inject("conversation.view", () => ctx.slots.register({
		name: "conversation.view",
		id: "hippocampus",
		order: 20,
		locale: NS,
		label: () => t("view.memory"),
		inject: (sessionId) => ({ __ctx: ctx, sessionId })
	}, MemoryView));
}

exports.inject = inject;
exports.apply = apply;
      },
      "remote.js": function (module, exports, require) {
// Remote 契约：与宿主端 HippocampusService 的 src 方法一一对应
const PASSTHROUGH = { parse: (v) => v };
const codec = (symbol) => ({ mode: "strict", typeSymbol: symbol, schema: PASSTHROUGH });
const P = (name) => ({ name, wire: name, source: "json", codec: codec("@local/dsh-hippocampus#hippocampus/" + name) });
const D = (method, params, result) => ({
	id: "@local/dsh-hippocampus#hippocampus/" + method,
	service: "hippocampus",
	namespace: "hippocampus",
	method,
	invocation: { kind: "direct" },
	parameters: params,
	result: { mode: "strict", typeSymbol: "@local/dsh-hippocampus#hippocampus/" + method + ":result", schema: PASSTHROUGH },
	sourceLocation: { file: "packages/hippocampus/src/index.ts", line: 1, column: 1 }
});

const CONTRIBUTION = {
	package: "@local/dsh-hippocampus",
	descriptors: [
		D("list", [P("request")], "list"),
		D("get", [P("request")], "get"),
		D("create", [P("request")], "create"),
		D("update", [P("request")], "update"),
		D("forget", [P("request")], "forget"),
		D("search", [P("request")], "search"),
		D("graph", [P("request")], "graph"),
		D("stats", [P("request")], "stats"),
		D("evolve", [P("request")], "evolve"),
		D("prune", [P("request")], "prune"),
		D("analyze", [P("request")], "analyze"),
		D("drill", [P("request")], "drill"),
		D("context", [P("request")], "context"),
		D("feed", [P("request")], "feed"),
		D("optimize", [P("request")], "optimize"),
		D("resolveProject", [P("request")], "resolveProject"),
		D("archiveWorkdir", [P("request")], "archiveWorkdir"),
		D("reportWork", [P("request")], "reportWork"),
		D("tags", [P("request")], "tags"),
		D("tagRename", [P("request")], "tagRename"),
		D("exportAll", [P("request")], "exportAll"),
		D("importAll", [P("request")], "importAll"),
		D("reviewDue", [P("request")], "reviewDue"),
	D("review", [P("request")], "review"),
	D("timeline", [P("request")], "timeline"),
	D("linkManual", [P("request")], "linkManual"),
	D("linksOf", [P("request")], "linksOf"),
	D("unlinkManual", [P("request")], "unlinkManual"),
	D("evolog", [P("request")], "evolog"),
	D("injectLog", [P("request")], "injectLog")
	].map((d) => ({ ...d, result: d.result }))
};

function remoteCall(ctx, method, args) {
	const remote = ctx.get("remote");
	const ns = remote.namespaces?.get("hippocampus")?.service;
	const fn = ns?.[method];
	if (typeof fn !== "function") {
		return Promise.resolve({ ok: false, error: { code: "not-mounted", message: "hippocampus Remote 未挂载" } });
	}
	return args === void 0 ? fn() : fn(args);
}

exports.CONTRIBUTION = CONTRIBUTION;
exports.remoteCall = remoteCall;
      },
      "sim.js": function (module, exports, require) {
// 3D 仿真与数学：坐标、旋转、透视投影、搜索相关度
const { KIND_COLORS } = require("./constants.js");

function hashOf(str) {
	let x = 0;
	for (let i = 0; i < str.length; i++) x = (x * 31 + str.charCodeAt(i)) >>> 0;
	return x / 4294967296;
}

// 3D 球形神经网络：宿主端给出三维理想坐标 x0/y0/z0（归一化 -1..1），
// 客户端做 3D 旋转 + 透视投影渲染（无物理布局，仅呼吸动画）
function buildSim(graph, prev) {
	const nodes = graph.nodes.map((node) => {
		const old = prev?.nodes?.find((p) => p.id === node.id);
		return {
			id: node.id,
			title: node.title,
			kind: node.kind,
			type: node.type ?? "leaf",
			workdir: node.workdir ?? null,
			strength: node.strength,
			degree: node.degree ?? 0,
			ageDays: node.ageDays ?? 0,
			x0: node.x0 ?? 0,
			y0: node.y0 ?? 0,
			z0: node.z0 ?? 0,
			x: old?.x ?? node.x0 ?? 0,
			y: old?.y ?? node.y0 ?? 0,
			z: old?.z ?? node.z0 ?? 0,
			phase: hashOf("ph" + node.id) * Math.PI * 2,
			// v5.7 节点大小分层（收敛版）：综合 强度 + 连接度 + 层级 ——
			// 中枢节点略大、分支更小，但整体不再挤占（v5.5 公式导致核心/工作区过大重叠）
			//   rStrength: 强度 0.5~1.1（越牢固略大）
			//   rDegree:   连接度 1 + min(0.7, log2(1+degree)*0.10)（最多 ~1.7×，温和）
			//   rLayer:    核心 1.10 / 工作区 1.0 / 衍生 0.66 / 其它 0.85
			r: 3.8 * (0.5 + (node.strength ?? 0.5) * 0.6)
				* (1 + Math.min(0.7, Math.log2(1 + (node.degree ?? 0)) * 0.10))
				* (node.type === "core" ? 1.10 : node.type === "workdir" ? 1.0 : node.type === "leaf" ? 0.66 : 0.85),
			// 节点初始能量 = 真实激活强度（而非随机值），画布亮度/光晕始终反映真实 strength
			energy: old?.energy ?? node.activation ?? node.strength ?? 0,
			// v5.2：能量基线 = 真实强度 —— 非搜索态能量收敛回基线，不再衰减到全黑
			base: node.activation ?? node.strength ?? 0.4,
			color: node.type === "workdir" ? "#ffd479" : (KIND_COLORS[node.kind] ?? KIND_COLORS.other)
		};
	});
	const edges = (graph.edges ?? []).map((e) => ({ a: e.a, b: e.b, weight: e.weight }));
	return {
		nodes,
		edges,
		t: hashOf("t" + (graph.meta?.epoch ?? 1)) * 1000,
		running: prev?.running ?? true,
		prune: prev?.prune ?? false,
		hover: null,
		hoverEdge: null,
		mouse: prev?.mouse ?? { x: -9999, y: -9999, inside: false },
		rotX: prev?.rotX ?? -0.35,
		rotY: prev?.rotY ?? 0.6,
		epoch: graph.meta?.epoch
	};
}

// 3D 视图变换：旋转 + 透视投影
function rotate3(x, y, z, rotX, rotY) {
	const x1 = x * Math.cos(rotY) + z * Math.sin(rotY);
	const z1 = -x * Math.sin(rotY) + z * Math.cos(rotY);
	const y1 = y * Math.cos(rotX) - z1 * Math.sin(rotX);
	const z2 = y * Math.sin(rotX) + z1 * Math.cos(rotX);
	return { x: x1, y: y1, z: z2 };
}

/** 本地词法相关度（搜索驱动激活用） */
function lexScore(node, q) {
	if (!q) return 0;
	const t = q.toLowerCase();
	const title = String(node.title ?? "").toLowerCase();
	const kind = String(node.kind ?? "");
	let s = 0;
	if (title === t) s = Math.max(s, 1);
	if (title.includes(t)) s = Math.max(s, 0.8);
	if (kind.includes(t)) s = Math.max(s, 0.5);
	return s;
}

exports.hashOf = hashOf;
exports.buildSim = buildSim;
exports.rotate3 = rotate3;
exports.lexScore = lexScore;
      },
      "styles.js": function (module, exports, require) {
// 样式：一次性注入到页面 <head>（带插件标记，供 HMR 记账）
const css = `
.hp-root{height:100%;max-height:calc(100vh - 140px);min-height:0;display:flex;flex-direction:column;gap:10px;padding:12px 14px;box-sizing:border-box;overflow:hidden;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
.hp-header{display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex:none}
.hp-stats{display:flex;align-items:center;gap:16px;background:var(--dsw-alias-bg-elevated,#0e1420);border:1px solid var(--dsw-alias-border-l2,#232b3a);border-radius:10px;padding:6px 14px}
.hp-stat{display:flex;flex-direction:column;line-height:1.25}
.hp-stat-v{font-size:17px;font-weight:600;color:var(--dsw-alias-label-primary,#eef4fb)}
.hp-stat-k{font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa4b2)}
.hp-search{flex:1;min-width:140px;max-width:260px;height:32px;border:1px solid var(--dsw-alias-border-l2,#232b3a);border-radius:8px;background:var(--dsw-alias-bg-elevated,#0e1420);color:var(--dsw-alias-label-primary,#e6edf3);padding:0 10px;font-size:13px;outline:none}
.hp-search:focus{border-color:#3d6df2}
.hp-chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.hp-chip{height:26px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,#232b3a);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,#b6bfcc);font-size:12px;cursor:pointer}
.hp-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.hp-chip[data-on]{background:#1f3a8a33;border-color:#3d6df2;color:#7ea6ff}
.hp-btn{height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,#232b3a);border-radius:8px;background:var(--dsw-alias-bg-elevated,#0e1420);color:var(--dsw-alias-label-secondary,#b6bfcc);font-size:12px;cursor:pointer;white-space:nowrap}
.hp-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.hp-btn-primary{border-color:#3d6df2;color:#8ab4ff;background:#1f3a8a33}
.hp-btn-danger{color:#ff7b72}
.hp-body{display:flex;gap:10px;flex:1;min-height:0}
.hp-canvas-wrap{flex:1;min-width:280px;position:relative;border:1px solid var(--dsw-alias-border-l2,#232b3a);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-base,#070b12)}
.hp-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;cursor:crosshair}
.hp-hints{position:absolute;left:10px;bottom:8px;display:flex;gap:12px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8b96a5);pointer-events:none;user-select:none;font-family:ui-sans-serif,system-ui,sans-serif}
.hp-empty-overlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--dsw-alias-label-tertiary,#5b6472);font-size:12px;pointer-events:none;text-align:center;padding:0 30px}
.hp-list{width:min(400px,42%);flex:none;overflow-y:auto;display:flex;flex-direction:column;gap:6px;padding-right:2px}
/* v5.3：分类抽屉盒（按种类分组） */
.hp-group-head{display:flex;align-items:center;gap:7px;padding:5px 6px;border-radius:8px;cursor:pointer;user-select:none;background:transparent;transition:background .12s}
.hp-group-head:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.hp-group-dot{width:8px;height:8px;border-radius:50%;flex:none;box-shadow:0 0 6px currentColor}
.hp-group-name{flex:1;min-width:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#b6bfcc);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hp-group-count{font-size:10px;color:#7d8590;background:#1c2432;border-radius:999px;padding:0 7px;line-height:16px;flex:none;font-family:ui-monospace,Menlo,monospace}
.hp-group-arrow{font-size:10px;color:#7d8590;flex:none}
/* v5.3：全屏专注模式 —— 隐藏左右/顶部工具栏，3D 视图占满 */
.hp-focus .hp-header,.hp-focus .hp-left,.hp-focus .hp-list{display:none}
.hp-focus{max-height:none;padding:8px;gap:0}
.hp-focus .hp-body{flex:1}
.hp-focus .hp-canvas-wrap{min-width:0;border-radius:12px}
.hp-exit-focus{position:absolute;top:12px;right:12px;z-index:20;height:30px;padding:0 14px;border:1px solid #3d6df2;border-radius:8px;background:rgba(13,20,32,.88);color:#8ab4ff;font-size:12px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.35);backdrop-filter:blur(4px)}
.hp-exit-focus:hover{background:#1f3a8a55}
.hp-card{background:var(--dsw-alias-bg-elevated,#0e1420);border:1px solid var(--dsw-alias-border-l2,#232b3a);border-radius:10px;padding:10px 12px;cursor:pointer;transition:border-color .12s, transform .12s, box-shadow .12s}
.hp-card:hover{border-color:#3d6df2aa;transform:translateY(-1px);box-shadow:0 6px 18px rgba(0,0,0,.22)}
.hp-card[data-selected]{border-color:#3d6df2;box-shadow:0 0 0 1px #3d6df255}
.hp-card.hp-due{border-color:#ffd47988}
.hp-due-badge{font-size:11px;flex:none}
.hp-card-top{display:flex;align-items:center;gap:8px}
.hp-badge{font-size:11px;padding:1px 9px;border-radius:999px;flex:none;color:#0b0e14;font-weight:600}
.hp-card-title{flex:1;min-width:0;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#eef4fb);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hp-card-meta{font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa4b2);flex:none}
.hp-strength{height:3px;border-radius:2px;background:#1c2432;margin:7px 0 6px;overflow:hidden}
.hp-strength i{display:block;height:100%;border-radius:2px;background:linear-gradient(90deg,#3d6df2,#4fc3f7)}
.hp-card-content{font-size:13px;line-height:1.55;color:var(--dsw-alias-label-secondary,#b6bfcc);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.hp-tags{display:flex;gap:5px;flex-wrap:wrap;margin-top:6px}
.hp-tag{font-size:11px;color:#7ea6ff;background:#1f3a8a33;padding:1px 7px;border-radius:999px}
.hp-card-actions{display:flex;gap:6px;margin-top:8px}
.hp-mini{font-size:12px;color:var(--dsw-alias-label-secondary,#b6bfcc);background:transparent;border:1px solid var(--dsw-alias-border-l2,#232b3a);border-radius:6px;padding:3px 9px;cursor:pointer}
.hp-mini:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.hp-modal{position:fixed;inset:0;background:rgba(2,6,12,.6);display:flex;align-items:center;justify-content:center;z-index:1200;backdrop-filter:blur(2px)}
.hp-modal-box{width:min(560px,92vw);max-height:86vh;overflow-y:auto;background:var(--dsw-alias-bg-base,#0b1018);border:1px solid var(--dsw-alias-border-l2,#232b3a);border-radius:14px;padding:18px 20px;box-shadow:0 18px 60px rgba(0,0,0,.5)}
.hp-modal-title{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,#e6edf3);margin-bottom:14px}
.hp-field{margin-bottom:12px}
.hp-field label{display:block;font-size:12px;color:var(--dsw-alias-label-secondary,#b6bfcc);margin-bottom:5px}
.hp-input{width:100%;box-sizing:border-box;height:32px;border:1px solid var(--dsw-alias-border-l2,#232b3a);border-radius:8px;background:var(--dsw-alias-bg-elevated,#0e1420);color:var(--dsw-alias-label-primary,#e6edf3);padding:0 10px;font-size:13px;outline:none}
.hp-input:focus{border-color:#3d6df2}
.hp-textarea{width:100%;box-sizing:border-box;min-height:110px;resize:vertical;border:1px solid var(--dsw-alias-border-l2,#232b3a);border-radius:8px;background:var(--dsw-alias-bg-elevated,#0e1420);color:var(--dsw-alias-label-primary,#e6edf3);padding:8px 10px;font-size:13px;line-height:1.55;outline:none;font-family:inherit}
.hp-textarea:focus{border-color:#3d6df2}
.hp-row{display:flex;gap:10px}
.hp-row .hp-field{flex:1}
.hp-range{width:100%;accent-color:#3d6df2}
.hp-range-val{font-size:11px;color:#7ea6ff;margin-left:6px}
.hp-modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
.hp-note{font-size:12px;color:var(--dsw-alias-label-tertiary,#9aa4b2);margin-top:10px;line-height:1.6}
.hp-history{font-size:12px;color:var(--dsw-alias-label-tertiary,#9aa4b2);margin-top:6px}
.hp-history div{display:flex;gap:6px}
.hp-toast{position:fixed;right:18px;bottom:18px;background:#123;border:1px solid #3d6df2;color:#8ab4ff;padding:8px 14px;border-radius:10px;font-size:12px;z-index:1300;box-shadow:0 8px 30px rgba(0,0,0,.4)}
.hp-error{color:#ff7b72;font-size:12px;padding:8px 0}
.hp-loading{color:#5b6472;font-size:12px;padding:20px 0;text-align:center}
.hp-left{width:208px;flex:none;display:flex;flex-direction:column;gap:10px;min-width:188px;min-height:0;overflow-y:auto;overflow-x:hidden;padding-right:2px;scrollbar-width:thin;scrollbar-color:#2a3550 transparent}
.hp-left::-webkit-scrollbar{width:6px}
.hp-left::-webkit-scrollbar-thumb{background:#2a3550;border-radius:3px}
.hp-collapse{cursor:pointer;user-select:none;justify-content:space-between}
.hp-collapse:hover{color:#b6bfcc}
.hp-collapse-arrow{font-size:10px;color:#7d8590;margin-left:auto;flex:none}
.hp-panel{background:var(--dsw-alias-bg-elevated,#0e1420);border:1px solid var(--dsw-alias-border-l2,#232b3a);border-radius:10px;padding:10px 12px}
.hp-panel-title{font-size:11px;letter-spacing:.08em;color:#7d8590;text-transform:uppercase;margin-bottom:8px;font-family:ui-monospace,Menlo,monospace;display:flex;align-items:center;gap:6px}
.hp-panel-title i{width:6px;height:6px;border-radius:50%;display:inline-block;box-shadow:0 0 6px currentColor}
.hp-legend{display:flex;flex-direction:column;gap:5px}
.hp-legend-row{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--dsw-alias-label-secondary,#b6bfcc)}
.hp-legend-dot{width:10px;height:10px;border-radius:50%;flex:none;box-shadow:0 0 7px currentColor}
.hp-legend-hint{display:flex;align-items:center;gap:7px;font-size:11px;color:#7d8590;margin-top:3px}
.hp-legend-size{width:14px;height:3px;border-radius:2px;flex:none;background:linear-gradient(90deg,#5b6472,#4fc3f7)}
.hp-legend-line{width:16px;height:3px;border-radius:2px;flex:none;background:currentColor;box-shadow:0 0 5px currentColor}
/* v5.4/v5.5：图例 —— 金色锚环 / ⟡ 联想交汇 */
.hp-legend-anchor{width:10px;height:10px;border-radius:50%;flex:none;border:2px solid #ffd479;box-shadow:0 0 6px #ffd47988}
.hp-legend-cross{width:10px;height:10px;border-radius:50%;flex:none;background:#ba68c833;border:1px dashed #ba68c8;color:#ba68c8;text-align:center;line-height:9px;font-size:8px}
.hp-tag-cloud{display:flex;flex-wrap:wrap;gap:5px}
.hp-tag-chip{font-size:11px;color:#7ea6ff;background:#1f3a8a33;padding:2px 8px;border-radius:999px;cursor:pointer;user-select:none;border:1px solid transparent}
.hp-tag-chip:hover{background:#1f3a8a55}
.hp-tag-chip[data-on]{background:#ffd47922;border-color:#ffd479;color:#ffd479}
.hp-quality{font-size:10px;padding:0 6px;border-radius:999px;flex:none;line-height:16px}
.hp-quality[data-q=good]{color:#3fb950;background:#2ea04322}
.hp-quality[data-q=mid]{color:#d29922;background:#9e6a031f}
.hp-quality[data-q=low]{color:#ff7b72;background:#f851491f}
.hp-ctrl-status{display:inline-block;font-size:10px;padding:1px 7px;border-radius:999px;background:#2ea04333;color:#3fb950;margin-bottom:8px;font-family:ui-monospace,Menlo,monospace}
.hp-ctrl-status[data-off]{background:#f8514933;color:#ff7b72}
.hp-ctrl-row{display:flex;align-items:center;justify-content:space-between;font-size:12px;color:var(--dsw-alias-label-secondary,#b6bfcc);margin-bottom:4px}
.hp-ctrl-row b{color:var(--dsw-alias-label-primary,#eef4fb);font-weight:600;font-family:ui-monospace,Menlo,monospace}
.hp-ctrl-btns{display:flex;flex-direction:column;gap:6px;margin-top:8px}
.hp-ctrl-btns .hp-btn{width:100%}
.hp-tut-toggle{width:100%;height:26px;margin-top:2px;border:1px dashed #3d6df288;border-radius:8px;background:#1f3a8a22;color:#8ab4ff;font-size:12px;cursor:pointer}
.hp-tut-toggle:hover{background:#1f3a8a44}
.hp-tut{font-size:12px;line-height:1.7;color:#aab4c2;padding:8px 10px 9px;margin-top:2px;background:rgba(10,16,28,.6);border:1px solid #1c2432;border-radius:8px}
.hp-tut-item{margin-bottom:6px}
.hp-tut-item:last-child{margin-bottom:0}
.hp-tut-item b{color:#8ab4ff;font-weight:700}
.hp-tut-k{color:#81c784}
.hp-tut-e{color:#ba68c8}
.hp-statusbar{position:absolute;left:0;right:0;bottom:0;height:28px;display:flex;align-items:center;gap:14px;padding:0 12px;background:color-mix(in srgb, var(--dsw-alias-bg-elevated,#0e1420) 88%, transparent);backdrop-filter:blur(3px);border-top:1px solid var(--dsw-alias-border-l2,#1c2432);font-family:ui-sans-serif,system-ui,sans-serif;font-size:12px;color:var(--dsw-alias-label-tertiary,#9aa4b2);pointer-events:none;z-index:3;overflow:hidden;white-space:nowrap}
.hp-statusbar b{color:var(--dsw-alias-label-primary,#e6f1ff);font-weight:600}
.hp-statusbar .hp-sel{display:flex;gap:14px;min-width:0;overflow:hidden}
.hp-statusbar .hp-sel span{overflow:hidden;text-overflow:ellipsis}
.hp-status-right{margin-left:auto;display:flex;gap:14px;color:#7d8590;flex:none}
.hp-status-right b{color:#9aa4b2}
.hp-layer-label{position:absolute;top:8px;font-size:9px;letter-spacing:.06em;color:rgba(120,140,190,.38);pointer-events:none;font-family:ui-monospace,Menlo,monospace;text-transform:uppercase;transform:translateX(-50%)}
.hp-layer-arrow{position:absolute;top:22px;font-size:8px;color:rgba(120,140,190,.22);pointer-events:none;font-family:ui-monospace,Menlo,monospace;transform:translateX(-50%)}
.hp-degree{font-size:10px;color:#7ea6ff;background:#1f3a8a33;border-radius:999px;padding:1px 7px;flex:none}
.hp-age{font-size:10px;color:#7d8590;flex:none}
.hp-review{border-color:#ffd479;color:#ffd479}
.hp-review[data-on]{background:#ffd47922;border-color:#ffd479}
.hp-inject-log,.hp-evolog-list{display:flex;flex-direction:column;gap:6px;max-height:52vh;overflow-y:auto}
.hp-log-row{display:flex;align-items:center;gap:8px;padding:5px 8px;background:var(--dsw-alias-bg-elevated,#0e1420);border:1px solid var(--dsw-alias-border-l2,#232b3a);border-radius:8px;font-size:12px}
.hp-log-time{color:#7d8590;font-family:ui-monospace,Menlo,monospace;flex:none}
.hp-log-mode{font-size:10px;padding:1px 7px;border-radius:999px;flex:none;background:#1f3a8a33;color:#7ea6ff}
.hp-log-mode[data-mode=tool]{background:#81c78422;color:#81c784}
.hp-log-mode[data-mode=refresh]{background:#ffd47922;color:#ffd479}
.hp-log-count{color:#b6bfcc;flex:none}
.hp-log-chars{color:#7d8590;flex:none}
.hp-log-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e6edf3}
.hp-link-list{display:flex;flex-wrap:wrap;gap:5px}
.hp-link-item{font-size:11px;color:#7ea6ff;background:#1f3a8a33;padding:2px 8px;border-radius:999px;cursor:pointer;user-select:none}
.hp-link-item:hover{background:#1f3a8a55}
.hp-evolog-row{padding:7px 9px;background:var(--dsw-alias-bg-elevated,#0e1420);border:1px solid var(--dsw-alias-border-l2,#232b3a);border-radius:8px}
.hp-evolog-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px}
.hp-evolog-epoch{font-size:12px;font-weight:600;color:#c792ea;font-family:ui-monospace,Menlo,monospace}
.hp-evolog-time{font-size:11px;color:#7d8590;font-family:ui-monospace,Menlo,monospace}
.hp-evolog-stats{display:flex;gap:12px;font-size:11px;color:#b6bfcc}
.hp-evolog-stats span{color:#7ea6ff}
/* v5.2：头部「工具」下拉 */
.hp-tools{position:relative;flex:none}
.hp-tools-menu{position:absolute;right:0;top:calc(100% + 6px);min-width:168px;background:var(--dsw-alias-bg-elevated,#0e1420);border:1px solid var(--dsw-alias-border-l2,#232b3a);border-radius:10px;padding:5px;display:flex;flex-direction:column;gap:2px;z-index:60;box-shadow:0 12px 36px rgba(0,0,0,.45);backdrop-filter:blur(4px)}
.hp-tools-item{height:30px;padding:0 10px;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#b6bfcc);font-size:12px;text-align:left;cursor:pointer;white-space:nowrap}
.hp-tools-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07));color:var(--dsw-alias-label-primary,#e6edf3)}
.hp-tools-item:disabled{opacity:.4;cursor:not-allowed}
/* v5.2：滚动条与过渡微调 */
.hp-list::-webkit-scrollbar{width:7px}
.hp-list::-webkit-scrollbar-thumb{background:#2a3550;border-radius:4px}
.hp-list::-webkit-scrollbar-thumb:hover{background:#35416a}
.hp-btn{transition:border-color .12s, background .12s, color .12s}
.hp-toast{animation:hp-toast-in .18s ease-out}
@keyframes hp-toast-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
`;

function injectStyles() {
	if (typeof document === "undefined" || document.querySelector("style[data-plugin-css=\"@local/dsh-hippocampus/MemoryView\"]") !== null) return;
	const tag = document.createElement("style");
	tag.dataset.plugin = "@local/dsh-hippocampus";
	tag.dataset.pluginCss = "@local/dsh-hippocampus/MemoryView";
	tag.textContent = css;
	document.head.appendChild(tag);
}

exports.injectStyles = injectStyles;
      },
      "view.js": function (module, exports, require) {
// 主视图：记忆标签页装配（数据加载 / 搜索 / 演化 / 列表 / 画布 / 面板）
const React = require("react");
const { useState, useEffect, useRef, useMemo, useCallback, Fragment, createElement: h } = React;
const { zh, en } = require("./i18n.js");
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
	// v5.8：界面语言手动切换（cn/en，不依赖 DSH 全局语言）；t 支持 {param} 插值
	const [uiLang, setUiLang] = useState("zh");
	const t = useCallback((key, params) => {
		const d = uiLang === "en" ? en : zh;
		let s = d[key] ?? (uiLang === "en" ? zh[key] : key) ?? key;
		if (s && params) s = String(s).replace(/\{(\w+)\}/g, (_, k) => (params[k] !== void 0 ? String(params[k]) : "{" + k + "}"));
		return s;
	}, [uiLang]);
	const toggleLang = useCallback(() => setUiLang((v) => (v === "zh" ? "en" : "zh")), []);
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
			// 并行拉取列表/图/统计（统计附带激活锚点 → 金色锚环可视化）
			const [listRes, graphRes, statsRes] = await Promise.all([
				remoteCall(ctx, "list", { includeArchived: true, ...scopeArgs }),
				remoteCall(ctx, "graph", scopeArgs).catch(() => ({ ok: false })),
				remoteCall(ctx, "stats", scopeArgs).catch(() => ({ ok: false }))
			]);
			if (!listRes.ok) throw new Error(listRes.error?.message ?? "list failed");
			setBranches(listRes.value.branches ?? []);
			setMeta(listRes.value.meta ?? null);
			if (graphRes.ok) setGraph(graphRes.value);
			if (statsRes.ok) {
				const an = statsRes.value?.anchors ?? [];
				if (an.length) setAnchors(new Set(an.map((a) => String(a.id))));
			}
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
	const [anchors, setAnchors] = useState(() => new Set());
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
				// v5.4：检索响应带激活锚点 → 金色锚环实时更新
				const an = res.value?.anchors ?? [];
				if (an.length) setAnchors(new Set(an.map((a) => String(a.id))));
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
			if (res.value?.dedup) notify(t("notify.dedup"));
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
		notify(t("notify.evolved", { m: v.merged ?? 0, p: v.prunedLinks ?? 0, g: v.meta?.generation ?? 0 }));
		setGraph(res.value);
		await loadAll(true);
	}, [ctx, loadAll, notify, t, scopeArgs]);

	// 真实修剪（宿主端归档弱且久的记忆）
	const prune = useCallback(async () => {
		const res = await remoteCall(ctx, "prune", scopeArgs);
		if (!res.ok) return;
		const v = res.value ?? {};
		notify(t("notify.pruned", { n: v.pruned ?? 0, p: v.prunedLinks ?? 0 }));
		setGraph(res.value);
		await loadAll(true);
	}, [ctx, loadAll, notify, t, scopeArgs]);

	// 仅切换画布内「弱连接隐藏」（E 键视觉开关）
	const [pruneTick, setPruneTick] = useState(0);
	const doPruneView = useCallback(() => {
		setPruneTick((v) => v + 1);
		notify(t("notify.hideWeak"));
	}, [notify]);

	// 轨迹喂养：把当前对话的「轨迹」内容（用户/助手/工具消息，
	// 与轨迹标签页同源）喂养到本项目记忆。手动点击 = 全量喂养整个对话历史；
	// 每小时定时任务自动增量喂养。显式携带 sessionId，确保命中当前会话轨迹。
	const feed = useCallback(async () => {
		const res = await remoteCall(ctx, "feed", { ...scopeArgs, sessionId: sessionIdOf(), sinceMs: 0 });
		if (!res.ok) { notify(t("notify.fedFail") + (res.error?.message ?? "?")); return; }
		const v = res.value ?? {};
		if (v.wrote) {
			notify(t("notify.fed", { n: v.fed ?? 0, t: v.title ?? "session", c: v.chars ?? 0 }) + (v.size?.triggered ? " ⚠" : ""));
		} else {
			notify(t("notify.fedReason", { n: v.fed ?? 0, r: v.reason ?? "" }));
		}
		await loadAll(true);
	}, [ctx, loadAll, notify, scopeArgs, t]);

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

	// v5.3：按种类分组的抽屉盒 —— 每组（偏好/交流/工作状态/洞察/其他）可独立折叠
	const KIND_ORDER = { preference: 0, communication: 1, workstate: 2, insight: 3, other: 4 };
	const kindGroups = useMemo(() => {
		const map = new Map();
		for (const b of filtered) {
			const k = b.kind ?? "other";
			if (!map.has(k)) map.set(k, []);
			map.get(k).push(b);
		}
		return [...map.entries()].sort((a, b) => (KIND_ORDER[a[0]] ?? 9) - (KIND_ORDER[b[0]] ?? 9));
	}, [filtered]);
	const toggleKind = useCallback((kind) => {
		setCollapsedKinds((prev) => {
			const next = new Set(prev);
			if (next.has(kind)) next.delete(kind); else next.add(kind);
			return next;
		});
	}, []);

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
		if (!res.ok) { notify(t("notify.archiveFail") + (res.error?.message ?? "?")); return; }
		notify(t("notify.archiveWdir", { n: workdirPath.split(/[/\\]+/).filter(Boolean).pop() ?? workdirPath }));
		await loadAll(true);
	}, [ctx, loadAll, notify, t]);

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
		if (!res.ok) { notify(t("notify.exportFail") + (res.error?.message ?? "?")); return; }
		const text = res.value?.text ?? "";
		const count = (text.match(/^##\s/gm) ?? []).length;
		const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = "hippocampus-memory-" + new Date().toISOString().slice(0, 10) + ".md";
		a.click();
		URL.revokeObjectURL(url);
		notify(t("notify.export", { n: count }));
	}, [ctx, notify, scopeArgs, t]);

	// 导入记忆（Markdown/文本）
	const onImportFile = useCallback(async (e) => {
		const file = e.target?.files?.[0];
		if (e.target) e.target.value = "";
		if (!file) return;
		try {
			const text = await file.text();
			const res = await remoteCall(ctx, "importAll", { text, ...scopeArgs });
			if (!res.ok) { notify(t("notify.importFail") + (res.error?.message ?? "?")); return; }
			notify(t("notify.import", { i: res.value?.imported ?? 0, d: res.value?.dedup ?? 0 }));
			await loadAll(true);
		} catch (err) {
			notify(t("notify.importFail") + String(err?.message ?? err));
		}
	}, [ctx, loadAll, notify, scopeArgs, t]);

	// 合并/重命名标签
	const mergeTag = useCallback(async (tag) => {
		const to = window.prompt(uiLang === "en" ? "Merge/rename tag \"" + tag + "\" to:" : "把标签「" + tag + "」合并/重命名为：", tag);
		if (!to || to.trim() === tag) return;
		const res = await remoteCall(ctx, "tagRename", { from: tag, to: to.trim(), ...scopeArgs });
		if (!res.ok) { notify(t("notify.mergeTagFail") + (res.error?.message ?? "?")); return; }
		notify(t("notify.mergeTag", { n: res.value?.renamed ?? 0 }));
		await loadAll(true);
	}, [ctx, loadAll, notify, scopeArgs]);

	const [viewMode, setViewMode] = useState("list");
	const [timelineEvents, setTimelineEvents] = useState(null);
	// 标签云折叠：默认展开，过长时可收起为一行计数，释放左侧面板空间
	const [tagCloudOpen, setTagCloudOpen] = useState(true);
	// v5.3：右侧记忆列表按种类分组成「抽屉盒」（可折叠）；默认全展开
	const [collapsedKinds, setCollapsedKinds] = useState(() => new Set());
	// v5.3：全屏专注模式 —— 隐藏左右/顶部工具栏，3D 视图占满
	const [focusMode, setFocusMode] = useState(false);
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

	const INJECT_MODES = uiLang === "en"
		? { auto: "Auto", tool: "Tool", refresh: "Refresh" }
		: { auto: "对话前自动", tool: "工具调取", refresh: "界面刷新" };
	const fmtTime = useCallback((ts) => {
		if (!ts) return "";
		const d = new Date(ts);
		const p = (n) => String(n).padStart(2, "0");
		return (d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
	}, []);

	// 复习一条记忆
	const doReview = useCallback(async (id) => {
		const res = await remoteCall(ctx, "review", { id, ...scopeArgs });
		if (!res.ok) { notify(t("notify.reviewFail") + (res.error?.message ?? "?")); return; }
		notify(t("notify.review", { t: res.value?.title ?? "", s: (res.value?.strength ?? 0).toFixed(2) }));
		await loadAll(true);
	}, [ctx, loadAll, notify, scopeArgs, t]);

	// 批量复习全部到期记忆
	const reviewAllDue = useCallback(async () => {
		if (dueIds.size === 0) return;
		let done = 0;
		for (const id of dueIds) {
			try { await remoteCall(ctx, "review", { id, ...scopeArgs }); done++; } catch { /* 单条失败继续 */ }
		}
		notify(t("notify.reviewAll", { d: done, n: dueIds.size }));
		setShowReviewOnly(false);
		await loadAll(true);
	}, [ctx, dueIds, loadAll, notify, scopeArgs, t]);

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
		if (!res.ok) { notify(t("notify.linkFail") + (res.error?.message ?? "?")); return; }
		notify(t("notify.link", { w: (res.value?.weight ?? linkWeight).toFixed(2) }));
		setShowLinker(false);
		await loadAll(true);
	}, [ctx, linkA, linkB, linkWeight, loadAll, notify, scopeArgs, t]);

	// 手动断开突触
	const doUnlink = useCallback(async () => {
		if (!linkA || !linkB || linkA === linkB) return;
		const res = await remoteCall(ctx, "unlinkManual", { a: linkA, b: linkB, ...scopeArgs });
		if (!res.ok) { notify(t("notify.unlinkFail") + (res.error?.message ?? "?")); return; }
		notify(res.value?.unlinked ? t("notify.unlink") : t("notify.unlinkNone"));
		setShowLinker(false);
		await loadAll(true);
	}, [ctx, linkA, linkB, loadAll, notify, scopeArgs, t]);

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
					t("legend.links")),
				h("div", { className: "hp-legend-hint" },
					h("span", { className: "hp-legend-anchor" }),
					t("legend.anchor")),
				h("div", { className: "hp-legend-hint" },
					h("span", { className: "hp-legend-cross" }),
					t("legend.cross")))),
		h("div", { className: "hp-panel" },
			h("div", { className: "hp-panel-title" },
				h("i", { style: { color: "#7fa8ff" } }),
				t("conn.legend")),
			h("div", { className: "hp-legend" },
				REASONS.map((r) => h("div", { className: "hp-legend-row", key: r.label },
					h("span", { className: "hp-legend-line", style: { background: r.color, color: r.color } }),
					r.label)))),
		h("div", { className: "hp-panel" },
			h("div", { className: "hp-panel-title hp-collapse", onClick: () => setTagCloudOpen((v) => !v), title: tagCloudOpen ? t("tagcloud.title") : t("tagcloud.title") },
				h("i", { style: { color: "#ffd479" } }),
				t("tagcloud.title"),
				h("span", { className: "hp-collapse-arrow" }, tagCloudOpen ? "▾" : "▸")),
			tagCloudOpen ? h("div", { className: "hp-tag-cloud" },
				tagCloud.length === 0 ? h("div", { className: "hp-legend-hint" }, t("tagcloud.empty")) : null,
				tagCloud.map(({ tag, count }) => h("span", { key: tag, className: "hp-tag-chip", "data-on": tagFilter === tag || undefined, title: t("tagcloud.title"), onClick: () => setTagFilter(tagFilter === tag ? null : tag), onContextMenu: (e) => { e.preventDefault(); mergeTag(tag); } }, tag + " " + count)))
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
		h("button", { className: "hp-tut-toggle", onClick: () => setShowTutorial((v) => !v) }, (showTutorial ? "▾ " : "▸ ") + t("tut.title")),
		showTutorial ? h("div", { className: "hp-tut" },
			h("div", { className: "hp-tut-item" }, h("b", null, t("tut.what")), t("tut.what.desc")),
			h("div", { className: "hp-tut-item" }, h("b", null, t("tut.cap")), t("tut.cap.desc")),
			h("div", { className: "hp-tut-item" }, h("b", null, t("tut.done")), t("tut.done.desc")),
			h("div", { className: "hp-tut-item" }, h("b", null, t("tut.why")), t("tut.why.desc")))
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

	return h("div", { className: "hp-root" + (focusMode ? " hp-focus" : "") },
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
				dueCount > 0 ? h("button", { className: "hp-btn hp-review", "data-on": showReviewOnly || undefined, onClick: () => setShowReviewOnly((v) => !v), title: t("btn.review") }, t("btn.review") + " " + dueCount) : null,
				h("button", { className: "hp-btn", onClick: loadAll }, t("btn.refresh")),
				// v5.3：全屏专注 —— 隐藏左右/顶部工具栏，3D 视图占满（Esc / 画布内按钮退出）
				h("button", { className: "hp-btn hp-btn-primary", onClick: () => setFocusMode(true), title: t("btn.fullscreen") }, t("btn.fullscreen")),
				// v5.8：界面语言切换（cn / en）
				h("button", { className: "hp-btn" + (uiLang === "en" ? " hp-btn-primary" : ""), onClick: toggleLang, title: uiLang === "en" ? "切换中文" : "Switch to English" }, uiLang === "en" ? "中 / EN" : "EN / 中"),
				// v5.2：次要工具收纳进「工具」下拉（导出/导入/F9/F5/F6），顶栏不再拥挤
				h("div", { className: "hp-tools", ref: toolsRef },
					h("button", { className: "hp-btn" + (toolsOpen ? " hp-btn-primary" : ""), onClick: () => setToolsOpen((v) => !v), title: t("btn.tools") }, t("btn.tools") + " " + (toolsOpen ? "▾" : "▸")),
					toolsOpen ? h("div", { className: "hp-tools-menu" },
						h("button", { className: "hp-tools-item", onClick: () => { setToolsOpen(false); onExport(); } }, t("btn.tools.export")),
						h("button", { className: "hp-tools-item", onClick: () => { setToolsOpen(false); importRef.current?.click(); } }, t("btn.tools.import")),
						h("button", { className: "hp-tools-item", onClick: () => { setToolsOpen(false); openInjectLog(); } }, t("btn.tools.inject")),
						h("button", { className: "hp-tools-item", onClick: () => { setToolsOpen(false); openLinker(); }, disabled: !selectedId }, selectedId ? t("btn.tools.link") : t("btn.tools.linkNeed")),
						h("button", { className: "hp-tools-item", onClick: () => { setToolsOpen(false); openEvolog(); } }, t("btn.tools.evolog")))
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
							onArchiveWorkdir: archiveWorkdir,
							focusMode,
							onToggleFocus: () => setFocusMode((v) => !v),
							anchors
						}),
							// v5.3：右侧分类抽屉盒（按种类分组，可折叠）
							h("div", { className: "hp-list" },
								archivedCount > 0 ? h("div", { className: "hp-card-meta", style: { padding: "0 4px" } }, t("list.active") + " " + activeCount + " · " + t("list.archived") + " " + archivedCount) : null,
								kindGroups.map(([kind, items]) => {
									const collapsed = collapsedKinds.has(kind);
									return h(Fragment, { key: kind },
										h("div", { className: "hp-group-head", onClick: () => toggleKind(kind), title: (collapsed ? (uiLang === "en" ? "Expand " : "展开 ") : (uiLang === "en" ? "Collapse " : "折叠 ")) + t("kind." + kind) },
											h("span", { className: "hp-group-dot", style: { background: KIND_COLORS[kind] ?? KIND_COLORS.other, color: KIND_COLORS[kind] ?? KIND_COLORS.other } }),
											h("span", { className: "hp-group-name" }, t("kind." + kind)),
											h("span", { className: "hp-group-count" }, String(items.length)),
											h("span", { className: "hp-group-arrow" }, collapsed ? "▸" : "▾")),
										collapsed ? null : items.map((branch) => h(BranchCard, {
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
										})));
								}),
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
					h("div", { className: "hp-modal-title" }, t("f9.title")),
					h("div", { className: "hp-inject-log" },
						injectLogData ? injectLogData.map((e) =>
							h("div", { key: e.id, className: "hp-log-row" },
								h("span", { className: "hp-log-time" }, fmtTime(e.ts)),
								h("span", { className: "hp-log-mode", "data-mode": e.mode }, INJECT_MODES[e.mode] ?? e.mode),
								h("span", { className: "hp-log-count" }, e.count + (uiLang === "en" ? " items" : " 条")),
								h("span", { className: "hp-log-chars" }, e.chars + (uiLang === "en" ? " chars" : " 字")),
								e.title ? h("span", { className: "hp-log-title" }, e.title) : null
							)
						) : h("div", { className: "hp-loading" }, t("loading2"))))) : null,
			// F5：手动突触连接/断开模态框
			showLinker ? h("div", { className: "hp-modal", onClick: () => setShowLinker(false) },
				h("div", { className: "hp-modal-box", onClick: (e) => e.stopPropagation() },
					h("div", { className: "hp-modal-title" }, t("f5.title")),
					h("div", { className: "hp-field" },
						h("label", null, t("link.a")),
						h("input", { className: "hp-input", type: "text", value: linkA, onChange: (e) => setLinkA(e.target.value), placeholder: selectedId ? selectedId : (uiLang === "en" ? "enter memory id" : "输入记忆 id") })),
					h("div", { className: "hp-field" },
						h("label", null, t("link.b")),
						h("input", { className: "hp-input", type: "text", value: linkB, onChange: (e) => setLinkB(e.target.value), placeholder: uiLang === "en" ? "enter memory id" : "输入记忆 id" })),
					h("div", { className: "hp-field" },
						h("label", null, t("link.weight") + " " + linkWeight.toFixed(2)),
						h("input", { className: "hp-range", type: "range", min: "0.05", max: "1", step: "0.05", value: linkWeight, onChange: (e) => setLinkWeight(parseFloat(e.target.value)) }),
						h("span", { className: "hp-range-val" }, linkWeight.toFixed(2))),
					linkRelations && linkRelations.length > 0 ? h("div", { className: "hp-field" },
						h("label", null, t("link.current") + " (" + selectedId + ")"),
						h("div", { className: "hp-link-list" },
							linkRelations.map((l) => h("span", { key: l.other, className: "hp-link-item", onClick: () => l.other === linkA ? setLinkB(l.other) : setLinkA(l.other), title: (uiLang === "en" ? "click to fill " : "点击填入 ") + l.title }, l.title + " (" + l.weight.toFixed(2) + ")")))) : null,
					h("div", { className: "hp-modal-actions" },
						h("button", { className: "hp-btn hp-btn-primary", onClick: doLink, disabled: !linkA || !linkB || linkA === linkB }, t("link.connect")),
						h("button", { className: "hp-btn", onClick: doUnlink, disabled: !linkA || !linkB || linkA === linkB }, t("link.disconnect")),
						h("button", { className: "hp-btn", onClick: () => setShowLinker(false) }, t("btn.cancel"))))) : null,
			// F6：演化日志模态框
			showEvolog ? h("div", { className: "hp-modal", onClick: () => setShowEvolog(false) },
				h("div", { className: "hp-modal-box", onClick: (e) => e.stopPropagation() },
					h("div", { className: "hp-modal-title" }, t("f6.title")),
					h("div", { className: "hp-evolog-list" },
						evologData ? evologData.map((e) =>
							h("div", { key: e.id, className: "hp-evolog-row" },
								h("div", { className: "hp-evolog-head" },
									h("span", { className: "hp-evolog-epoch" }, t("evo.epochGen", { e: e.epoch, g: e.generation })),
									h("span", { className: "hp-evolog-time" }, fmtTime(e.ts))),
								h("div", { className: "hp-evolog-stats" },
									h("span", null, t("evo.merged") + " " + e.merged),
									h("span", null, t("evo.pruned") + " " + e.prunedLinks),
									h("span", null, t("evo.fitness") + " " + (e.fitnessAfter ?? 0).toFixed(3)),
									h("span", null, t("evo.lr") + " " + (e.lr ?? 0.01).toFixed(3)))
							)
						) : h("div", { className: "hp-loading" }, t("loading2"))))) : null
		);
}

exports.MemoryView = MemoryView;
exports.prefetchMemory = prefetchMemory;
      },
		};
		var __cache = Object.create(null);
		var __base = "index.js";
		function __norm(base, id) {
			var parts = base.split("/"); parts.pop();
			for (const seg of id.split("/")) {
				if (seg === "." || seg === "") continue;
				if (seg === "..") parts.pop(); else parts.push(seg);
			}
			var r = parts.join("/");
			if (!r.endsWith(".js")) r += ".js";
			return r;
		}
		function __req(id) {
			var key = id.charAt(0) === "." ? __norm(__base, id) : id;
			var m = __cache[key];
			if (m) return m.exports;
			var fn = __modules[key];
			if (!fn) return __platformRequire(id);
			var prev = __base; __base = key;
			m = __cache[key] = { exports: {} };
			fn(m, m.exports, __req);
			__base = prev;
			return m.exports;
		}
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		return __req("index.js");
	}
});

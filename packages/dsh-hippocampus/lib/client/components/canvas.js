// 3D 神经网络可视化画布组件（GraphCanvas）
const React = require("react");
const { useState, useEffect, useRef, useMemo, useCallback, createElement: h } = React;
const { buildSim } = require("../sim.js");
const { rotate3 } = require("../sim.js");
const { draw } = require("../draw.js");

function GraphCanvas({ graph, selectedId, selectedNode, onSelect, onReset, onEvolve, onPrune, running, setRunning, t, empty, pruneSignal, searchQuery, searchHits, onArchiveWorkdir, focusMode, onToggleFocus }) {
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
				});
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
			if (window.confirm("归档工作区「" + hit.title + "」？\n将断开该工作区的全部连接（含与偏好/交流的永久连接），除非再次使用该目录，否则不再重建。")) {
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
		focusMode ? h("button", { className: "hp-exit-focus", onClick: () => onToggleFocus?.() }, "✕ 退出全屏") : null,
		empty ? h("div", { className: "hp-empty-overlay", style: { bottom: 26 } },
			h("div", { style: { fontSize: 20, opacity: 0.5 } }, "🧠"),
			h("div", { style: { fontSize: 13 } }, t("empty.title")),
			h("div", { style: { fontSize: 11 } }, t("empty.body"))) : null,
		h("div", { className: "hp-hints", style: { bottom: 34 } },
			h("span", null, "单击节点 = 聚焦"),
			h("span", null, "拖拽 = 旋转"),
			h("span", null, "滚轮 = 缩放"),
			h("span", null, t("hint.reset")),
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
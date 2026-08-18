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

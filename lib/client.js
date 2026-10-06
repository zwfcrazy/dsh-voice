window.__ModuleLoader__.load({
	id: "dsh-voice",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
//#region \0rolldown/runtime.js
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));
//#endregion
let react = require("react");
react = __toESM(react, 1);
//#region src/client/index.ts
const name = "dsh-voice-client";
const inject = ["connection", "slots"];
const S = {
	wrap: { padding: "4px 0" },
	tabs: {
		display: "flex",
		gap: 4,
		borderBottom: "1px solid var(--border,#ddd)",
		marginBottom: 12
	},
	tab: (active) => ({
		padding: "6px 14px",
		fontSize: 13,
		cursor: "pointer",
		border: "none",
		background: "transparent",
		color: active ? "var(--accent,#08c)" : "inherit",
		borderBottom: active ? "2px solid var(--accent,#08c)" : "2px solid transparent"
	}),
	row: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "center",
		padding: "5px 0",
		fontSize: 13,
		gap: 8
	},
	k: {
		opacity: .7,
		whiteSpace: "nowrap"
	},
	v: {
		textAlign: "right",
		wordBreak: "break-all"
	},
	hint: {
		fontSize: 12,
		opacity: .6,
		marginTop: 4,
		lineHeight: 1.5
	},
	err: {
		color: "#c00",
		fontSize: 12
	},
	btn: (primary) => ({
		padding: "5px 14px",
		fontSize: 13,
		cursor: "pointer",
		borderRadius: 6,
		border: "1px solid " + (primary ? "var(--accent,#08c)" : "var(--border,#ccc)"),
		background: primary ? "var(--accent,#08c)" : "transparent",
		color: primary ? "#fff" : "inherit"
	}),
	banner: (kind) => ({
		fontSize: 12,
		padding: "8px 10px",
		borderRadius: 6,
		marginBottom: 10,
		lineHeight: 1.6,
		background: kind === "err" ? "rgba(204,0,0,.08)" : "rgba(0,136,204,.08)",
		color: kind === "err" ? "#c00" : "inherit"
	}),
	input: {
		padding: "4px 8px",
		fontSize: 13,
		borderRadius: 6,
		border: "1px solid var(--border,#ccc)",
		background: "transparent",
		color: "inherit",
		minWidth: 180
	},
	range: { width: 180 }
};
function Row(props) {
	const { k, children } = props;
	return react.createElement("div", { style: S.row }, react.createElement("span", { style: S.k }, k), react.createElement("span", { style: S.v }, children === void 0 || children === null ? "—" : children));
}
function Section(props) {
	return react.createElement("div", null, react.createElement("h4", { style: {
		margin: "14px 0 6px",
		fontSize: 13
	} }, props.title), props.children, props.hint ? react.createElement("div", { style: S.hint }, props.hint) : null);
}
const TABS = [
	"状态",
	"语音",
	"唤醒词",
	"上下文",
	"日志",
	"Agent"
];
const EFFORT_ZH = {
	off: "关闭思考",
	minimal: "极低",
	low: "低",
	medium: "中",
	high: "高",
	xhigh: "特高",
	max: "最大"
};
function effortZh(id) {
	return EFFORT_ZH[id] || id;
}
const modelKey = (p, m) => p + "::" + m;
function fmtTok(n) {
	if (typeof n !== "number") return "—";
	if (n >= 1e4) return Math.round(n / 1e3) + "k";
	if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
	return String(n);
}
function apply(ctx) {
	const slots = ctx.slots, connection = ctx.connection;
	class VoicePanel extends react.Component {
		timer;
		logBox;
		constructor(props) {
			super(props);
			this.logBox = react.createRef();
			this.state = {
				st: null,
				err: "",
				tab: "状态",
				cfg: null,
				cfgErr: "",
				edit: {},
				banner: null,
				busy: "",
				ctxSt: null,
				ctxErr: "",
				ctxDraft: null,
				ctxBusy: "",
				logLines: [],
				logErr: "",
				logCount: 300,
				logFilter: "",
				logFollow: true,
				agSt: null,
				agErr: "",
				agBusy: "",
				agSel: "",
				agDraft: null,
				rulesDraft: "",
				modelCat: null,
				wakeDraft: "",
				wakeLine: "",
				wakeBusy: ""
			};
		}
		rpc(endpoint, payload) {
			return connection.rpc.call("/dsh-voice", endpoint, payload || {});
		}
		async refresh() {
			try {
				const r = await this.rpc("status");
				if (r && r.ok) this.setState({
					st: r.value,
					err: ""
				});
				else this.setState({ err: r && r.error && r.error.message || "rpc failed" });
			} catch (e) {
				this.setState({ err: String(e && e.message || e) });
			}
			if (this.state.tab === "上下文") try {
				const r = await this.rpc("context/get");
				if (r && r.ok) {
					const upd = {
						ctxSt: r.value.stats,
						ctxErr: ""
					};
					if (this.state.ctxDraft === null || this.state.ctxDraft === void 0) upd.ctxDraft = r.value.config;
					this.setState(upd);
				}
			} catch (e) {
				this.setState({ ctxErr: String(e && e.message || e) });
			}
			if (this.state.tab === "日志") try {
				const r = await this.rpc("log/tail", { lines: this.state.logCount });
				if (r && r.ok) this.setState({
					logLines: r.value && r.value.lines || [],
					logErr: r.value && r.value.error || ""
				});
				else this.setState({ logErr: r && r.error && r.error.message || "log/tail failed" });
			} catch (e) {
				this.setState({ logErr: String(e && e.message || e) });
			}
		}
		async loadCfg() {
			if (this.state.cfg) return;
			this.setState({ cfgErr: "" });
			try {
				const r = await this.rpc("config/get");
				if (r && r.ok) this.setState({ cfg: r.value });
				else this.setState({ cfgErr: r && r.error && r.error.message || "config/get failed" });
			} catch (e) {
				this.setState({ cfgErr: "引擎离线，配置不可读：" + String(e && e.message || e) });
			}
		}
		componentDidMount() {
			this.refresh();
			this.timer = setInterval(() => this.refresh(), 2e3);
		}
		componentWillUnmount() {
			clearInterval(this.timer);
		}
		componentDidUpdate() {
			if (this.state.tab === "日志" && this.state.logFollow && this.logBox.current) this.logBox.current.scrollTop = this.logBox.current.scrollHeight;
		}
		setTab(tab) {
			this.setState({ tab });
			if ((tab === "语音" || tab === "唤醒词") && !this.state.cfg) this.loadCfg();
			if (tab === "Agent") {
				if (!this.state.agSt) this.loadAgents();
				if (!this.state.modelCat) this.loadModelCat();
			}
			if (tab === "唤醒词" && !this.state.wakeLine && !this.state.wakeDraft) this.loadWake();
		}
		loadModelCat() {
			this.rpc("models/list").then((r) => {
				if (r && r.ok) this.setState({ modelCat: r.value || {} });
				else this.setState({ modelCat: { error: r && r.error && r.error.message || "models/list failed" } });
			}).catch((e) => this.setState({ modelCat: { error: String(e && e.message || e) } }));
		}
		loadWake() {
			this.rpc("wake/get").then((r) => {
				const v = r && r.value;
				if (r && r.ok && v && v.ok !== false) this.setState({
					wakeDraft: v.keyword || "",
					wakeLine: v.line || ""
				});
			}).catch(() => {});
		}
		async setWake() {
			const phrase = (this.state.wakeDraft || "").trim();
			if (typeof window !== "undefined" && !window.confirm(`确定把唤醒词换成「${phrase}」？\n引擎将自动重启（约 10 秒）；旧词备份为 .bak。\n换完建议实测唤醒十来句校准阈值。`)) return;
			this.setState({ wakeBusy: "set" });
			try {
				const r = await this.rpc("wake/set", { phrase });
				const v = r && r.value || {};
				if (r && r.ok && v.ok !== false) {
					this.setState({
						banner: {
							kind: "info",
							text: "唤醒词已换成「" + phrase + "」，引擎重启中（约 10 秒）——说新词试试"
						},
						cfg: null
					});
					setTimeout(() => this.refresh(), 6e3);
					setTimeout(() => this.refresh(), 12e3);
				} else this.setState({ banner: {
					kind: "err",
					text: "换词失败：" + (v && v.error || r && r.error && r.error.message || JSON.stringify(r))
				} });
			} catch (e) {
				this.setState({ banner: {
					kind: "err",
					text: "换词失败：" + String(e && e.message || e)
				} });
			}
			this.setState({ wakeBusy: "" });
		}
		async loadAgents(keepId) {
			this.setState({ agErr: "" });
			try {
				const r = await this.rpc("agents/list");
				if (r && r.ok) {
					const v = r.value || {};
					const agents = v.agents || [];
					let sel = keepId && agents.some((a) => a.id === keepId) ? keepId : v.active || (agents[0] ? agents[0].id : "");
					const selAg = agents.find((a) => a.id === sel);
					const upd = {
						agSt: v,
						agSel: sel,
						agDraft: selAg ? this.draftOf(selAg) : this.blankDraft(v.ttsOptions),
						rulesDraft: v.common && v.common.outputRules || ""
					};
					if (!selAg) upd.agSel = "";
					this.setState(upd);
				} else this.setState({ agErr: r && r.error && r.error.message || "agents/list failed" });
			} catch (e) {
				this.setState({ agErr: String(e && e.message || e) });
			}
		}
		draftOf(a) {
			return {
				name: a.name || "",
				prompt: a.prompt || "",
				preset: a.tts && a.tts.preset || "",
				voice: a.tts && a.tts.voice || "",
				tools: {
					webSearch: a.tools?.webSearch !== false,
					voiceTools: a.tools?.voiceTools !== false
				},
				model: a.model && a.model.provider && a.model.model ? {
					provider: a.model.provider,
					model: a.model.model,
					effort: a.model.effort || ""
				} : null
			};
		}
		blankDraft(ttsOptions, fallbackPreset) {
			return {
				name: "",
				prompt: "",
				preset: (Array.isArray(ttsOptions) && ttsOptions[0] ? ttsOptions[0].value : "") || fallbackPreset || "",
				voice: "",
				tools: {
					webSearch: true,
					voiceTools: true
				},
				model: null
			};
		}
		setAgDraft(patch) {
			this.setState({ agDraft: {
				...this.state.agDraft || {},
				...patch
			} });
		}
		agBusyOn(k) {
			this.setState({ agBusy: k });
		}
		async saveAgent() {
			const d = this.state.agDraft;
			if (!d) return;
			this.agBusyOn("save");
			try {
				const selAg = (this.state.agSt && this.state.agSt.agents || []).find((a) => a.id === this.state.agSel);
				const r = await this.rpc("agents/save", { agent: {
					id: this.state.agSel,
					name: d.name,
					prompt: d.prompt,
					tts: {
						preset: d.preset,
						voice: d.voice
					},
					tools: d.tools || {
						webSearch: true,
						voiceTools: true
					},
					model: d.model || null,
					...selAg ? { createdAt: selAg.createdAt } : {}
				} });
				if (r && r.ok) {
					const v = r.value || {};
					let text = "Agent 已保存：" + d.name;
					if (v.voiceApplied) text += "（使用中，音色已热切生效）";
					if (v.voiceError) text += "；音色热切失败：" + v.voiceError;
					if (v.toolsApplied) text += v.recreated ? "；工具集变化已重建会话（上下文归档）" : "；工具集变化已写入 preset（会话重建待自愈）";
					if (v.modelApplied) text += "；模型选型已切换（下一轮对话生效）";
					this.setState({ banner: {
						kind: v.voiceError ? "err" : "info",
						text
					} });
					await this.loadAgents(v.agent ? v.agent.id : void 0);
				} else this.setState({ banner: {
					kind: "err",
					text: "保存失败：" + (r && r.error && r.error.message || JSON.stringify(r))
				} });
			} catch (e) {
				this.setState({ banner: {
					kind: "err",
					text: "保存失败：" + String(e && e.message || e)
				} });
			}
			this.setState({ agBusy: "" });
		}
		async delAgent(id, name) {
			if (typeof window !== "undefined" && !window.confirm(`删除 Agent「${name}」？（不可恢复；使用中的 Agent 需先切换）`)) return;
			this.agBusyOn("del");
			try {
				const r = await this.rpc("agents/delete", { id });
				if (r && r.ok) {
					this.setState({ banner: {
						kind: "info",
						text: "已删除「" + name + "」"
					} });
					await this.loadAgents();
				} else this.setState({ banner: {
					kind: "err",
					text: r && r.error && r.error.message || JSON.stringify(r)
				} });
			} catch (e) {
				this.setState({ banner: {
					kind: "err",
					text: String(e && e.message || e)
				} });
			}
			this.setState({ agBusy: "" });
		}
		async activateAgent(id, name) {
			this.agBusyOn("act");
			try {
				const r = await this.rpc("agents/activate", { id });
				if (r && r.ok) {
					const v = r && r.value || {};
					let text = `已切换到「${name}」：音色已热切，人设下一轮对话生效`;
					if (v.modelApplied) text += "；模型选型已热切换（下一轮生效）";
					if (v.toolsApplied) text += v.recreated ? "；工具集变化已重建会话（上下文归档）" : "；工具集变化已写入 preset";
					this.setState({ banner: {
						kind: "info",
						text
					} });
					await this.loadAgents();
				} else this.setState({ banner: {
					kind: "err",
					text: "切换失败：" + (r && r.error && r.error.message || JSON.stringify(r))
				} });
			} catch (e) {
				this.setState({ banner: {
					kind: "err",
					text: "切换失败：" + String(e && e.message || e)
				} });
			}
			this.setState({ agBusy: "" });
		}
		previewAgentVoice() {
			const d = this.state.agDraft;
			if (!d || !d.preset) return;
			this.agBusyOn("prev");
			this.setState({ banner: {
				kind: "info",
				text: `正在按「${d.voice || "预设默认音色"}」合成试听，音箱即将发声…`
			} });
			this.rpc("engine/preview", {
				preset: d.preset,
				voice: d.voice || ""
			}).then((r) => {
				const v = r && r.value;
				if (r && r.ok && v && v.ok) this.setState({ banner: {
					kind: "info",
					text: "已播放（音色 " + v.voice + "）"
				} });
				else this.setState({ banner: {
					kind: "err",
					text: "试听失败：" + (v && v.error || r && r.error && r.error.message || "未知错误")
				} });
			}).catch((e) => this.setState({ banner: {
				kind: "err",
				text: "试听失败：" + String(e && e.message || e)
			} })).finally(() => this.setState({ agBusy: "" }));
		}
		async saveRules() {
			this.agBusyOn("rules");
			try {
				const r = await this.rpc("common/set", { outputRules: this.state.rulesDraft });
				if (r && r.ok) this.setState({ banner: {
					kind: "info",
					text: "输出规则已保存：下一轮对话起对所有 Agent 生效"
				} });
				else this.setState({ banner: {
					kind: "err",
					text: "保存失败：" + (r && r.error && r.error.message || JSON.stringify(r))
				} });
			} catch (e) {
				this.setState({ banner: {
					kind: "err",
					text: "保存失败：" + String(e && e.message || e)
				} });
			}
			this.setState({ agBusy: "" });
		}
		async migrateAgent() {
			if (typeof window !== "undefined" && !window.confirm("启用 Agent 人设需要重建语音会话：\n当前对话将归档到 logs/session-archive（可找回），随后空白重建并绑定人设。\n如果 GUI 里正开着 jarvis-voice 会话页，请先关闭/切走它，否则会被拒绝。")) return;
			this.agBusyOn("mig");
			try {
				const r = await this.rpc("agents/migrate");
				const clear = (r && r.value || {}).clear || {};
				if (r && r.ok && clear.ok !== false) {
					this.setState({ banner: {
						kind: "info",
						text: "会话已重建并绑定人设 preset（归档 " + (clear.archived || []).length + " 份）。下次唤醒即带人设。"
					} });
					await this.loadAgents();
				} else if (clear.occupied) this.setState({ banner: {
					kind: "err",
					text: clear.error || "会话被占用"
				} });
				else this.setState({ banner: {
					kind: "err",
					text: "迁移未执行：" + (clear.error || JSON.stringify(r))
				} });
			} catch (e) {
				this.setState({ banner: {
					kind: "err",
					text: "迁移失败：" + String(e && e.message || e)
				} });
			}
			this.setState({ agBusy: "" });
		}
		setDraft(fn) {
			const draft = JSON.parse(JSON.stringify(this.state.ctxDraft || {}));
			fn(draft);
			this.setState({ ctxDraft: draft });
		}
		async saveCtx() {
			if (!this.state.ctxDraft) return;
			this.setState({ ctxBusy: "save" });
			try {
				const r = await this.rpc("context/set", { config: this.state.ctxDraft });
				if (r && r.ok) this.setState({ banner: {
					kind: "info",
					text: "上下文配置已保存并即时生效"
				} });
				else this.setState({ banner: {
					kind: "err",
					text: "保存失败：" + (r && r.error && r.error.message || JSON.stringify(r))
				} });
			} catch (e) {
				this.setState({ banner: {
					kind: "err",
					text: "保存失败：" + String(e && e.message || e)
				} });
			}
			this.setState({ ctxBusy: "" });
		}
		async doCompact() {
			this.setState({ ctxBusy: "compact" });
			try {
				const r = await this.rpc("context/compact");
				const v = r && r.value || {};
				if (r && r.ok && v.ok !== false) this.setState({ banner: {
					kind: "info",
					text: v.runs > 0 ? `已压缩 ${v.runs} 段：${fmtTok(v.before)} → ${fmtTok(v.after)} tokens` : "当前没有可压缩的区间（会话还很短）"
				} });
				else this.setState({ banner: {
					kind: "err",
					text: "压缩失败：" + (v.error || JSON.stringify(r))
				} });
			} catch (e) {
				this.setState({ banner: {
					kind: "err",
					text: "压缩失败：" + String(e && e.message || e)
				} });
			}
			this.setState({ ctxBusy: "" });
		}
		async doClear() {
			if (typeof window !== "undefined" && !window.confirm("确定清空 jarvis-voice 的对话上下文？\n旧记录会归档到 logs/session-archive（可找回），会话将以空白重建。\n注意：如果 GUI 里正开着这个会话页，请先关闭/切走它，否则清空会被拒绝。")) return;
			this.setState({ ctxBusy: "clear" });
			try {
				const r = await this.rpc("context/clear");
				const v = r && r.value || {};
				if (r && r.ok && v.ok !== false) this.setState({ banner: {
					kind: "info",
					text: "上下文已清空（归档 " + (v.archived || []).length + " 份" + (v.recreated ? "，已重建空白会话" : "") + "）。下次唤醒即全新会话。"
				} });
				else if (v.occupied) this.setState({ banner: {
					kind: v.deferred ? "info" : "err",
					text: v.error || "会话被占用"
				} });
				else this.setState({ banner: {
					kind: "err",
					text: "清空未执行：" + (v.error || JSON.stringify(r))
				} });
			} catch (e) {
				this.setState({ banner: {
					kind: "err",
					text: "清空失败：" + String(e && e.message || e)
				} });
			}
			this.setState({ ctxBusy: "" });
		}
		edit(path, value) {
			const edit = { ...this.state.edit || {} };
			edit[path] = value;
			this.setState({ edit });
		}
		val(path) {
			const e = this.state.edit || {};
			if (path in e) return e[path];
			const c = this.state.cfg && this.state.cfg.config;
			return c && c[path] ? c[path].value : void 0;
		}
		async save(paths) {
			const updates = {};
			const e = this.state.edit || {};
			for (const p of paths) if (p in e) updates[p] = e[p];
			if (!Object.keys(updates).length) {
				this.setState({ banner: {
					kind: "info",
					text: "没有改动"
				} });
				return;
			}
			this.setState({ busy: "save" });
			try {
				const r = await this.rpc("config/set", { updates });
				if (r && r.ok) {
					const v = r.value || {};
					const parts = [];
					if ((v.applied || []).length) parts.push("已热改生效：" + (v.applied || []).join("、"));
					if ((v.restart_needed || []).length) parts.push("已保存，重启引擎后生效：" + (v.restart_needed || []).join("、"));
					this.setState({
						banner: {
							kind: "info",
							text: parts.join("；") || "已保存",
							restart: v.restart_needed || []
						},
						edit: {},
						cfg: null
					});
					this.loadCfg();
				} else this.setState({ banner: {
					kind: "err",
					text: "保存失败：" + JSON.stringify(r && r.error || r)
				} });
			} catch (e) {
				this.setState({ banner: {
					kind: "err",
					text: "保存失败：" + String(e && e.message || e)
				} });
			}
			this.setState({ busy: "" });
		}
		async engineAction(action) {
			this.setState({ busy: action });
			try {
				const r = await this.rpc("engine/" + action);
				if (r && r.ok && action === "restart") {
					this.setState({
						banner: {
							kind: "info",
							text: "引擎重启中（约 10 秒），下方状态恢复即成功"
						},
						cfg: null
					});
					setTimeout(() => this.refresh(), 3e3);
					setTimeout(() => this.refresh(), 8e3);
				} else if (!(r && r.ok)) this.setState({ banner: {
					kind: "err",
					text: action + " 失败：" + JSON.stringify(r && r.error || r)
				} });
			} catch (e) {
				this.setState({ banner: {
					kind: "err",
					text: action + " 失败：" + String(e && e.message || e)
				} });
			}
			this.setState({ busy: "" });
		}
		onVolumeRelease() {
			const v = this.val("tts.volume");
			const cur = this.state.cfg && this.state.cfg.config && this.state.cfg.config["tts.volume"] ? this.state.cfg.config["tts.volume"].value : void 0;
			if (v === void 0 || v === cur) return;
			this.rpc("config/set", { updates: { "tts.volume": v } }).then((r) => {
				this.setState({ banner: {
					kind: "info",
					text: r && r.ok ? "音量已生效并保存" : "音量设置失败"
				} });
				if (r && r.ok) this.loadCfg();
			}).catch(() => this.setState({ banner: {
				kind: "err",
				text: "音量设置失败（引擎离线？）"
			} }));
		}
		onMusicRelease() {
			const v = this.val("music.volume");
			const cur = this.state.cfg && this.state.cfg.config && this.state.cfg.config["music.volume"] ? this.state.cfg.config["music.volume"].value : void 0;
			if (v === void 0 || v === cur) return;
			this.rpc("config/set", { updates: { "music.volume": v } }).then((r) => {
				this.setState({ banner: {
					kind: "info",
					text: r && r.ok ? "音乐音量已即时生效（正在播放也生效）" : "音乐音量设置失败"
				} });
				if (r && r.ok) this.loadCfg();
			}).catch(() => this.setState({ banner: {
				kind: "err",
				text: "音乐音量设置失败（引擎离线？）"
			} }));
		}
		select(path) {
			const field = this.state.cfg && this.state.cfg.config ? this.state.cfg.config[path] : null;
			const opts = field && field.options || [];
			return react.createElement("select", {
				style: S.input,
				value: String(this.val(path) ?? ""),
				onChange: (e) => this.edit(path, e.target.value)
			}, opts.map((o) => react.createElement("option", {
				key: o.value,
				value: o.value
			}, o.label)));
		}
		range(path, min, max, step, onRelease) {
			return react.createElement("input", {
				type: "range",
				style: S.range,
				min,
				max,
				step,
				value: Number(this.val(path) ?? min),
				onChange: (e) => this.edit(path, Number(e.target.value)),
				onPointerUp: () => onRelease && onRelease(),
				onTouchEnd: () => onRelease && onRelease()
			});
		}
		renderStatus() {
			const st = this.state.st, eng = st && st.engine, br = st && st.bridge;
			const offline = !eng || eng.offline;
			return react.createElement("div", null, this.state.err ? react.createElement("div", { style: S.err }, "RPC: ", this.state.err) : null, offline ? react.createElement("div", { style: S.banner("err") }, "引擎离线", eng && eng.error ? "（" + eng.error + "）" : "", "。dsh web 启动时自动拉起；也可点「重启引擎」。") : null, react.createElement(Section, { title: "引擎" }, react.createElement(Row, { k: "状态" }, offline ? "离线" : `在线（${eng.state}·loop=${eng.loop ?? "—"}）`), react.createElement(Row, { k: "运行时长" }, offline ? "—" : Math.round((eng.uptime_s || 0) / 60) + " 分钟"), react.createElement(Row, { k: "麦克风" }, eng && eng.source ? eng.source.split(".").slice(0, 2).join(".") : "—"), react.createElement(Row, { k: "电平 (dBFS)" }, eng && eng.level_dbfs !== void 0 ? eng.level_dbfs : "—"), react.createElement(Row, { k: "唤醒词/命中" }, eng && eng.wake_keyword ? `${eng.wake_keyword} · ${eng.wake_hits ?? 0} 次` : "—")), react.createElement(Section, { title: "桥接 / 会话" }, react.createElement(Row, { k: "DSH 会话" }, br ? br.session : "—"), react.createElement(Row, { k: "SSE 下行" }, br && br.sse ? "已连" : "未连（daemon 未运行时正常）"), react.createElement(Row, { k: "Agent 模型" }, br && br.model ? `${br.model.provider}/${br.model.model}` : "—"), react.createElement(Row, { k: "最近出站" }, br && br.served ? `${br.served.provider}/${br.served.model}${br.served.reasoningEffort ? ` · ${br.served.reasoningEffort}` : ""}` : "—（还没有语音轮）"), react.createElement(Row, { k: "当前 Agent" }, st && st.persona ? st.persona.active : "—")), react.createElement("div", { style: {
				display: "flex",
				gap: 8,
				marginTop: 12
			} }, react.createElement("button", {
				style: S.btn(false),
				onClick: () => this.engineAction("stop"),
				disabled: !!this.state.busy
			}, "停止播报"), react.createElement("button", {
				style: S.btn(false),
				onClick: () => this.engineAction("restart"),
				disabled: !!this.state.busy
			}, this.state.busy === "restart" ? "重启中…" : "重启引擎")));
		}
		renderVoice() {
			const cfg = this.state.cfg;
			if (this.state.cfgErr) return react.createElement("div", { style: S.err }, this.state.cfgErr);
			if (!cfg) return react.createElement("div", { style: S.hint }, "读取配置…（引擎离线时读不到）");
			const vol = Number(this.val("tts.volume") ?? .5);
			return react.createElement("div", null, react.createElement(Section, { title: "识别（ASR）" }, react.createElement(Row, { k: "模型" }, this.select("asr.model")), react.createElement("div", { style: S.row }, react.createElement("span", { style: S.k }, "热词/上下文"), react.createElement("textarea", {
				style: {
					...S.input,
					minWidth: 260,
					minHeight: 44,
					flex: 1
				},
				rows: 2,
				value: String(this.val("asr.context") ?? ""),
				onChange: (e) => this.edit("asr.context", e.target.value)
			}))), react.createElement(Section, { title: "合成（TTS）" }, react.createElement("div", { style: S.row }, react.createElement("span", { style: S.k }, `音量 ${Math.round(vol * 100)}%`), this.range("tts.volume", .05, 1.5, .05, () => this.onVolumeRelease()), react.createElement("button", {
				style: {
					...S.btn(false),
					padding: "2px 10px"
				},
				onClick: () => {
					this.rpc("engine/preview").catch((e) => this.setState({ banner: {
						kind: "err",
						text: "试听失败：" + String(e && e.message || e)
					} }));
				}
			}, "提示音")), react.createElement("div", { style: S.hint }, "音量拖完松手即生效并播提示音。音色（方案与自定义音色 id）属 Agent 档案——到「Agent」页编辑。")), react.createElement(Section, { title: "等待音乐（思考/合成期提示）" }, react.createElement("div", { style: S.row }, react.createElement("span", { style: S.k }, "启用"), react.createElement("input", {
				type: "checkbox",
				checked: !!this.val("music.enabled"),
				onChange: (e) => this.edit("music.enabled", e.target.checked)
			})), react.createElement("div", { style: S.row }, react.createElement("span", { style: S.k }, "工具过渡语"), react.createElement("input", {
				type: "checkbox",
				checked: !!this.val("loop.tool_filler"),
				onChange: (e) => this.edit("loop.tool_filler", e.target.checked)
			}), react.createElement("span", { style: {
				fontSize: 12,
				opacity: .6
			} }, "调慢工具（如联网搜索）时播「我查一下哈」")), react.createElement("div", { style: S.row }, react.createElement("span", { style: S.k }, `音乐音量 ${Math.round(Number(this.val("music.volume") ?? .35) * 100)}%`), this.range("music.volume", 0, 1, .05, () => this.onMusicRelease()), react.createElement("button", {
				style: {
					...S.btn(false),
					padding: "2px 10px"
				},
				disabled: this.state.busy === "music",
				onClick: () => {
					this.setState({
						busy: "music",
						banner: {
							kind: "info",
							text: "等待音乐试听 5 秒（音箱发声）…"
						}
					});
					this.rpc("music/preview", { seconds: 5 }).then((r) => {
						const v = r && r.value;
						if (!(r && r.ok && v && v.ok !== false)) this.setState({ banner: {
							kind: "err",
							text: "试听失败：" + (v && v.error || "引擎离线？")
						} });
					}).catch((e) => this.setState({ banner: {
						kind: "err",
						text: "试听失败：" + String(e && e.message || e)
					} })).finally(() => this.setState({ busy: "" }));
				}
			}, this.state.busy === "music" ? "播放中…" : "试听 5 秒")), react.createElement("div", { style: S.hint }, "说完指令后音乐立即垫上、循环播放，回复开口瞬间让位。音量拖完松手即生效（播放中也生效）。素材可换：config [music] file 指向任意单声道 wav（scripts/gen-music.py 可再生成）。")), react.createElement(Section, { title: "断句（停顿判定）" }, react.createElement("div", { style: S.row }, react.createElement("span", { style: S.k }, `断句静默 ${Number(this.val("vad.min_silence_ms") ?? 450)}ms`), this.range("vad.min_silence_ms", 200, 3e3, 50)), react.createElement("div", { style: S.hint }, "说话中的停顿超过该时长才认为说完了、送去识别。太短：卡壳/换气就被切断，一句话变多段；太长：说完要等久才响应。中文句内停顿常见 300–500ms；说话爱卡壳可调到 1000–2000。保存即热生效（正在说的这句不受影响，下一段起用新值）。")), react.createElement("div", null, react.createElement("button", {
				style: S.btn(true),
				disabled: this.state.busy === "save",
				onClick: () => this.save([
					"asr.model",
					"asr.context",
					"tts.volume",
					"vad.min_silence_ms",
					"music.enabled",
					"music.volume",
					"loop.tool_filler"
				])
			}, this.state.busy === "save" ? "保存中…" : "保存本页配置")));
		}
		renderWake() {
			const cfg = this.state.cfg;
			if (this.state.cfgErr) return react.createElement("div", { style: S.err }, this.state.cfgErr);
			if (!cfg) return react.createElement("div", { style: S.hint }, "读取配置…");
			const th = Number(this.val("wake.threshold") ?? .25);
			const ks = Number(this.val("wake.keywords_score") ?? 4);
			return react.createElement("div", null, react.createElement(Section, { title: "唤醒词" }, react.createElement(Row, { k: "当前关键词" }, cfg.wake_keyword || "—"), this.state.wakeLine ? react.createElement(Row, { k: "KWS tokens" }, this.state.wakeLine.split("@")[0].trim()) : null, react.createElement("div", { style: {
				...S.row,
				alignItems: "flex-start"
			} }, react.createElement("span", { style: {
				...S.k,
				marginTop: 4
			} }, "换成"), react.createElement("input", {
				style: {
					...S.input,
					flex: 1
				},
				placeholder: "3–8 个汉字（建议 3–4 字），如：你好小白",
				value: this.state.wakeDraft,
				onChange: (e) => this.setState({ wakeDraft: e.target.value })
			}), react.createElement("button", {
				style: {
					...S.btn(false),
					padding: "2px 10px"
				},
				disabled: this.state.wakeBusy === "set",
				onClick: () => this.setWake()
			}, this.state.wakeBusy === "set" ? "换词中…" : "换词并重启引擎")), react.createElement("div", { style: S.hint }, "自动转拼音并校验模型词表，通过后写入 keywords 文件并重启引擎（约 10 秒；旧词备份为 .bak，点一次即可）。个别词含模型词表外音节会被拒绝并提示，换个说法即可。词长建议 3–4 字：两字词声学证据不足，实测任何阈值下都间歇漏检（「丁满」0.15–0.25 均不稳）。换词后建议实测唤醒十来句校准阈值。")), react.createElement(Section, { title: "灵敏度（保存后重启引擎生效）" }, react.createElement("div", { style: S.row }, react.createElement("span", { style: S.k }, `检测阈值 ${th.toFixed(2)}（低=更灵敏）`), this.range("wake.threshold", .05, .6, .05)), react.createElement("div", { style: S.row }, react.createElement("span", { style: S.k }, `前缀抗剪枝加权 ${ks.toFixed(1)}`), this.range("wake.keywords_score", .5, 8, .5)), react.createElement("div", { style: S.hint }, "阈值经验（按词长）：四字 0.25 定点（你好丁满 15/15 检出、0 误报）；三字暂用 0.20（校准中）；两字不可用。误报→调高，漏检→调低；score 4.0 为前缀句抗剪枝定点，一般不动。")), react.createElement("button", {
				style: S.btn(true),
				disabled: this.state.busy === "save",
				onClick: () => this.save(["wake.threshold", "wake.keywords_score"])
			}, this.state.busy === "save" ? "保存中…" : "保存本页配置"));
		}
		renderContext() {
			const st = this.state.ctxSt, d = this.state.ctxDraft;
			if (this.state.ctxErr) return react.createElement("div", { style: S.err }, this.state.ctxErr);
			if (!d) return react.createElement("div", { style: S.hint }, "读取中…");
			const pct = st && typeof st.percent === "number" ? st.percent : null;
			const c = d.compaction, cs = c.schedule, cl = d.clear.schedule;
			return react.createElement("div", null, react.createElement(Section, { title: "上下文现状" }, st && st.available === false ? react.createElement("div", { style: S.hint }, "暂不可用：" + (st.reason || "meter/agent 未就绪")) : react.createElement("div", null, react.createElement(Row, { k: "已用 / 容量" }, `${fmtTok(st && st.totalTokens)} / ${fmtTok(st && st.contextWindow)} tokens${pct !== null ? `（${pct}%）` : ""}`), react.createElement(Row, { k: "消息节点" }, fmtTok(st && st.nodes)), pct !== null ? react.createElement("div", { style: {
				height: 8,
				borderRadius: 4,
				background: "var(--border,#e5e5e5)",
				overflow: "hidden",
				marginTop: 4
			} }, react.createElement("div", { style: {
				height: "100%",
				width: Math.min(pct, 100) + "%",
				background: pct > c.thresholdRatio * 100 ? "#e67e22" : "var(--accent,#08c)"
			} })) : null, st && st.compactionAvailable === false ? react.createElement("div", { style: {
				...S.hint,
				color: "#c00"
			} }, "⚠ compaction 引擎不可用（" + (st.compactionError || "原因未知") + "；清空不受影响）") : null), react.createElement(Section, { title: "自动压缩" }, react.createElement("div", { style: S.row }, react.createElement("span", { style: S.k }, "每轮结束按阈值自动压缩"), react.createElement("input", {
				type: "checkbox",
				checked: !!c.autoPressure,
				onChange: (e) => this.setDraft((x) => {
					x.compaction.autoPressure = e.target.checked;
				})
			})), react.createElement("div", { style: S.row }, react.createElement("span", { style: S.k }, `压缩阈值 ${Math.round(c.thresholdRatio * 100)}%（占用超过即压）`), react.createElement("input", {
				type: "range",
				style: S.range,
				min: .3,
				max: .95,
				step: .05,
				value: c.thresholdRatio,
				onChange: (e) => this.setDraft((x) => {
					x.compaction.thresholdRatio = Number(e.target.value);
				})
			})), react.createElement("div", { style: S.row }, react.createElement("span", { style: S.k }, `保留近段 ${Math.round(c.retainRatio * 100)}%`), react.createElement("input", {
				type: "range",
				style: S.range,
				min: .05,
				max: .6,
				step: .05,
				value: c.retainRatio,
				onChange: (e) => this.setDraft((x) => {
					x.compaction.retainRatio = Number(e.target.value);
				})
			})), react.createElement("div", { style: S.row }, react.createElement("span", { style: S.k }, "定时压缩"), react.createElement("select", {
				style: S.input,
				value: cs.mode,
				onChange: (e) => this.setDraft((x) => {
					x.compaction.schedule.mode = e.target.value;
				})
			}, react.createElement("option", { value: "off" }, "关闭"), react.createElement("option", { value: "daily" }, "每日定时"), react.createElement("option", { value: "interval" }, "固定间隔"))), cs.mode === "daily" ? react.createElement("div", { style: S.row }, react.createElement("span", { style: S.k }, "每日时刻"), react.createElement("input", {
				type: "time",
				style: S.input,
				value: cs.time,
				onChange: (e) => this.setDraft((x) => {
					x.compaction.schedule.time = e.target.value;
				})
			})) : null, cs.mode === "interval" ? react.createElement("div", { style: S.row }, react.createElement("span", { style: S.k }, "间隔（小时）"), react.createElement("input", {
				type: "number",
				style: S.input,
				min: 1,
				max: 168,
				value: cs.intervalHours,
				onChange: (e) => this.setDraft((x) => {
					x.compaction.schedule.intervalHours = Number(e.target.value);
				})
			})) : null), react.createElement(Section, { title: "自动清空（整段重置）" }, react.createElement("div", { style: S.row }, react.createElement("span", { style: S.k }, "每日自动清空"), react.createElement("select", {
				style: S.input,
				value: cl.mode,
				onChange: (e) => this.setDraft((x) => {
					x.clear.schedule.mode = e.target.value;
				})
			}, react.createElement("option", { value: "off" }, "关闭"), react.createElement("option", { value: "daily" }, "每日定时"))), cl.mode === "daily" ? react.createElement("div", { style: S.row }, react.createElement("span", { style: S.k }, "清空时刻"), react.createElement("input", {
				type: "time",
				style: S.input,
				value: cl.time,
				onChange: (e) => this.setDraft((x) => {
					x.clear.schedule.time = e.target.value;
				})
			})) : null, react.createElement("div", { style: S.hint }, "语音助手场景常用：凌晨整段清空，每天新鲜开始（压缩只缩短历史，清空是推倒重来）。")), react.createElement("div", { style: {
				display: "flex",
				gap: 8,
				marginTop: 12
			} }, react.createElement("button", {
				style: S.btn(false),
				disabled: !!this.state.ctxBusy,
				onClick: () => this.doCompact()
			}, this.state.ctxBusy === "compact" ? "压缩中…" : "立即压缩"), react.createElement("button", {
				style: S.btn(false),
				disabled: !!this.state.ctxBusy,
				onClick: () => this.doClear()
			}, this.state.ctxBusy === "clear" ? "清空中…" : "立即清空"), react.createElement("button", {
				style: S.btn(true),
				disabled: !!this.state.ctxBusy,
				onClick: () => this.saveCtx()
			}, this.state.ctxBusy === "save" ? "保存中…" : "保存本页配置")), react.createElement("div", { style: S.hint }, "压缩 = 用当前 Agent 模型把旧对话摘要成一段（保留近段），立即生效；清空 = 归档到 logs/session-archive 并空白重建（可找回），进行中的对话会先被打断。")));
		}
		renderLog() {
			const lines = this.state.logLines || [];
			const f = (this.state.logFilter || "").trim().toLowerCase();
			const shown = f ? lines.filter((l) => l.toLowerCase().includes(f)) : lines;
			const colorOf = (l) => l.includes("\"level\": \"ERROR\"") || /(^|\s)ERROR(\s|$)/.test(l) ? "#e5493a" : l.includes("\"level\": \"WARNING\"") || /(^|\s)WARNING(\s|$)/.test(l) ? "#d98218" : "inherit";
			return react.createElement("div", null, react.createElement("div", { style: {
				display: "flex",
				gap: 8,
				marginBottom: 8,
				alignItems: "center",
				flexWrap: "wrap"
			} }, react.createElement("input", {
				style: {
					...S.input,
					minWidth: 150
				},
				placeholder: "过滤（子串，如 tts、turn、wake）",
				value: this.state.logFilter,
				onChange: (e) => this.setState({ logFilter: e.target.value })
			}), react.createElement("select", {
				style: S.input,
				value: String(this.state.logCount),
				onChange: (e) => this.setState({ logCount: Number(e.target.value) }, () => this.refresh())
			}, [
				100,
				300,
				1e3
			].map((n) => react.createElement("option", {
				key: n,
				value: String(n)
			}, `最近 ${n} 行`))), react.createElement("button", {
				style: S.btn(false),
				onClick: () => this.refresh()
			}, "刷新"), this.state.logErr ? react.createElement("span", { style: S.err }, this.state.logErr) : react.createElement("span", { style: S.hint }, `显示 ${shown.length} 行 · 每 2s 自动刷新 · ${this.state.logFollow ? "跟随中" : "已暂停跟随（回到底部恢复）"}`)), react.createElement("div", {
				ref: this.logBox,
				style: {
					maxHeight: 430,
					overflowY: "auto",
					border: "1px solid var(--border,#ddd)",
					borderRadius: 6,
					padding: "6px 8px",
					background: "rgba(127,127,127,.07)",
					fontSize: 11,
					lineHeight: 1.5
				},
				onScroll: (e) => {
					const el = e.target;
					this.setState({ logFollow: el.scrollTop + el.clientHeight >= el.scrollHeight - 24 });
				}
			}, shown.length === 0 ? react.createElement("div", { style: S.hint }, "（暂无日志）") : react.createElement("pre", { style: {
				margin: 0,
				whiteSpace: "pre-wrap",
				wordBreak: "break-all",
				fontFamily: "ui-monospace,Menlo,Consolas,monospace"
			} }, shown.map((l, i) => react.createElement("div", {
				key: i,
				style: { color: colorOf(l) }
			}, l || " ")))));
		}
		renderAgent() {
			const br = this.state.st && this.state.st.bridge;
			const ag = this.state.agSt;
			if (this.state.agErr) return react.createElement("div", { style: S.err }, this.state.agErr);
			if (!ag) return react.createElement("div", { style: S.hint }, "读取中…");
			const d = this.state.agDraft || {
				name: "",
				prompt: "",
				preset: "",
				voice: ""
			};
			const agents = ag.agents || [];
			const opts = ag.ttsOptions || [];
			const selAg = agents.find((a) => a.id === this.state.agSel);
			const activeAg = agents.find((a) => a.id === ag.active);
			const activeName = activeAg ? activeAg.name : "—";
			const b = !!this.state.agBusy;
			return react.createElement("div", null, react.createElement(Section, { title: "Agent" }, react.createElement(Row, { k: "当前模型" }, (() => {
				const m = br && br.model;
				if (!m || !m.provider) return "—";
				return `${m.provider}/${m.model}` + (m.reasoningEffort ? ` · ${effortZh(m.reasoningEffort)}` : "") + (m.source === "profile" ? "（档案指定）" : "（跟随 DSH 默认）");
			})()), react.createElement(Row, { k: "会话" }, br ? br.session : "—"), react.createElement(Row, { k: "当前 Agent" }, activeName + (ag.bound ? "" : "（preset 未绑定，见下方）"))), !ag.bound ? react.createElement("div", { style: S.banner("err") }, "人设 preset 尚未绑定到语音会话（旧会话创建于 P7b 之前）。重建一次即绑定：", react.createElement("button", {
				style: {
					...S.btn(false),
					marginLeft: 10,
					padding: "2px 10px"
				},
				disabled: this.state.agBusy === "mig",
				onClick: () => this.migrateAgent()
			}, this.state.agBusy === "mig" ? "重建中…" : "重建会话绑定人设")) : null, ag.warn ? react.createElement("div", { style: S.banner("err") }, ag.warn) : null, react.createElement(Section, { title: "公共设置（所有 Agent 生效）" }, react.createElement("div", {
				style: S.row,
				alignItems: "flex-start"
			}, react.createElement("span", { style: {
				...S.k,
				marginTop: 4
			} }, "输出格式"), react.createElement("textarea", {
				style: {
					...S.input,
					minWidth: 260,
					flex: 1,
					minHeight: 96,
					fontFamily: "inherit"
				},
				rows: 5,
				value: this.state.rulesDraft,
				onChange: (e) => this.setState({ rulesDraft: e.target.value })
			})), react.createElement("div", { style: {
				display: "flex",
				gap: 8,
				marginTop: 6
			} }, react.createElement("button", {
				style: S.btn(false),
				disabled: this.state.agBusy === "rules",
				onClick: () => this.saveRules()
			}, this.state.agBusy === "rules" ? "保存中…" : "保存输出规则")), react.createElement("div", { style: S.hint }, "约束模型输出适合语音朗读：纯文本、数字/算式口语写法（乘号写「乘以」、数字间不加空格）等。保存后下一轮对话生效，对全部 Agent 生效——不随 Agent 切换而变。")), react.createElement(Section, {
				title: "Agent 档案（个性：提示词 + 音色 + 工具 + 模型）",
				hint: "Agent = 个性（提示词+音色）+ 工具集 + 模型选型（P7c 绑定档案，2026-09-26/27）。提示词定义姓名/身份/说话方式/职责。音色热切即时生效；工具集是会话级结构，改动使用中的 Agent 会自动重建会话（上下文归档）；模型选型下一轮对话热生效（不重建会话）。"
			}, react.createElement("div", { style: {
				display: "flex",
				gap: 12
			} }, react.createElement("div", { style: {
				minWidth: 132,
				display: "flex",
				flexDirection: "column",
				gap: 4
			} }, agents.map((a) => react.createElement("button", {
				key: a.id,
				style: {
					...S.btn(this.state.agSel === a.id),
					padding: "4px 8px",
					fontSize: 12,
					textAlign: "left"
				},
				onClick: () => this.setState({
					agSel: a.id,
					agDraft: this.draftOf(a)
				})
			}, (ag.active === a.id ? "● " : "") + a.name)), react.createElement("button", {
				style: {
					...S.btn(false),
					padding: "4px 8px",
					fontSize: 12
				},
				onClick: () => this.setState({
					agSel: "",
					agDraft: this.blankDraft(opts, activeAg ? activeAg.tts.preset : "")
				})
			}, "＋ 新建 Agent")), react.createElement("div", { style: {
				flex: 1,
				minWidth: 0
			} }, react.createElement("div", { style: S.row }, react.createElement("span", { style: S.k }, "名称"), react.createElement("input", {
				style: {
					...S.input,
					flex: 1
				},
				placeholder: "如：丁满",
				value: d.name,
				onChange: (e) => this.setAgDraft({ name: e.target.value })
			})), react.createElement("div", { style: {
				...S.row,
				alignItems: "flex-start"
			} }, react.createElement("span", { style: {
				...S.k,
				marginTop: 4
			} }, "提示词"), react.createElement("textarea", {
				style: {
					...S.input,
					minWidth: 260,
					flex: 1,
					minHeight: 120,
					fontFamily: "inherit"
				},
				rows: 6,
				placeholder: "你是……（姓名、身份、说话方式、职责）",
				value: d.prompt,
				onChange: (e) => this.setAgDraft({ prompt: e.target.value })
			})), react.createElement("div", { style: S.row }, react.createElement("span", { style: S.k }, "音色方案"), react.createElement("select", {
				style: S.input,
				value: d.preset,
				onChange: (e) => this.setAgDraft({ preset: e.target.value })
			}, opts.map((o) => react.createElement("option", {
				key: o.value,
				value: o.value
			}, o.label))), react.createElement("button", {
				style: {
					...S.btn(false),
					padding: "2px 10px"
				},
				disabled: this.state.agBusy === "prev",
				onClick: () => this.previewAgentVoice()
			}, this.state.agBusy === "prev" ? "合成中…" : "试听音色")), react.createElement("div", { style: S.row }, react.createElement("span", { style: S.k }, "自定义音色 id"), react.createElement("input", {
				style: S.input,
				placeholder: "留空 = 用方案默认音色",
				value: d.voice,
				onChange: (e) => this.setAgDraft({ voice: e.target.value })
			})), react.createElement("div", { style: {
				...S.row,
				marginTop: 4
			} }, react.createElement("span", { style: S.k }, "工具"), react.createElement("input", {
				type: "checkbox",
				checked: !!(d.tools && d.tools.webSearch),
				onChange: (e) => this.setAgDraft({ tools: {
					...d.tools || {},
					webSearch: e.target.checked
				} })
			}), react.createElement("span", { style: {
				fontSize: 12,
				opacity: .6
			} }, "联网搜索"), react.createElement("input", {
				type: "checkbox",
				checked: !!(d.tools && d.tools.voiceTools),
				onChange: (e) => this.setAgDraft({ tools: {
					...d.tools || {},
					voiceTools: e.target.checked
				} })
			}), react.createElement("span", { style: {
				fontSize: 12,
				opacity: .6
			} }, "音量调节")), (() => {
				const cat = this.state.modelCat;
				if (!cat) return react.createElement("div", { style: S.row }, react.createElement("span", { style: S.k }, "模型"), react.createElement("span", { style: S.hint }, "目录读取中…"));
				if (cat.error) return react.createElement("div", { style: S.row }, react.createElement("span", { style: S.k }, "模型"), react.createElement("span", { style: S.err }, "目录读取失败：" + cat.error + " "), react.createElement("button", {
					style: {
						...S.btn(false),
						padding: "2px 10px"
					},
					onClick: () => this.loadModelCat()
				}, "重试"));
				const groups = cat.groups || [];
				const def = cat.defaultSelection;
				const defLabel = def && def.provider ? `跟随 DSH 默认（${def.provider}/${def.model}${def.reasoningEffort ? " · " + effortZh(def.reasoningEffort) : ""}）` : "跟随 DSH 默认";
				const selKey = d.model ? modelKey(d.model.provider, d.model.model) : "";
				const stale = d.model && !groups.some((g) => g.id === d.model.provider && g.models.some((m) => m.id === d.model.model));
				const selGroup = d.model ? groups.find((g) => g.id === d.model.provider) : void 0;
				const selModelInfo = selGroup && d.model ? (selGroup.models || []).find((m) => m.id === d.model.model) : void 0;
				const efforts = selModelInfo && selModelInfo.reasoning && selModelInfo.reasoning.efforts || [];
				return react.createElement("div", null, react.createElement("div", { style: {
					...S.row,
					marginTop: 4
				} }, react.createElement("span", { style: S.k }, "模型"), react.createElement("select", {
					style: {
						...S.input,
						minWidth: 220
					},
					value: stale ? "__stale__" : selKey,
					onChange: (e) => {
						if (!e.target.value) {
							this.setAgDraft({ model: null });
							return;
						}
						const [p, ...rest] = e.target.value.split("::");
						this.setAgDraft({ model: {
							provider: p,
							model: rest.join("::"),
							effort: ""
						} });
					}
				}, react.createElement("option", { value: "" }, defLabel), stale && d.model ? react.createElement("option", { value: "__stale__" }, `${d.model.provider}/${d.model.model}（目录中已不存在，请重选）`) : null, groups.map((g) => react.createElement("optgroup", {
					key: g.id,
					label: g.name
				}, (g.models || []).map((m) => react.createElement("option", {
					key: m.id,
					value: modelKey(g.id, m.id)
				}, m.name || m.id))))), react.createElement("span", { style: {
					fontSize: 12,
					opacity: .6,
					marginLeft: 6
				} }, "思考强度"), react.createElement("select", {
					style: S.input,
					value: d.model && d.model.effort || "",
					disabled: !d.model || efforts.length === 0,
					onChange: (e) => d.model && this.setAgDraft({ model: {
						...d.model,
						effort: e.target.value
					} })
				}, react.createElement("option", { value: "" }, !d.model ? "（先选模型）" : efforts.length === 0 ? "（该模型无档位）" : "模型默认"), efforts.map((ef) => react.createElement("option", {
					key: ef.id,
					value: ef.id
				}, effortZh(ef.id))))), react.createElement("div", { style: S.hint }, "模型目录实时取自 DSH 模型配置（同 GUI 模型选择器）；选「关闭思考」语音回复更快。改动下一轮对话生效，不重建会话。"));
			})(), react.createElement("div", { style: {
				display: "flex",
				gap: 8,
				marginTop: 10,
				flexWrap: "wrap"
			} }, react.createElement("button", {
				style: S.btn(true),
				disabled: b,
				onClick: () => this.saveAgent()
			}, this.state.agBusy === "save" ? "保存中…" : selAg ? "保存 Agent" : "创建 Agent"), selAg && ag.active !== selAg.id ? react.createElement("button", {
				style: S.btn(false),
				disabled: b,
				onClick: () => this.activateAgent(selAg.id, selAg.name)
			}, this.state.agBusy === "act" ? "切换中…" : "切换到此 Agent") : null, selAg && ag.active !== selAg.id ? react.createElement("button", {
				style: S.btn(false),
				disabled: b,
				onClick: () => this.delAgent(selAg.id, selAg.name)
			}, this.state.agBusy === "del" ? "删除中…" : "删除") : null)))));
		}
		renderBanner() {
			const b = this.state.banner;
			if (!b) return null;
			return react.createElement("div", { style: S.banner(b.kind) }, b.text, b.restart && b.restart.length ? react.createElement("button", {
				style: {
					...S.btn(false),
					marginLeft: 10,
					padding: "2px 10px"
				},
				onClick: () => this.engineAction("restart")
			}, "立即重启引擎") : null);
		}
		render() {
			return react.createElement("div", { style: S.wrap }, react.createElement("div", { style: S.tabs }, TABS.map((t) => react.createElement("button", {
				key: t,
				style: S.tab(this.state.tab === t),
				onClick: () => this.setTab(t)
			}, t))), this.renderBanner(), this.state.tab === "状态" ? this.renderStatus() : this.state.tab === "语音" ? this.renderVoice() : this.state.tab === "唤醒词" ? this.renderWake() : this.state.tab === "上下文" ? this.renderContext() : this.state.tab === "日志" ? this.renderLog() : this.renderAgent());
		}
	}
	slots.inject("settings.section", () => slots.register({
		name: "settings.section",
		id: "dsh-voice",
		order: 20,
		label: "语音助手"
	}, () => react.createElement(VoicePanel)));
}
//#endregion
exports.apply = apply;
exports.inject = inject;
exports.name = name;

		return module.exports;
	}
});

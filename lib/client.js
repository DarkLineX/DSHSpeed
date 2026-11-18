window.__ModuleLoader__.load({
	id: "dsh-speed-audit",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let h = react.createElement;

		//#region styles
		const CSS = `
.sa-root { display: flex; flex-direction: column; height: 100%; min-height: 0; font-size: 13px; }
.sa-head { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--dsh-border, rgba(128,128,128,.22)); flex: 0 0 auto; }
.sa-title { font-weight: 600; font-size: 14px; }
.sa-hint { color: var(--dsh-text-secondary, #888); font-size: 12px; }
.sa-spacer { flex: 1 1 auto; }
.sa-btn { border: 1px solid var(--dsh-border, rgba(128,128,128,.3)); background: transparent; color: inherit; border-radius: 6px; padding: 3px 9px; font-size: 12px; cursor: pointer; }
.sa-btn:hover { background: rgba(128,128,128,.14); }
.sa-btn[data-on="1"] { background: rgba(76,194,255,.16); border-color: #4cc2ff; color: #4cc2ff; }
.sa-list { overflow: auto; padding: 8px 10px 24px; display: flex; flex-direction: column; gap: 10px; }
.sa-card { border: 1px solid var(--dsh-border, rgba(128,128,128,.22)); border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; background: rgba(128,128,128,.05); }
.sa-card[data-live="1"] { border-left: 3px solid #2ecc71; }
.sa-card[data-live="0"] { opacity: .85; }
.sa-row { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.sa-sid { font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; opacity: .75; }
.sa-badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid currentColor; }
.sa-badge[data-v="running"], .sa-badge[data-v="running-tool"] { color: #2ecc71; }
.sa-badge[data-v="slow"] { color: #f1c40f; }
.sa-badge[data-v="suspected-stall"], .sa-badge[data-v="hung-in-tool"] { color: #e74c3c; }
.sa-badge[data-v="idle"] { color: #888; }
.sa-bar { display: flex; height: 22px; border-radius: 5px; overflow: hidden; border: 1px solid var(--dsh-border, rgba(128,128,128,.22)); font-size: 10.5px; }
.sa-bar i { display: flex; align-items: center; justify-content: center; color: #0a0b0f; font-weight: 700; font-style: normal; overflow: hidden; white-space: nowrap; font-variant-numeric: tabular-nums; }
.sa-legend { display: flex; flex-wrap: wrap; gap: 12px; font-size: 11px; color: var(--dsh-text-secondary, #888); }
.sa-legend span { display: flex; align-items: center; gap: 5px; }
.sa-dot { width: 8px; height: 8px; border-radius: 2px; flex: none; }
.sa-kv { display: grid; grid-template-columns: auto 1fr; gap: 1px 10px; font-size: 12px; }
.sa-k { color: var(--dsh-text-secondary, #888); }
.sa-v { font-variant-numeric: tabular-nums; }
.sa-tool { font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; }
.sa-empty { padding: 24px 14px; color: var(--dsh-text-secondary, #888); text-align: center; }
.sa-pulse { width: 8px; height: 8px; border-radius: 50%; background: #2ecc71; animation: sa-pulse 1.1s ease-in-out infinite; flex: 0 0 auto; }
@keyframes sa-pulse { 0%,100% { opacity: .35; transform: scale(.85); } 50% { opacity: 1; transform: scale(1); } }
.sa-sect { font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: var(--dsh-text-secondary, #888); margin-top: 2px; }
.sa-tbl { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; font-size: 11.5px; }
.sa-tbl td { padding: 2px 0; border-bottom: 1px solid rgba(128,128,128,.12); }
.sa-tbl td:first-child { text-align: left; }
.sa-tbl td:not(:first-child) { text-align: right; }
.sa-warn { color: #e67e22; }

/* Live run strip: the one thing the composer dock was missing. */
.sa-live { display: flex; align-items: center; gap: 8px; max-width: 100%; padding: 2px 10px; border-radius: 999px; font-size: 11.5px; line-height: 20px; font-variant-numeric: tabular-nums; border: 1px solid transparent; white-space: nowrap; overflow: hidden; }
.sa-live[data-tone="calm"] { color: #2ecc71; border-color: rgba(46,204,113,.35); background: rgba(46,204,113,.08); }
.sa-live[data-tone="warn"] { color: #f1c40f; border-color: rgba(241,196,15,.4); background: rgba(241,196,15,.1); }
.sa-live[data-tone="bad"] { color: #e74c3c; border-color: rgba(231,76,60,.45); background: rgba(231,76,60,.12); }
.sa-live-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; animation: sa-pulse 1.1s ease-in-out infinite; flex: 0 0 auto; }
.sa-live-what { overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; min-width: 0; opacity: .95; }
.sa-live-cmd { font-family: ui-monospace, Consolas, monospace; font-size: 11px; opacity: .7; overflow: hidden; text-overflow: ellipsis; flex: 1 1 auto; min-width: 0; }
.sa-live-sep { opacity: .35; flex: 0 0 auto; }
.sa-live-num { flex: 0 0 auto; opacity: .9; }
.sa-live-num b { font-weight: 600; }
`;
		let styleInjected = false;
		function injectStyle() {
			if (styleInjected) return;
			styleInjected = true;
			try {
				const el = document.createElement("style");
				el.setAttribute("data-dsh-plugin", "speed-audit");
				el.textContent = CSS;
				document.head.appendChild(el);
			} catch {}
		}
		//#endregion

		//#region api
		const API = "api/dsh-speed-audit/snapshot";

		async function fetchSnapshot() {
			const res = await fetch(API, { headers: { accept: "application/json" }, cache: "no-store" });
			if (!res.ok) throw new Error(`snapshot ${res.status}`);
			return await res.json();
		}
		//#endregion

		//#region format
		function dur(ms) {
			if (ms === null || ms === undefined) return "—";
			const s = ms / 1000;
			if (s < 1) return `${Math.round(ms)}ms`;
			if (s < 60) return `${s.toFixed(1)}s`;
			const m = Math.floor(s / 60);
			if (m < 60) return `${m}m${String(Math.floor(s % 60)).padStart(2, "0")}s`;
			const hh = Math.floor(m / 60);
			return `${hh}h${String(m % 60).padStart(2, "0")}m`;
		}
		function pct(v) {
			return `${Math.round((v || 0) * 100)}%`;
		}

		const VERDICT_TEXT = {
			running: "正在跑",
			"running-tool": "工具在跑",
			slow: "慢但在动",
			"suspected-stall": "疑似卡死",
			"hung-in-tool": "工具超久",
			idle: "空闲",
			unknown: "未知",
		};
		const PHASE_TEXT = { model: "模型生成中", tool: "工具执行中", turn: "回合处理中", idle: "空闲" };
		//#endregion

		//#region components
		/** Three-way split: model round trip / tool execution / host gap. */
		function SplitBar({ share }) {
			const model = Math.max(0, share.model || 0);
			const tool = Math.max(0, share.tool || 0);
			const host = Math.max(0, share.host || 0);
			return h("div", null,
				h("div", { className: "sa-bar" },
					model > 0 ? h("i", { style: { width: `${model * 100}%`, background: "#4cc2ff" } }, model > 0.12 ? `模型 ${pct(model)}` : "") : null,
					tool > 0 ? h("i", { style: { width: `${tool * 100}%`, background: "#ffb84c" } }, tool > 0.12 ? `工具 ${pct(tool)}` : "") : null,
					host > 0 ? h("i", { style: { width: `${host * 100}%`, background: "#3a4152", color: "#cfd6e4" } }, host > 0.12 ? `间隙 ${pct(host)}` : "") : null
				),
				h("div", { className: "sa-legend", style: { marginTop: "5px" } },
					h("span", null, h("i", { className: "sa-dot", style: { background: "#4cc2ff" } }), "模型往返"),
					h("span", null, h("i", { className: "sa-dot", style: { background: "#ffb84c" } }), "工具执行"),
					h("span", null, h("i", { className: "sa-dot", style: { background: "#3a4152" } }), "宿主间隙")
				)
			);
		}

		/** Model round trip decomposed into TTFT / reasoning / toolArgs / text. */
		function ModelBar({ llm, share }) {
			const total = (llm.ttft || 0) + (llm.reasoning || 0) + (llm.toolArgs || 0) + (llm.text || 0) + (llm.other || 0);
			if (total <= 0) return null;
			const seg = (v, color, label) => {
				const w = (v / total) * 100;
				if (w <= 0) return null;
				return h("i", { style: { width: `${w}%`, background: color } }, w > 14 ? label : "");
			};
			return h("div", null,
				h("div", { className: "sa-sect", style: { marginBottom: "4px" } }, "模型往返内部"),
				h("div", { className: "sa-bar" },
					seg(llm.ttft, "#ff6b6b", "TTFT"),
					seg(llm.reasoning, "#9d7bff", "思考"),
					seg(llm.toolArgs, "#ffb84c", "工具参数"),
					seg(llm.text, "#3ddc97", "正文")
				),
				h("div", { className: "sa-legend", style: { marginTop: "5px" } },
					h("span", null, "TTFT ", h("b", null, pct(share.ttftOfModel))),
					h("span", null, "思考 ", h("b", null, pct(share.reasoningOfModel))),
					h("span", null, "参数 ", h("b", null, pct(share.toolArgsOfModel))),
					h("span", null, "正文 ", h("b", null, pct(share.textOfModel)))
				)
			);
		}

		function Card({ s }) {
			const tools = (s.tools || []).slice(0, 6);
			const live = s.verdict !== "idle";
			const c = s.counts || {};
			const m = s.ms || {};
			const tk = s.tokens || {};
			const lat = s.toolLatency || {};
			const silentRatio = c.steps > 0 ? 1 - (c.visibleSteps || 0) / c.steps : 0;

			return h("div", { className: "sa-card", "data-live": live ? "1" : "0" },
				h("div", { className: "sa-row" },
					h("span", { className: "sa-sid" }, (s.id || "").slice(0, 20)),
					h("span", { className: "sa-badge", "data-v": s.verdict }, VERDICT_TEXT[s.verdict] || s.verdict),
					live ? h("span", { className: "sa-pulse" }) : null,
					h("span", { className: "sa-spacer" }),
					h("span", { className: "sa-hint" }, `${PHASE_TEXT[s.phase] || s.phase} · 静默 ${dur(s.silentMs)}`)
				),
				s.cwd ? h("div", { className: "sa-row sa-hint", title: s.cwd }, s.cwd) : null,

				h(SplitBar, { share: s.share || {} }),
				h(ModelBar, { llm: m.llm || {}, share: s.share || {} }),

				h("div", { className: "sa-kv" },
					h("span", { className: "sa-k" }, "净工作"), h("span", { className: "sa-v" }, `${dur(m.stepWall)} · ${c.steps} 步 · 每步 ${dur(c.steps ? m.stepWall / c.steps : 0)}`),
					h("span", { className: "sa-k" }, "模型 / 工具"), h("span", { className: "sa-v" }, `${dur(m.model)} / ${dur(m.tool)}`),
					h("span", { className: "sa-k" }, "宿主间隙"), h("span", { className: "sa-v" }, dur(m.stepGap)),
					h("span", { className: "sa-k" }, "可见性"), h("span", { className: "sa-v" },
						`${c.visibleSteps || 0} 步有正文 / ${c.steps || 0} 步 · 静默 ${pct(silentRatio)}`,
						silentRatio > 0.8 ? h("span", { className: "sa-warn" }, " ⚠") : null),
					h("span", { className: "sa-k" }, "路由"), h("span", { className: "sa-v" }, `${s.provider || "—"} / ${s.model || "—"}${s.reasoningEffort ? ` / ${s.reasoningEffort}` : ""}`),
					h("span", { className: "sa-k" }, "tokens"), h("span", { className: "sa-v" }, `入 ${tk.input || 0} · 缓存 ${tk.cacheRead || 0} · 出 ${tk.output || 0} · ${(tk.outputPerSec || 0).toFixed(0)} tok/s`),
					h("span", { className: "sa-k" }, "异常"), h("span", { className: "sa-v" },
						`零流式块步 ${c.zeroStreamSteps || 0} · 重试 ${c.retries || 0} · 压缩 ${c.compactions || 0}${c.compactionErrors ? `（失败 ${c.compactionErrors}）` : ""}`)
				),

				tools.length > 0
					? h("div", null,
						h("div", { className: "sa-sect" }, `工具耗时 top ${tools.length}`),
						h("table", { className: "sa-tbl" },
							h("tbody", null, tools.map((t) => h("tr", { key: t.name },
								h("td", { className: "sa-tool" }, t.name),
								h("td", null, `${t.calls} 次`),
								h("td", null, dur(t.totalMs)),
								h("td", null, `均 ${dur(t.avgMs)}`),
								h("td", null, `峰 ${dur(t.maxMs)}`)
							)))
						),
						lat && lat.buckets && lat.p90 > 0
							? h("div", { className: "sa-hint" },
								`工具延迟 p50 ${dur(lat.p50)} · p90 ${dur(lat.p90)} · p99 ${dur(lat.p99)} · max ${dur(lat.max)}`)
							: null
					)
					: null,

				s.openTools && s.openTools.length > 0
					? h("div", null,
						h("div", { className: "sa-sect" }, `未完成工具 ${s.openTools.length}`),
						s.openTools.map((t) => h("div", { key: t.callId, className: "sa-tool" }, `${t.name} · ${dur(t.ageMs)}`))
					)
					: null
			);
		}

		function SpeedPanel() {
			const [data, setData] = react.useState({ sessions: [] });
			const [error, setError] = react.useState(null);
			const [paused, setPaused] = react.useState(false);

			react.useEffect(() => { injectStyle(); }, []);

			react.useEffect(() => {
				if (paused) return;
				let alive = true;
				const load = async () => {
					try {
						const snap = await fetchSnapshot();
						if (!alive) return;
						setData(snap);
						setError(null);
					} catch (e) {
						if (alive) setError(String((e && e.message) || e));
					}
				};
				load();
				const id = setInterval(load, 1500);
				return () => {
					alive = false;
					clearInterval(id);
				};
			}, [paused]);

			const sessions = data.sessions || [];
			const live = sessions.filter((s) => s.verdict !== "idle").length;

			return h("div", { className: "sa-root", "data-dsh-plugin": "speed-audit" },
				h("div", { className: "sa-head" },
					h("span", { className: "sa-title" }, "时间审计"),
					h("span", { className: "sa-hint" }, error ? `读取失败：${error}` : `${live} 个在跑 / 共 ${sessions.length} 个会话`),
					h("span", { className: "sa-spacer" }),
					h("button", { type: "button", className: "sa-btn", onClick: () => setPaused((p) => !p) }, paused ? "继续" : "暂停")
				),
				sessions.length === 0
					? h("div", { className: "sa-empty" }, error ? "接口不可用" : "还没有会话活动")
					: h("div", { className: "sa-list" }, sessions.map((s) => h(Card, { key: s.id, s })))
			);
		}

		/**
		 * Live run strip for the composer dock.
		 *
		 * The transcript only grows when a whole step commits, so a long step
		 * looks identical to a dead one: nothing on screen for minutes. The
		 * shipped ActivityPill counts finished turns and steps, which cannot
		 * separate those two cases. This strip reports the *current* step and
		 * turn ages plus how long the answer has been silent, so "still working"
		 * and "stuck" stop looking the same.
		 *
		 * It reads one session in light mode once a second and stays empty
		 * whenever the session has no open turn.
		 *
		 * Ages are counted here, from the moment this strip first sees a new
		 * turn, step, or committed answer. The host half sends its own age
		 * fields, but a host still running an older build does not — and the
		 * strip is useless if it can only work against one of the two.
		 */
		function LiveStrip({ sessionId }) {
			const [state, setState] = react.useState({ s: null, ages: null });
			const marksRef = react.useRef(null);

			react.useEffect(() => { injectStyle(); }, []);

			react.useEffect(() => {
				if (sessionId === undefined || sessionId === null) return;
				let alive = true;
				let timer = null;

				const tick = async () => {
					let next = 1500;
					try {
						const s = await fetchLive(sessionId);
						if (!alive) return;
						const open = s !== null && (s.turnOpen || s.stepOpen);
						if (!open) {
							marksRef.current = null;
							setState({ s: null, ages: null });
							// An idle session only changes when the user acts, so
							// polling it at the busy rate is pure noise.
							next = 3000;
						} else {
							const marks = advanceMarks(marksRef.current, s);
							marksRef.current = marks;
							setState({ s, ages: readAges(marks, s) });
							next = 1000;
						}
					} catch (e) {
						if (alive) setState({ s: null, ages: null });
						next = 5000;
					}
					if (alive) timer = setTimeout(tick, next);
				};

				tick();
				return () => {
					alive = false;
					if (timer !== null) clearTimeout(timer);
				};
			}, [sessionId]);

			const s = state.s;
			const ages = state.ages;
			if (s === null || ages === null) return null;

			const tone = liveTone(s, ages.textAge);
			const what = liveWhat(s);

			return h("div", {
				className: "sa-live",
				"data-tone": tone,
				"data-dsh-plugin": "speed-audit",
				title: liveTitle(s, ages),
			},
				h("span", { className: "sa-live-dot" }),
				h("span", { className: "sa-live-what" }, what),
				s.lastTool && s.lastTool.command
					? h("span", { className: "sa-live-cmd" }, s.lastTool.command)
					: null,
				h("span", { className: "sa-live-sep" }, "·"),
				h("span", { className: "sa-live-num" },
					"步 ", h("b", null, dur(ages.stepAge))),
				ages.textAge === null
					? null
					: h("span", { className: "sa-live-num" },
						" · 无正文 ", h("b", null, dur(ages.textAge))),
				ages.turnAge === null
					? null
					: h("span", { className: "sa-live-num" },
						" · 本回合 ", h("b", null, dur(ages.turnAge)))
			);
		}

		/**
		 * Carry the strip's clock forward across two snapshots.
		 *
		 * A turn or step stamp is taken when its identity first changes, and
		 * the answer stamp when the committed-visible-step counter grows. The
		 * counters are cumulative for the session, so a decrease means this is
		 * a different session or a reset — restamp rather than trust it.
		 */
		function advanceMarks(prev, s) {
			const now = Date.now();
			const turnKey = s.turn === null || s.turn === undefined ? null : String(s.turn);
			const stepKey = turnKey === null || s.step === null || s.step === undefined ? null : `${turnKey}/${s.step}`;
			const visible = s.counts && typeof s.counts.visibleSteps === "number" ? s.counts.visibleSteps : null;

			const marks = prev === null ? { turnKey: null, turnStart: now, stepKey: null, stepStart: now, visible: null, lastTextAt: null } : prev;

			if (turnKey !== marks.turnKey) {
				marks.turnKey = turnKey;
				marks.turnStart = now;
			}
			if (stepKey !== marks.stepKey) {
				marks.stepKey = stepKey;
				marks.stepStart = now;
			}
			if (visible !== null) {
				if (marks.visible === null || visible < marks.visible) {
					// First sight of this counter, or a session switch. An answer
					// may have landed minutes ago, so the true age is unknown:
					// report "unknown" rather than a fabricated zero.
					marks.lastTextAt = null;
				} else if (visible > marks.visible) {
					marks.lastTextAt = now;
				}
				marks.visible = visible;
			}
			return marks;
		}

		/** Resolve the ages, preferring the host's own numbers when it sends them. */
		function readAges(marks, s) {
			const now = Date.now();
			// An open tool started inside the current step, so its age is a
			// true lower bound for the step's. Without this an old host would
			// report "步 0ms" on a step that has been in a tool for minutes.
			let toolFloor = 0;
			if (Array.isArray(s.openTools)) {
				for (const t of s.openTools) if (typeof t.ageMs === "number" && t.ageMs > toolFloor) toolFloor = t.ageMs;
			}
			const stepAge = Math.max(
				typeof s.stepAgeMs === "number" ? s.stepAgeMs : Math.max(0, now - marks.stepStart),
				toolFloor
			);
			const turnAge = typeof s.turnAgeMs === "number" ? s.turnAgeMs : Math.max(stepAge, now - marks.turnStart);
			return {
				stepAge,
				turnAge,
				// No answer has committed since this strip started watching, so
				// the turn is the longest span we can vouch for — report that
				// rather than a zero that would read as "just answered".
				textAge: typeof s.textAgeMs === "number" ? s.textAgeMs : marks.lastTextAt === null ? turnAge : Math.max(0, now - marks.lastTextAt),
			};
		}

		/** Green while the pipeline is moving, amber when it has gone quiet, red when it looks wedged. */
		function liveTone(s, textAge) {
			if (s.verdict === "hung-in-tool") return "bad";
			if (s.verdict === "suspected-stall") return "bad";
			const quiet = textAge === null ? 0 : textAge;
			if (quiet > 180000) return "bad";
			if (s.verdict === "slow" || quiet > 60000) return "warn";
			return "calm";
		}

		/** One phrase naming what the harness is doing right now. */
		function liveWhat(s) {
			if (s.verdict === "hung-in-tool") return "工具超久未回";
			if (s.verdict === "suspected-stall") return "长时间无事件";
			if (s.phase === "tool") return s.lastTool ? s.lastTool.name : "工具执行中";
			if (s.phase === "model") return "模型生成中";
			if (s.phase === "turn") return "回合处理中";
			return "运行中";
		}

		/** Tooltip with the numbers that would not fit on the strip. */
		function liveTitle(s, ages) {
			const bits = [
				`阶段 ${PHASE_TEXT[s.phase] || s.phase}`,
				`步 ${s.step ?? "—"} 已 ${dur(ages.stepAge)}`,
				`静默 ${dur(s.silentMs)}`,
				ages.textAge === null ? null : `距上次正文 ${dur(ages.textAge)}`,
				ages.turnAge === null ? null : `本回合 ${dur(ages.turnAge)}`,
				s.provider ? `路由 ${s.provider}/${s.model || "?"}` : null,
				s.openTools && s.openTools.length ? `未完成 ${s.openTools.map((t) => `${t.name} ${dur(t.ageMs)}`).join(", ")}` : null,
			].filter(Boolean);
			return bits.join("\n");
		}

		/** Light-mode read of exactly one session. */
		async function fetchLive(sessionId) {
			const url = `${API}?light=1&id=${encodeURIComponent(sessionId)}`;
			const res = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
			if (!res.ok) throw new Error(`snapshot ${res.status}`);
			const body = await res.json();
			const list = body.sessions || [];
			// Older host halves ignore the `id` filter and answer with every
			// session, so match here rather than trusting list[0]: showing a
			// different session's progress would be worse than showing none.
			const exact = list.find((s) => s.id === sessionId);
			if (exact !== undefined) return exact;
			const loose = list.find((s) => typeof s.id === "string" && (s.id.endsWith(sessionId) || sessionId.endsWith(s.id)));
			return loose ?? null;
		}

		function SpeedIcon({ size = 16 }) {
			return h("svg", {
				width: size, height: size, viewBox: "0 0 16 16", fill: "none",
				stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round",
			},
				h("circle", { cx: 8, cy: 8, r: 6.2 }),
				h("path", { d: "M8 4.4V8l2.6 1.8" })
			);
		}
		//#endregion

		//#region register
		const PANEL_ID = "speed-audit";
		const LIVE_ID = "speed-audit-live";

		function registerPanel(ctx) {
			const slots = ctx.slots;
			const disposers = [];
			disposers.push(slots.inject("sidebar.panellist", () => slots.register({
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: 56,
				label: () => "时间审计"
			}, SpeedIcon)));
			disposers.push(slots.inject("main", () => slots.register({
				name: "main",
				key: PANEL_ID
			}, SpeedPanel)));
			// A fresh id sits beside the shipped `activity`/`usage` pills
			// instead of replacing them; order 0 sorts it first in the dock.
			disposers.push(slots.inject("conversation.composer.dock", () => slots.register({
				name: "conversation.composer.dock",
				id: LIVE_ID,
				order: 0,
				label: () => "运行状态"
			}, LiveStrip)));
			return () => {
				for (const d of disposers.splice(0)) d();
			};
		}
		//#endregion

		const inject = ["slots"];

		function apply(ctx) {
			let dispose = null;
			try {
				dispose = registerPanel(ctx);
			} catch (error) {
				console.warn("[speed-audit] panel registration failed:", error);
			}
			if (dispose !== null) {
				ctx.effect(() => () => { dispose(); }, "speed-audit: ui mounts");
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

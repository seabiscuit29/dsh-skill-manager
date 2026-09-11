// dsh-skill-manager — browser half: the Settings - Skills page.
//
// Same slot and the same visual language as the read-only catalog this replaces
// (cards, badge, expandable detail, design tokens), plus the four controls the
// manager adds: a search box, a per-skill enable/disable action, a delete
// button with inline confirmation, and an adopt action for untracked skills.
//
// Data comes from the plugin's own local routes (`/dsh-skills/*`) rather than
// the session skill catalog: the catalog is filtered by invocation policy and
// therefore cannot show disabled, model-only or untracked skills — the rows a
// manager exists to manage.
window.__ModuleLoader__.load({
	id: "dsh-skill-manager",
	factory: (require) => {
		// The module-system contract: a factory receives `require` and must return
		// its exports. These two lines are load-bearing — without them every
		// `exports.*` assignment below throws "exports is not defined" inside the
		// browser's module loader, which surfaces as "Failed to load plugins".
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const { jsx, jsxs } = require("react/jsx-runtime");
		// The chevron is decoration: if the primitives seed ever changes shape the
		// page keeps working with a text glyph instead.
		let primitives;
		try {
			primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		} catch {
			primitives = undefined;
		}

		const NS = "settings.skills";
		const ROUTE = "/dsh-skills";

		//#region styles
		const css = `
.dshsm_section{max-width:760px;color:var(--dsw-alias-label-primary,#1f2328);flex-direction:column;gap:12px;display:flex}
.dshsm_heading{margin:0;font-size:18px;font-weight:600}
.dshsm_intro{color:var(--dsw-alias-label-tertiary,#8b949e);margin:0;font-size:13px}
.dshsm_status{color:var(--dsw-alias-label-tertiary,#8b949e);margin:0;font-size:13px;line-height:20px}
.dshsm_failure{align-items:center;gap:10px;display:flex}
.dshsm_failure p{color:var(--dsw-alias-state-error-primary,#dc2626);margin:0;font-size:13px;line-height:20px}
.dshsm_failure button{border:1px solid var(--dsw-alias-border-l2,#e5e7eb);color:var(--dsw-alias-label-primary,#1f2328);font:inherit;cursor:pointer;background:0 0;border-radius:6px;padding:4px 10px;font-size:13px;line-height:20px}
.dshsm_failure button:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6)}
.dshsm_toolbar{display:flex;align-items:center;gap:8px}
.dshsm_search{flex:1;min-width:0;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);border-radius:8px;padding:6px 10px;font:inherit;font-size:13px;line-height:20px}
.dshsm_search:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7);outline-offset:-1px}
.dshsm_count{color:var(--dsw-alias-label-tertiary,#8b949e);font-size:12px;white-space:nowrap}
.dshsm_cards{flex-direction:column;gap:10px;margin:0;padding:0;list-style:none;display:flex}
.dshsm_card{border:1px solid var(--dsw-alias-border-l2,#e5e7eb);background:var(--dsw-alias-bg-layer-3,#fff);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}
.dshsm_card:hover{border-color:var(--dsw-alias-label-dimmed,#d0d7de)}
.dshsm_cardOpen{background:var(--dsw-alias-bg-layer-2,#f6f8fa);border-color:var(--dsw-alias-label-dimmed,#d0d7de)}
.dshsm_cardDisabled{opacity:.72}
.dshsm_cardHeader{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px 10px;display:flex}
.dshsm_cardHeader:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7);outline-offset:-2px}
.dshsm_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.dshsm_name{color:var(--dsw-alias-label-primary,#1f2328);font-size:15px;font-weight:600;line-height:1.4}
.dshsm_desc{color:var(--dsw-alias-label-tertiary,#8b949e);font-size:13px;line-height:1.5}
.dshsm_trailing{flex:none;align-items:center;gap:8px;display:flex}
.dshsm_badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform,#eef2ff);color:var(--dsw-alias-label-secondary,#57606a);border-radius:999px;padding:2px 8px;font-size:12px;line-height:18px}
.dshsm_badgeUserOnly{background:var(--dsw-alias-bg-layer-2,#f6f8fa)}
.dshsm_badgeWarn{background:var(--dsw-alias-state-warn-bg,#fff8e6);color:var(--dsw-alias-state-warn-primary,#9a6700)}
.dshsm_chevron{color:var(--dsw-alias-label-tertiary,#8b949e);flex:none}
.dshsm_controls{display:flex;align-items:center;gap:8px;padding:0 16px 12px;flex-wrap:wrap}
.dshsm_controls button{font:inherit;font-size:13px;line-height:20px;border-radius:6px;padding:3px 10px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);background:0 0;color:var(--dsw-alias-label-primary,#1f2328)}
.dshsm_controls button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#f3f4f6)}
.dshsm_controls button:disabled{opacity:.5;cursor:default}
.dshsm_danger{color:var(--dsw-alias-state-error-primary,#dc2626);border-color:var(--dsw-alias-state-error-primary,#dc2626)}
.dshsm_state{display:inline-flex;align-items:center;gap:6px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#57606a);white-space:nowrap}
.dshsm_state::before{content:"";width:6px;height:6px;border-radius:99px;background:var(--dsw-alias-state-success-primary,#1a7f37)}
.dshsm_stateOff::before{background:var(--dsw-alias-label-dimmed,#d0d7de)}
.dshsm_confirm{display:flex;align-items:center;gap:8px;border-top:1px solid var(--dsw-alias-border-l2,#e5e7eb);padding:10px 16px;font-size:13px;color:var(--dsw-alias-state-error-primary,#dc2626);flex-wrap:wrap}
.dshsm_notice{margin:0;padding:8px 10px;border-radius:8px;font-size:13px;line-height:20px}
.dshsm_noticeError{background:var(--dsw-alias-state-error-bg,#fdecec);color:var(--dsw-alias-state-error-primary,#dc2626)}
.dshsm_noticeOk{background:var(--dsw-alias-state-success-bg,#eaf7ee);color:var(--dsw-alias-state-success-primary,#1a7f37)}
.dshsm_body{border-top:1px solid var(--dsw-alias-border-l2,#e5e7eb);padding:12px 16px;display:flex;flex-direction:column;gap:8px}
.dshsm_field{margin:0;display:flex;gap:8px;font-size:13px;line-height:20px}
.dshsm_field dt{color:var(--dsw-alias-label-tertiary,#8b949e);min-width:76px;margin:0}
.dshsm_field dd{margin:0;color:var(--dsw-alias-label-primary,#1f2328);word-break:break-all}
.dshsm_mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
`;
		const tagId = "dsh-skill-manager/SkillsSection.module.css";
		if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) === null) {
			const tag = document.createElement("style");
			tag.setAttribute("data-plugin-css", tagId);
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		const styles = {
			section: "dshsm_section",
			heading: "dshsm_heading",
			intro: "dshsm_intro",
			status: "dshsm_status",
			failure: "dshsm_failure",
			toolbar: "dshsm_toolbar",
			search: "dshsm_search",
			count: "dshsm_count",
			cards: "dshsm_cards",
			card: "dshsm_card",
			cardOpen: "dshsm_cardOpen",
			cardDisabled: "dshsm_cardDisabled",
			cardHeader: "dshsm_cardHeader",
			headText: "dshsm_headText",
			name: "dshsm_name",
			desc: "dshsm_desc",
			trailing: "dshsm_trailing",
			badge: "dshsm_badge",
			badgeUserOnly: "dshsm_badgeUserOnly",
			badgeWarn: "dshsm_badgeWarn",
			chevron: "dshsm_chevron",
			controls: "dshsm_controls",
			danger: "dshsm_danger",
			state: "dshsm_state",
			stateOff: "dshsm_stateOff",
			confirm: "dshsm_confirm",
			notice: "dshsm_notice",
			noticeError: "dshsm_noticeError",
			noticeOk: "dshsm_noticeOk",
			body: "dshsm_body",
			field: "dshsm_field",
			mono: "dshsm_mono",
		};
		//#endregion

		//#region locales
		/** Simplified Chinese dictionary (the key-set source of truth). */
		const zh = {
			nav: "技能",
			heading: "技能",
			intro: "管理当前 DSH 已安装的技能（Skill）：查询、禁用/启用、卸载。安装与升级请在对话中使用 /skill 命令。",
			loading: "正在读取技能…",
			error: "暂时无法读取技能。",
			retry: "重试",
			empty: "暂无技能。",
			emptyFiltered: "没有匹配的技能。",
			searchPlaceholder: "搜索名称或描述…",
			badgeModel: "模型可调用",
			badgeUserOnly: "仅用户",
			badgeDisabled: "已禁用",
			badgeUntracked: "未入账",
			badgeInvalid: "格式非法",
			badgeExternal: "其他根",
			notManaged: "由其他技能根提供，本页只读（不在 ~/.dsh/skills 内）",
			catalogWarning: "注意：技能目录查询失败，列表可能不完整",
			enable: "启用",
			disable: "禁用",
			remove: "删除",
			adopt: "收编",
			migrate: "迁移",
			confirmMigrate: "确认迁入受管根？迁移后即可禁用或卸载。",
			confirmRemove: "确认删除该技能？将保留备份副本。",
			confirm: "确认",
			cancel: "取消",
			whenToUse: "适用场景",
			permission: "调用权限",
			permissionModel: "对话中模型可自动加载",
			permissionUserOnly: "仅用户通过 /名称 手动调用",
			origin: "来源",
			state: "状态",
			path: "位置",
			stateEnabled: "已启用",
			stateDisabled: "已禁用",
			stateMissing: "文件缺失",
			working: "处理中…",
		};
		/** English dictionary, checked complete against the zh key set. */
		const en = {
			nav: "Skills",
			heading: "Skills",
			intro:
				"Manage the skills installed in this DSH deployment: search, disable/enable, remove. Installing and updating stays in the /skill command.",
			loading: "Reading skills…",
			error: "Skills are temporarily unavailable.",
			retry: "Retry",
			empty: "No skills installed.",
			emptyFiltered: "No skill matches this search.",
			searchPlaceholder: "Search name or description…",
			badgeModel: "Model-invocable",
			badgeUserOnly: "User-only",
			badgeDisabled: "Disabled",
			badgeUntracked: "Untracked",
			badgeInvalid: "Invalid",
			badgeExternal: "Other root",
			notManaged: "Published from another skill root — read-only here (outside ~/.dsh/skills)",
			catalogWarning: "Note: the skill catalog query failed, so this list may be incomplete",
			enable: "Enable",
			disable: "Disable",
			remove: "Remove",
			adopt: "Adopt",
			migrate: "Migrate",
			confirmMigrate: "Move this skill into the managed root? It becomes disableable and removable after the move.",
			confirmRemove: "Remove this skill? A backup copy is kept.",
			confirm: "Confirm",
			cancel: "Cancel",
			whenToUse: "When to use",
			permission: "Invocation",
			permissionModel: "The model may load it automatically",
			permissionUserOnly: "Invoke manually with /name",
			origin: "Source",
			state: "State",
			path: "Location",
			stateEnabled: "Enabled",
			stateDisabled: "Disabled",
			stateMissing: "Files missing",
			working: "Working…",
		};
		//#endregion

		//#region wire
		/** Absolute URL for one manager route, honouring a reverse-proxy base path. */
		function api(path) {
			return new URL(`${ROUTE}${path}`, document.baseURI).toString();
		}

		/** One JSON request against the manager's local routes. */
		async function request(path, options = {}) {
			const response = await fetch(api(path), {
				method: options.method ?? "GET",
				headers: options.body === undefined ? undefined : { "content-type": "application/json" },
				body: options.body === undefined ? undefined : JSON.stringify(options.body),
				cache: "no-store",
			});
			let payload;
			try {
				payload = await response.json();
			} catch {
				payload = undefined;
			}
			if (!response.ok || payload?.ok === false) {
				throw new Error(payload?.error ?? `HTTP ${response.status}`);
			}
			return payload;
		}
		//#endregion

		//#region view
		/** The Skills management section: list, search, enable/disable, remove. */
		function SkillsSection({ t }) {
			const [state, setState] = react.useState({ status: "loading", rows: [] });
			const [query, setQuery] = react.useState("");
			const [catalogNotice, setCatalogNotice] = react.useState(null);
			const [expanded, setExpanded] = react.useState(() => new Set());
			const [busy, setBusy] = react.useState(null);
			const [notice, setNotice] = react.useState(null);
			const [confirming, setConfirming] = react.useState(null);
			const [confirmingMigrate, setConfirmingMigrate] = react.useState(null);
			const [reload, setReload] = react.useState(0);

			react.useEffect(() => {
				let current = true;
				setState((previous) => ({ status: "loading", rows: previous.rows }));
				request("/list").then(
					(payload) => {
						if (!current) return;
						setState({ status: payload.rows.length === 0 ? "empty" : "ready", rows: payload.rows });
						// A failed catalog query means the deployment's own registry could not be
						// read: foreign roots are still listed (the host enumerates them itself),
						// but a project-root or bundled skill may be missing — say so explicitly.
						setCatalogNotice(typeof payload.catalogError === "string" ? payload.catalogError : null);
					},
					() => {
						if (current) setState({ status: "error", rows: [] });
					},
				);
				return () => {
					current = false;
				};
			}, [reload]);

			const run = async (name, action, ok) => {
				setBusy(name);
				setNotice(null);
				try {
					const result = await action();
					setNotice({ kind: "ok", text: ok(result) });
					setConfirming(null);
					setReload((value) => value + 1);
				} catch (error) {
					setNotice({ kind: "error", text: error.message });
				} finally {
					setBusy(null);
				}
			};

			const toggle = (row, next) =>
				run(
					row.name,
					() => request("/set-enabled", { method: "POST", body: { name: row.name, enabled: next } }),
					(result) =>
						next
							? `${row.name}: ${t("stateEnabled")} — ${result.changed === false ? "no change" : "下一轮对话起生效"}`
							: `${row.name}: ${t("stateDisabled")} — 下一轮对话起生效`,
				);

			const remove = (row) =>
				run(
					row.name,
					() => request("/remove", { method: "POST", body: { name: row.name } }),
					(result) => `${row.name}: ${t("remove")} ✓ ${result.backupPath ?? ""}`,
				);

			const adopt = (row) =>
				run(
					row.name,
					() => request("/adopt", { method: "POST", body: { name: row.name } }),
					(result) => `${row.name}: ${t("adopt")} ✓ ${result.source ?? "local"}`,
				);

			const migrate = (row) =>
				run(
					row.name,
					() => request("/migrate", { method: "POST", body: { name: row.name } }),
					(result) => `${row.name}: ${t("migrate")} ✓ ${result.to ?? ""}`,
				);

			const filter = query.trim().toLowerCase();
			const rows =
				state.status === "ready" && filter !== ""
					? state.rows.filter(
							(row) =>
								row.name.toLowerCase().includes(filter) ||
								String(row.description ?? "").toLowerCase().includes(filter),
						)
					: state.rows;

			const badge = (row) => {
				const marks = [];
				if (!row.managed) marks.push(jsx("span", { className: `${styles.badge} ${styles.badgeWarn}`, children: t("badgeExternal") }, "external"));
				if (row.state === "disabled") marks.push(jsx("span", { className: `${styles.badge} ${styles.badgeWarn}`, children: t("badgeDisabled") }, "disabled"));
				if (row.managed && !row.tracked) marks.push(jsx("span", { className: `${styles.badge} ${styles.badgeWarn}`, children: t("badgeUntracked") }, "untracked"));
				if (!row.valid) marks.push(jsx("span", { className: `${styles.badge} ${styles.badgeWarn}`, children: t("badgeInvalid") }, "invalid"));
				marks.push(
					jsx(
						"span",
						{
							className: row.invocation?.modelInvocable ? styles.badge : `${styles.badge} ${styles.badgeUserOnly}`,
							children: row.invocation?.modelInvocable ? t("badgeModel") : t("badgeUserOnly"),
						},
						"invocation",
					),
				);
				return marks;
			};

			const Chevron = (props) =>
				primitives?.IconChevronDownOutline14 !== undefined
					? jsx(primitives.IconChevronDownOutline14, props)
					: jsx("span", { className: styles.chevron, "aria-hidden": "true", children: "▾" });

			return jsxs("div", {
				className: styles.section,
				"aria-busy": state.status === "loading" ? "true" : undefined,
				children: [
					jsx("h2", { className: styles.heading, children: t("heading") }),
					jsx("p", { className: styles.intro, children: t("intro") }),
					state.status === "loading"
						? jsx("p", { className: styles.status, children: t("loading") })
						: null,
					state.status === "error"
						? jsxs("div", {
								className: styles.failure,
								children: [
									jsx("p", { role: "alert", children: t("error") }),
									jsx("button", {
										type: "button",
										onClick: () => setReload((value) => value + 1),
										children: t("retry"),
									}),
								],
							})
						: null,
					notice !== null
						? jsx("p", {
								className: `${styles.notice} ${notice.kind === "error" ? styles.noticeError : styles.noticeOk}`,
								role: notice.kind === "error" ? "alert" : "status",
								children: notice.text,
							})
						: null,
					catalogNotice !== null
						? jsx("p", {
								className: `${styles.notice} ${styles.noticeError}`,
								role: "status",
								children: `${t("catalogWarning")}: ${catalogNotice}`,
							})
						: null,
					state.status === "empty"
						? jsx("p", { className: styles.status, children: t("empty") })
						: null,
					state.status === "ready"
						? jsxs("div", {
								className: styles.toolbar,
								children: [
									jsx("input", {
										className: styles.search,
										type: "search",
										value: query,
										placeholder: t("searchPlaceholder"),
										"aria-label": t("searchPlaceholder"),
										onChange: (event) => setQuery(event.target.value),
									}),
									jsx("span", {
										className: styles.count,
										children: `${rows.length}/${state.rows.length}`,
									}),
								],
							})
						: null,
					state.status === "ready" && rows.length === 0
						? jsx("p", { className: styles.status, children: t("emptyFiltered") })
						: null,
					state.status === "ready" && rows.length > 0
						? jsx("ul", {
								className: styles.cards,
								children: rows.map((row) => {
									const open = expanded.has(row.name);
									const detailId = `dshsm-details-${row.name}`;
									const pending = busy === row.name;
									const enabled = row.state === "enabled";
									return jsxs(
										"li",
										{
											className: [
												styles.card,
												open ? styles.cardOpen : "",
												enabled ? "" : styles.cardDisabled,
											]
												.filter(Boolean)
												.join(" "),
											"data-skill": row.name,
											children: [
												jsxs("button", {
													className: styles.cardHeader,
													type: "button",
													"aria-expanded": open ? "true" : "false",
													"aria-controls": detailId,
													onClick: () =>
														setExpanded((previous) => {
															const next = new Set(previous);
															if (next.has(row.name)) next.delete(row.name);
															else next.add(row.name);
															return next;
														}),
													children: [
														jsxs("span", {
															className: styles.headText,
															children: [
																jsx("span", { className: styles.name, children: row.name }),
																jsx("span", { className: styles.desc, children: row.description }),
															],
														}),
														jsxs("span", {
															className: styles.trailing,
															children: [...badge(row), jsx(Chevron, { className: styles.chevron, "aria-hidden": "true" })],
														}),
													],
												}),
												jsxs("div", {
													className: styles.controls,
													children: row.managed
														? [
																// The control states the CURRENT state and offers the ACTION as a
																// button. A checkbox labelled with the action reads backwards
																// ("checked + 禁用" looks like "disabled is on"), so the state is
																// rendered as text and the button says what clicking will do.
																jsx("span", {
																	className: enabled ? styles.state : `${styles.state} ${styles.stateOff}`,
																	children: enabled ? t("stateEnabled") : t("stateDisabled"),
																}),
																jsx("button", {
																	type: "button",
																	disabled: pending || row.state === "missing",
																	title: enabled ? `${t("disable")} ${row.name}` : `${t("enable")} ${row.name}`,
																	onClick: () => toggle(row, !enabled),
																	children: enabled ? t("disable") : t("enable"),
																}),
																jsx("button", {
																	type: "button",
																	className: styles.danger,
																	disabled: pending,
																	onClick: () => setConfirming(row.name),
																	children: t("remove"),
																}),
																row.tracked
																	? null
																	: jsx("button", {
																			type: "button",
																			disabled: pending,
																			onClick: () => adopt(row),
																			children: t("adopt"),
																		}),
																pending ? jsx("span", { className: styles.count, children: t("working") }) : null,
															]
														: [
																jsx("span", { className: styles.count, children: t("notManaged") }),
																// A row from another root cannot be disabled or removed here, but it
																// can be moved into the managed root — then those actions apply.
																jsx("button", {
																	type: "button",
																	disabled: pending,
																	title: `${t("migrate")} ${row.name}`,
																	onClick: () => setConfirmingMigrate(row.name),
																	children: t("migrate"),
																}),
															],
												}),
												confirmingMigrate === row.name
													? jsxs("div", {
															className: styles.confirm,
															children: [
																jsx("span", { children: t("confirmMigrate") }),
																jsx("button", {
																	type: "button",
																	disabled: pending,
																	onClick: () => migrate(row),
																	children: t("confirm"),
																}),
																jsx("button", {
																	type: "button",
																	onClick: () => setConfirmingMigrate(null),
																	children: t("cancel"),
																}),
															],
														})
													: null,
												confirming === row.name
													? jsxs("div", {
															className: styles.confirm,
															children: [
																jsx("span", { children: t("confirmRemove") }),
																jsx("button", {
																	type: "button",
																	className: styles.danger,
																	disabled: pending,
																	onClick: () => remove(row),
																	children: t("confirm"),
																}),
																jsx("button", {
																	type: "button",
																	onClick: () => setConfirming(null),
																	children: t("cancel"),
																}),
															],
														})
													: null,
												open
													? jsxs("div", {
															className: styles.body,
															id: detailId,
															children: [
																row.whenToUse === undefined
																	? null
																	: jsxs("dl", {
																			className: styles.field,
																			children: [
																				jsx("dt", { children: t("whenToUse") }),
																				jsx("dd", { children: row.whenToUse }),
																			],
																		}),
																jsxs("dl", {
																	className: styles.field,
																	children: [
																		jsx("dt", { children: t("permission") }),
																		jsx("dd", {
																			children: row.invocation?.modelInvocable
																				? t("permissionModel")
																				: t("permissionUserOnly"),
																		}),
																	],
																}),
																jsxs("dl", {
																	className: styles.field,
																	children: [
																		jsx("dt", { children: t("state") }),
																		jsx("dd", {
																			children:
																				row.state === "enabled"
																					? t("stateEnabled")
																					: row.state === "disabled"
																						? t("stateDisabled")
																						: t("stateMissing"),
																		}),
																	],
																}),
																jsxs("dl", {
																	className: styles.field,
																	children: [
																		jsx("dt", { children: t("origin") }),
																		jsx("dd", {
																			className: styles.mono,
																			children: `${row.managed ? (row.source ?? "local") : `root: ${row.providerSource ?? "other"}`}${row.ref ? ` @${String(row.ref).slice(0, 12)}` : ""}${row.form === "flat" ? " (flat)" : ""}`,
																		}),
																	],
																}),
																jsxs("dl", {
																	className: styles.field,
																	children: [
																		jsx("dt", { children: t("path") }),
																		jsx("dd", {
																			className: styles.mono,
																			children: row.path ?? "-",
																		}),
																	],
																}),
															],
														})
													: null,
											],
										},
										row.name,
									);
								}),
							})
						: null,
				],
			});
		}
		//#endregion

		/** Required client services: the settings-section slot ledger and dictionaries. */
		const inject = ["slots", "locale"];

		/**
		 * Client plugin body: register the Skills management section into the
		 * settings shell, in the same nav seat the read-only catalog used.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-skill-manager: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{
						name: "settings.section",
						id: "skills",
						order: 16,
						label: () => t("nav"),
						locale: NS,
						inject: () => ({ t }),
					},
					SkillsSection,
				),
			);
		}

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});

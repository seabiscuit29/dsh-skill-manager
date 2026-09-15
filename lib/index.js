// dsh-skill-manager — host half.
//
// One plugin, two entries over one implementation:
//   * the `/skill` command group (model/human command plane), and
//   * the Settings - Skills page (browser), which talks to the local routes
//     mounted here.
// Scope is deliberately local: this manager lists, disables and removes skills
// that are already installed. It never searches the internet for new ones.
import { buildDoctor, buildRows } from "./core/scan.js";
import { observeCatalog, observeDeploymentCatalog } from "./core/catalog.js";
import { formatRows } from "./core/report.js";
import { installSkill, removeSkill, verifySkill } from "./core/install.js";
import { loadManifest } from "./core/manifest.js";
import { adoptSkill, setSkillEnabled } from "./core/state.js";
import { migrateAll, migrateSkill, scanMigratable } from "./core/migrate.js";
import { mountSkillRoutes } from "./http.js";
import { ensureNavIconPatch } from "./navicon.js";
import { checkClientContract } from "./selfcheck.js";

export const name = "dsh-skill-manager";
// `webServer` is intentionally NOT listed here: it exists only in web
// deployments, and a missing injection would stop the whole plugin — including
// the `/skill` command — from loading. It is injected as a nested, optional
// dependency inside apply() instead.
export const inject = ["commands", "skills"];

/**
 * Runtime wiring recorded during apply(), reported by `/skill doctor`. A plugin can
 * load while a sub-part silently fails (routes never mounted, icon patch anchored
 * out), and that is invisible from outside — so it is recorded where doctor reads it.
 */
const runtime = {
	commands: false,
	webServer: false,
	routes: false,
	navIcon: "unknown",
	catalogError: undefined,
	catalogComplete: undefined,
	catalogCount: undefined,
	errors: [],
};

const USAGE = [
	"用法 usage:",
	"  /skill list                          列出全部已安装技能 list every installed skill",
	"  /skill search <text>                 按名称/描述过滤 filter by name or description",
	"  /skill disable <name>                禁用（移入隐藏区，可随时启用）",
	"  /skill enable <name>                 启用（移回技能根）",
	"  /skill remove <name> [--purge]       卸载（默认保留备份 keep a backup by default）",
	"  /skill adopt <name> [--source <s>]   收编未入账技能 record an untracked skill",
	"  /skill migrate [<name>] [--dry-run]  把其他技能根的技能迁入受管根并入账 migrate from another root",
	"  /skill verify [<name>]               本地完整性校验 local integrity check",
	"  /skill doctor                        环境与账本诊断 environment and ledger diagnostics",
	"  /skill install <spec> [--force]      安装 install（github:owner/repo#ref/path | git URL | 本地路径）",
].join("\n");

/**
 * Split a raw input into positional arguments and flags.
 * Only flags an actual code path consumes live here: an accepted-but-ignored flag
 * silently promises behaviour that never happens.
 */
function parseArgs(raw) {
	const tokens = raw.trim() === "" ? [] : raw.trim().split(/\s+/);
	const positional = [];
	const flags = { force: false, purge: false, dryRun: false, source: undefined };
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token === "--force") flags.force = true;
		else if (token === "--purge") flags.purge = true;
		else if (token === "--dry-run") flags.dryRun = true;
		else if (token === "--source") flags.source = tokens[++index];
		else positional.push(token);
	}
	return { positional, flags };
}

/**
 * The catalog as the invoking agent sees it, recorded for `/skill doctor`.
 * The scope is the point: an unscoped query reads the global layer alone, which
 * is empty here and used to mark every healthy row "not-in-catalog".
 */
async function catalogFor(ctx, invocation) {
	const agent = invocation?.agent;
	const observation = await observeCatalog(ctx.skills, {
		scope: agent,
		cwd: agent?.session?.header?.cwd,
		signal: invocation?.signal,
	});
	runtime.catalogError = observation.error;
	runtime.catalogComplete = observation.complete;
	runtime.catalogCount = observation.count;
	return observation;
}

/** Register the `/skill` command group. */
function registerCommand(ctx) {
	ctx.commands.register({
		name: "skill",
		description:
			"Manage installed skills: list, search, enable/disable, remove · 已安装技能管理：查询、启用/禁用、卸载",
		input: {
			hint: "list | search <text> | disable <name> | enable <name> | remove <name> | adopt <name> | verify | doctor",
		},
		recordInput: true,
		handler: async (invocation) => {
			const { positional, flags } = parseArgs(invocation.rawInput ?? "");
			const sub = (positional.shift() ?? "list").toLowerCase();
			try {
				switch (sub) {
					case "list": {
						const observation = await catalogFor(ctx, invocation);
						const view = buildRows({ catalog: observation.summaries });
						return { kind: "success", text: formatRows(view.rows, observation) };
					}
					case "search": {
						const query = positional.join(" ").toLowerCase();
						if (query === "") return { kind: "error", text: `缺少搜索词 missing search text\n${USAGE}` };
						const observation = await catalogFor(ctx, invocation);
						const rows = buildRows({ catalog: observation.summaries }).rows.filter(
							(row) =>
								row.name.toLowerCase().includes(query) ||
								String(row.description ?? "").toLowerCase().includes(query),
						);
						return {
							kind: "success",
							text: `匹配 "${query}" 的技能 matches: ${rows.length}\n${formatRows(rows, observation)}`,
						};
					}
					case "disable":
					case "enable": {
						const target = positional[0];
						if (target === undefined) return { kind: "error", text: `缺少技能名 missing skill name\n${USAGE}` };
						const result = await setSkillEnabled(target, sub === "enable");
						return { kind: "success", text: result.message };
					}
					case "remove":
					case "uninstall": {
						const target = positional[0];
						if (target === undefined) return { kind: "error", text: `缺少技能名 missing skill name\n${USAGE}` };
						const result = await removeSkill(target, { purge: flags.purge, force: flags.force });
						return { kind: "success", text: result.message };
					}
					case "adopt": {
						const target = positional[0];
						if (target === undefined) return { kind: "error", text: `缺少技能名 missing skill name\n${USAGE}` };
						const result = await adoptSkill(target, { source: flags.source });
						return { kind: "success", text: result.message };
					}
					case "verify": {
						const observation = await catalogFor(ctx, invocation);
						const rows = buildRows({ catalog: observation.summaries }).rows;
						const targets =
							positional.length > 0 ? positional : rows.filter((row) => row.managed).map((row) => row.name);
						if (targets.length === 0) return { kind: "success", text: "没有可校验的技能 nothing to verify" };
						const lines = [];
						for (const target of targets) {
							const result = verifySkill(target);
							if (!result.ok) lines.push(`✗ ${target}: ${result.error}`);
							else if (result.clean) lines.push(`✓ ${result.name} [${result.state}] clean`);
							else
								lines.push(
									`! ${result.name} [${result.state}] modified=${result.modified.length} missing=${result.missing.length} extra=${result.extra.length}`,
								);
						}
						return { kind: "success", text: lines.join("\n") };
					}
					case "doctor": {
						const observation = await catalogFor(ctx, invocation);
						let report;
						try {
							report = buildDoctor({ catalog: observation.summaries });
						} catch (error) {
							return { kind: "error", text: `doctor failed: ${error.message}` };
						}
						let manifestCount;
						try {
							manifestCount = `${Object.keys(loadManifest().skills).length} tracked`;
						} catch (error) {
							manifestCount = `unreadable: ${error.message}`;
						}
						let migratable = "n/a";
						try {
							const scan = scanMigratable();
							migratable = `${scan.candidates.length} migratable${scan.blocked.length > 0 ? `, ${scan.blocked.length} blocked` : ""}`;
						} catch (error) {
							migratable = `unreadable: ${error.message}`;
						}
						const client = checkClientContract();
						return {
							kind: "success",
							text: [
								"dsh-skill-manager doctor · 诊断",
								`skill root: ${report.root} ${report.rootExists ? "exists" : "MISSING"} (${report.liveCount} live)`,
								`hidden zone: ${report.zone} ${report.zoneExists ? "exists" : "absent"} (${report.hiddenCount} disabled)`,
								`manifest: ${report.manifestFile} (${manifestCount})`,
								`untracked: ${report.untracked.join(", ") || "-"}`,
								`missing files: ${report.missing.join(", ") || "-"}`,
								`symbolic links (never published): ${report.symlinked.join(", ") || "-"}`,
								`other roots (read-only): ${report.external.join(", ") || "-"} · ${migratable}`,
								`wiring: commands=${runtime.commands ? "ok" : "FAILED"} routes=${
									runtime.routes ? "ok" : runtime.webServer ? "FAILED" : "n/a (no web server)"
								} navIcon=${runtime.navIcon}`,
								`client half: ${client.ok ? "ok" : "PROBLEMS"}${
									client.notes.length > 0 ? ` — ${client.notes.join("; ")}` : ""
								}`,
								`catalog query: ${
									runtime.catalogError !== undefined
										? `FAILED — ${runtime.catalogError}`
										: `${runtime.catalogCount ?? 0} entries, ${
												runtime.catalogComplete === true ? "complete" : "INCOMPLETE"
											} (scope: this session)`
								}`,
								...client.problems.map((problem) => `  ✗ ${problem}`),
								...runtime.errors.map((error) => `  ✗ ${error}`),
							].join("\n"),
						};
					}
					case "install": {
						const spec = positional[0];
						if (spec === undefined) return { kind: "error", text: `缺少来源 missing source spec\n${USAGE}` };
						const result = await installSkill(spec, { force: flags.force });
						return { kind: "success", text: result.message };
					}
					case "migrate": {
						const target = positional[0];
						if (target !== undefined) {
							if (flags.dryRun) {
								const scan = scanMigratable();
								const candidate = scan.candidates.find((entry) => entry.name === target);
								const reason = scan.blocked.find((entry) => entry.name === target);
								return {
									kind: candidate === undefined ? "error" : "success",
									text:
										candidate === undefined
											? `"${target}" 不可迁移 not migratable: ${reason?.reason ?? "not found in another root"}`
											: `将迁移 would migrate: ${candidate.from} → ${candidate.to}`,
								};
							}
							const result = await migrateSkill(target);
							return { kind: "success", text: result.message };
						}
						const result = await migrateAll({ dryRun: flags.dryRun });
						const lines = [
							result.dryRun
								? `可迁移 migratable: ${result.candidates}`
								: `已迁移 migrated: ${result.moved.length}/${result.candidates}`,
						];
						for (const entry of result.moved) {
							lines.push(`  ✓ ${entry.name}${result.dryRun ? ` (${entry.from} → ${entry.to})` : ""}`);
						}
						for (const entry of result.blocked) {
							lines.push(`  ✗ ${entry.name}: ${entry.reason}`);
						}
						if (result.candidates === 0 && result.blocked.length === 0) {
							lines.push("  没有来自其他技能根的技能 nothing published from another local root");
						}
						return { kind: "success", text: lines.join("\n") };
					}
					case "update":
						return {
							kind: "success",
							text: "暂不支持更新（近期范围外）。清单已记录 source/ref，将来可直接生长。\nupdate is out of the current scope; the manifest already records source/ref for a future version.",
						};
					default:
						return { kind: "error", text: `未知子命令 unknown subcommand "${sub}"\n${USAGE}` };
				}
			} catch (error) {
				return { kind: "error", text: error?.message ?? String(error) };
			}
		},
	});
}

/**
 * Host plugin body: command group, local routes (web only) and the nav icon
 * self-heal. Nothing here may throw out of apply — a manager that fails to load
 * would take the Skills command down with it.
 */
export function apply(ctx) {
	try {
		registerCommand(ctx);
		runtime.commands = true;
	} catch (error) {
		runtime.errors.push(`command registration failed: ${error?.message ?? error}`);
		ctx.logger?.warn?.(`dsh-skill-manager: ${runtime.errors[runtime.errors.length - 1]}`);
	}

	// Nested injection keeps the plugin loadable in headless/tui profiles, where
	// there is no web server to mount routes on.
	ctx.inject(["webServer"], (hostCtx) => {
		runtime.webServer = true;
		try {
			hostCtx.effect(
				() =>
					mountSkillRoutes({
						webServer: hostCtx.webServer,
						// The catalog adds read-only rows for skills published from roots
						// this manager does not own. It is asked per live agent, because
						// an unscoped query reads the global layer alone — which is empty
						// here and would leave the page blind to project/custom roots.
						catalog: () => observeDeploymentCatalog(ctx),
					}),
				"dsh-skill-manager: local routes",
			);
			runtime.routes = true;
		} catch (error) {
			runtime.errors.push(`route mount failed: ${error?.message ?? error}`);
			hostCtx.logger?.warn?.(`dsh-skill-manager: ${runtime.errors[runtime.errors.length - 1]}`);
		}
	});

	try {
		runtime.navIcon = ensureNavIconPatch().status;
	} catch {
		// Cosmetic only; never fail boot for the icon.
		runtime.navIcon = "error";
	}
}

// The model-facing skill catalog is an AGENT-scoped view.
//
// `ctx.skills.list()` with no options reads "the global layer alone" (dsh-skill,
// `SkillViewOptions.scope`), and that layer is empty in a host context — which is
// how every row of `/skill list` once came out marked `not-in-catalog`, built-in
// bundled skills included. The canonical host-side call is the one dsh-tool-skill
// itself makes: `snapshot({ scope: agent, cwd: agent.session.header.cwd })`.
//
// A second trap is that `list()` drops the completeness flag. Discovery can be
// partial (a provider still settling, a concurrent revision), and a partial
// answer must never be read as "the model cannot see this skill".
//
// This module owns the one correct way to ask, and the rule for when the answer
// may back a per-row claim.

/** Footer line for an observation that cannot back per-row visibility claims. */
export function catalogNote(observation, rowCount) {
	if (observation === undefined || observation === null) return undefined;
	if (catalogUsable(observation, rowCount)) return undefined;
	if (observation.error !== undefined)
		return `目录查询失败 catalog query FAILED — ${observation.error}；已省略可见性标记 visibility markers omitted`;
	if (observation.complete !== true)
		return "目录查询未完成 catalog observation incomplete；已省略可见性标记 visibility markers omitted";
	return "目录查询返回 0 条 catalog observation returned no entries；已省略可见性标记 visibility markers omitted";
}

/**
 * Whether one observation may back per-row "in catalog" claims.
 * @param observation - a value returned by {@link observeCatalog}.
 * @param rowCount - how many rows the report is about to describe.
 * @returns whether the observation answers "can the model see this skill?".
 */
export function catalogUsable(observation, rowCount) {
	if (observation === undefined || observation === null) return false;
	// A failed query says nothing about any single row.
	if (observation.error !== undefined) return false;
	// `list()` reports no completeness, and an incomplete discovery is partial by
	// definition: a name missing from it may still be published.
	if (observation.complete !== true) return false;
	// A complete observation that knows nothing while the disk does hold skills is
	// answering a different question (another layer, another workspace).
	if (observation.count === 0 && rowCount > 0) return false;
	return true;
}

/**
 * Observe the catalog as one viewer sees it.
 * @param skills - the `skills` registry service.
 * @param options.scope - the viewing agent; omitted reads the global layer alone.
 * @param options.cwd - the viewing session's cwd, which selects project roots.
 * @param options.signal - cancellation for the discovery.
 * @returns summaries, their names, and whether the observation is trustworthy.
 */
export async function observeCatalog(skills, { scope, cwd, signal } = {}) {
	if (skills === undefined || skills === null) {
		return { summaries: [], names: new Set(), complete: undefined, count: 0, error: "no skills registry" };
	}
	const options = {};
	if (scope !== undefined) options.scope = scope;
	if (cwd !== undefined) options.cwd = cwd;
	if (signal !== undefined) options.signal = signal;
	try {
		const supportsSnapshot = typeof skills.snapshot === "function";
		const snapshot = supportsSnapshot ? await skills.snapshot(options) : undefined;
		const summaries = Array.isArray(snapshot?.skills) ? snapshot.skills : await skills.list(options);
		const list = Array.isArray(summaries) ? summaries : [];
		return {
			summaries: list,
			names: new Set(list.map((summary) => summary?.name).filter((name) => typeof name === "string")),
			complete: supportsSnapshot ? snapshot?.complete === true : undefined,
			count: list.length,
			error: undefined,
		};
	} catch (error) {
		// Cancellation is not a verdict about the catalog: let it propagate.
		if (signal?.aborted === true) throw error;
		return {
			summaries: [],
			names: new Set(),
			complete: undefined,
			count: 0,
			error: error?.message ?? String(error),
		};
	}
}

/**
 * Every skill any live agent can see, plus the global layer, deduplicated by name.
 * The page has no agent of its own, and the global layer alone is empty in a host
 * context — so a page that asked for it would never see a skill published from a
 * project or custom root.
 * @param ctx - the plugin context.
 * @returns catalog summaries for the deployment, newest view winning per name.
 */
export async function observeDeploymentCatalog(ctx) {
	const seen = new Map();
	const views = [await observeCatalog(ctx?.skills, {})];
	let agents;
	try {
		agents = ctx?.get?.("agents")?.list?.() ?? [];
	} catch {
		agents = [];
	}
	for (const agent of Array.isArray(agents) ? agents : []) {
		views.push(await observeCatalog(ctx?.skills, { scope: agent, cwd: agent?.session?.header?.cwd }));
	}
	for (const view of views) {
		for (const summary of view.summaries) {
			if (summary?.name === undefined || seen.has(summary.name)) continue;
			seen.set(summary.name, summary);
		}
	}
	return [...seen.values()];
}

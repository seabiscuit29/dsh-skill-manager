// Discovery for the manager's own views. This is deliberately independent of
// `ctx.remote.skills`: that catalog is filtered by invocation policy, so it can
// never show a disabled, model-only or untracked skill — exactly the rows a
// manager must manage.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { exists, isDirectory } from "./fsutil.js";
import { loadManifest } from "./manifest.js";
import { foreignRoots, hiddenZone, manifestPath, skillsRoot } from "./paths.js";
import { readSkillSummary } from "./validate.js";

/** Short human-readable label for a foreign root, e.g. ".agents/skills". */
function rootLabel(dir) {
	const parts = String(dir).split(/[\\/]/).filter(Boolean);
	return parts.slice(-2).join("/") || String(dir);
}

/** One on-disk skill container entry (a bundle directory or a flat `.md` file). */
export function listContainerEntries(dir) {
	if (!exists(dir) || !isDirectory(dir)) return [];
	const entries = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".")) continue; // ledger, lock, editor droppings
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (!exists(join(path, "SKILL.md"))) continue; // a directory without SKILL.md is not a skill
			entries.push({ diskName: entry.name, path, form: "bundle" });
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(".md")) {
			entries.push({ diskName: entry.name.replace(/\.md$/i, ""), path, form: "flat" });
		}
	}
	return entries.sort((left, right) => left.diskName.localeCompare(right.diskName));
}

/** Enablement of one skill as the filesystem reports it. */
function locate(name, diskName, root, zone) {
	const bundleLive = join(root, diskName);
	const flatLive = join(root, `${diskName}.md`);
	if (isDirectory(bundleLive) && exists(join(bundleLive, "SKILL.md"))) {
		return { state: "enabled", path: bundleLive, form: "bundle" };
	}
	if (exists(flatLive)) return { state: "enabled", path: flatLive, form: "flat" };

	const bundleZone = join(zone, diskName);
	const flatZone = join(zone, `${diskName}.md`);
	if (isDirectory(bundleZone) && exists(join(bundleZone, "SKILL.md"))) {
		return { state: "disabled", path: bundleZone, form: "bundle" };
	}
	if (exists(flatZone)) return { state: "disabled", path: flatZone, form: "flat" };
	return undefined;
}

/**
 * Build the management view: every skill the manager knows about, from the
 * ledger, the live root and the hidden zone, merged by frontmatter name.
 * @returns rows plus the resolved locations, sorted by name.
 */
export function buildRows({
	root = skillsRoot(),
	zone = hiddenZone(),
	manifest = loadManifest(),
	catalog,
	foreign = foreignRoots(),
} = {}) {
	const rows = new Map();

	const ensure = (name) => {
		if (!rows.has(name)) {
			rows.set(name, {
				name,
				diskName: name,
				form: "bundle",
				description: "",
				whenToUse: undefined,
				invocation: { modelInvocable: true, userInvocable: true },
				valid: true,
				state: "missing",
				tracked: false,
				// A row this manager owns (moves, enables, removes). Rows discovered
				// only through the catalog belong to another root and stay read-only.
				managed: true,
				providerSource: undefined,
				source: null,
				ref: null,
				path: undefined,
				installedAt: undefined,
				updatedAt: undefined,
				notes: [],
			});
		}
		return rows.get(name);
	};

	// 1. ledger entries seed the view (they know about skills that are elsewhere).
	for (const [name, entry] of Object.entries(manifest.skills ?? {})) {
		const row = ensure(name);
		row.tracked = true;
		row.diskName = entry.diskName ?? name;
		row.form = entry.form ?? row.form;
		row.source = entry.source ?? null;
		row.ref = entry.ref ?? null;
		row.installedAt = entry.installedAt;
		row.updatedAt = entry.updatedAt;
		row.state = entry.state === "disabled" ? "disabled" : "missing";
		if (typeof entry.description === "string" && entry.description !== "") row.description = entry.description;
	}

	// 2. the filesystem is the authority on where a skill actually is.
	for (const [state, dir] of [
		["enabled", root],
		["disabled", zone],
	]) {
		for (const item of listContainerEntries(dir)) {
			const summary = readSkillSummary(item.path);
			const row = ensure(summary.name);
			row.diskName = item.diskName;
			row.form = item.form;
			row.description = summary.description;
			row.whenToUse = summary.whenToUse;
			row.invocation = summary.invocation;
			row.valid = summary.valid;
			if (!summary.valid) row.notes.push("invalid frontmatter: the provider will not publish this skill");
			row.path = item.path;
			row.state = state;
		}
	}

	// 3. flag ledger entries whose files are nowhere to be found.
	for (const row of rows.values()) {
		if (row.state !== "missing") continue;
		const located = locate(row.name, row.diskName, root, zone);
		if (located === undefined) {
			row.notes.push("recorded in the manifest but not present on disk");
			continue;
		}
		row.state = located.state;
		row.form = located.form;
		row.path = located.path;
	}

	// 4. foreign roots, enumerated directly. The compatibility root `~/.agents/skills`
	// is scanned by the provider but not managed here, so its skills must still be
	// visible (with their migrate action). Enumerating the directory ourselves keeps
	// this correct even when the registry query fails or is unavailable.
	for (const dir of foreign ?? []) {
		for (const item of listContainerEntries(dir)) {
			const summary = readSkillSummary(item.path);
			if (rows.has(summary.name)) continue;
			const row = ensure(summary.name);
			row.managed = false;
			row.state = "enabled";
			row.diskName = item.diskName;
			row.form = item.form;
			row.description = summary.description;
			row.whenToUse = summary.whenToUse;
			row.invocation = summary.invocation;
			row.valid = summary.valid;
			row.providerSource = rootLabel(dir);
			row.path = item.path;
			if (!summary.valid) row.notes.push("invalid frontmatter: the provider will not publish this skill");
			row.notes.push(
				`published from ${rootLabel(dir)}; not managed here — migrate it into the managed root to disable or remove it`,
			);
		}
	}

	// 5. catalog-only rows: skills published from a root neither we nor the foreign
	// list knows about (a project root, a bundled set). Shown for parity with what
	// the model actually sees, and read-only for the same reason as above.
	for (const entry of catalog ?? []) {
		if (entry?.name === undefined || rows.has(entry.name)) continue;
		const row = ensure(entry.name);
		row.managed = false;
		row.state = "enabled";
		row.description = typeof entry.description === "string" ? entry.description : "";
		row.whenToUse = entry.whenToUse;
		if (entry.invocation !== undefined) row.invocation = entry.invocation;
		row.providerSource = entry.source;
		row.path =
			entry.resourceBase?.kind === "directory" ? entry.resourceBase.path : row.path;
		row.notes.push(
			`published from another root (${entry.source ?? "unknown"}); not managed here, so it cannot be disabled or removed from this page`,
		);
	}

	return {
		root,
		zone,
		manifestFile: manifestPath(),
		rows: [...rows.values()].sort((left, right) => left.name.localeCompare(right.name)),
	};
}

/** A compact doctor report: roots, ledger and bookkeeping facts. */
export function buildDoctor({ root = skillsRoot(), zone = hiddenZone(), catalog } = {}) {
	const live = listContainerEntries(root);
	const hidden = listContainerEntries(zone);
	let manifest;
	let manifestError;
	try {
		manifest = loadManifest();
	} catch (error) {
		manifestError = error.message;
	}
	const tracked = Object.keys(manifest?.skills ?? {});
	const view = manifestError === undefined ? buildRows({ root, zone, manifest, catalog }) : undefined;
	const untracked = (view?.rows ?? []).filter((row) => row.managed && !row.tracked).map((row) => row.name);
	const missing = (view?.rows ?? []).filter((row) => row.state === "missing").map((row) => row.name);
	const external = (view?.rows ?? []).filter((row) => !row.managed).map((row) => row.name);

	return {
		root,
		rootExists: exists(root),
		zone,
		zoneExists: exists(zone),
		liveCount: live.length,
		hiddenCount: hidden.length,
		manifestFile: manifestPath(),
		manifestError,
		trackedCount: tracked.length,
		untracked,
		missing,
		external,
	};
}

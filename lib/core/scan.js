// Discovery for the manager's own views. This is deliberately independent of
// `ctx.remote.skills`: that catalog is filtered by invocation policy, so it can
// never show a disabled, model-only or untracked skill — exactly the rows a
// manager must manage.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { exists, isDirectory, isFile } from "./fsutil.js";
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
		if (entry.isSymbolicLink()) {
			// A symlinked entry IS published. The provider lists children with `stat`
			// semantics — `dsh-fs-local` types a child by what the link points at
			// (`pathType` returns only file/directory/other; "symlink" comes from the
			// separate `lstat` method, which listing never calls) — so a link to a bundle
			// directory or to a `.md` file reaches the catalog like any real entry.
			// What is never published is a link whose target is gone or is not a skill:
			// `stat` fails or reports "other", and the provider skips it. Conflating the
			// two tells a user their working skill is invisible, which is worse than
			// saying nothing.
			const name = entry.name.replace(/\.md$/i, "");
			if (isDirectory(path) && exists(join(path, "SKILL.md"))) {
				entries.push({ diskName: entry.name, path, form: "bundle", symlink: true });
				continue;
			}
			if (isFile(path) && entry.name.endsWith(".md")) {
				entries.push({ diskName: name, path, form: "flat", symlink: true });
				continue;
			}
			entries.push({ diskName: name, path, form: "symlink", symlink: true, broken: true });
			continue;
		}
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
				// Set when the on-disk entry is a symbolic link. The provider follows
				// links (stat semantics), so a link is not by itself a defect; `broken`
				// records the one case that really is unpublished.
				symlink: false,
				brokenSymlink: false,
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
		// Real containers are processed before symbolic links, so a real skill always wins
		// the row when both resolve to the same frontmatter name (a link is the same skill
		// by another path); the symlink flag then only marks rows a link alone produced.
		const items = listContainerEntries(dir).sort(
			(left, right) => Number(left.symlink === true) - Number(right.symlink === true),
		);
		for (const item of items) {
			const summary = readSkillSummary(item.path);
			const row = ensure(summary.name);
			if (item.broken === true && row.path !== undefined && row.form !== "symlink") continue;
			row.diskName = item.diskName;
			row.form = item.form;
			row.description = summary.description;
			row.whenToUse = summary.whenToUse;
			row.invocation = summary.invocation;
			row.valid = summary.valid;
			if (!summary.valid) row.notes.push("invalid frontmatter: the provider will not publish this skill");
			if (item.symlink === true) {
				row.symlink = true;
				row.brokenSymlink = item.broken === true;
				row.notes.push(
					item.broken === true
						? "broken symbolic link: the target is gone or is not a skill, so the provider sees type \"other\" and never publishes this entry — replace it with a real copy (or migrate it from the other root)"
						: "symbolic link: the provider follows it with stat semantics and publishes the target normally; disabling or removing this row moves the link, not the target",
				);
			}
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
			if (item.symlink === true) {
				row.symlink = true;
				row.brokenSymlink = item.broken === true;
				row.notes.push(
					item.broken === true
						? "broken symbolic link: not published by the provider"
						: "symbolic link: followed by the provider like any real entry",
				);
			}
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
	const symlinked = (view?.rows ?? []).filter((row) => row.symlink === true && !row.brokenSymlink).map((row) => row.name);
	const brokenSymlinks = (view?.rows ?? []).filter((row) => row.brokenSymlink === true).map((row) => row.name);

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
		symlinked,
		brokenSymlinks,
	};
}

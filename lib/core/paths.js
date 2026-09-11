// Resolved local paths the manager works with. Every path is derived from the
// DSH home so a test seam (DSH_SKILL_MANAGER_* environment overrides) can point
// the whole manager at a scratch directory without touching the real skill root.
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Resolved DSH home: $DSH_HOME, else ~/.dsh (mirrors @deepseek-ai/dsh-home-paths). */
export function dshHome() {
	const env = process.env.DSH_HOME;
	return env && env.trim() !== "" ? env : join(homedir(), ".dsh");
}

/** The managed skill root (user-dsh, rank 400 by default). */
export function skillsRoot() {
	const env = process.env.DSH_SKILL_MANAGER_SKILLS_ROOT;
	return env && env.trim() !== "" ? env : join(dshHome(), "skills");
}

/** The manifest file recording sources, refs, hashes and disabled state. */
export function manifestPath() {
	const env = process.env.DSH_SKILL_MANAGER_MANIFEST_FILE;
	return env && env.trim() !== "" ? env : join(skillsRoot(), ".manifest.json");
}

/**
 * The hidden zone holding disabled skills. It lives OUTSIDE the skill root (a
 * sibling of it, hence on the same volume): the provider only discovers direct
 * children of a root, so anything moved here disappears from the catalog while
 * its files stay intact, and no `.disabled/SKILL.md` discovery trap exists.
 */
export function hiddenZone() {
	const env = process.env.DSH_SKILL_MANAGER_HIDDEN_DIR;
	return env && env.trim() !== "" ? env : join(dirname(skillsRoot()), ".skill-disabled");
}

/** Where removed and replaced skills are parked before any purge. */
export function backupsDir() {
	const env = process.env.DSH_SKILL_MANAGER_BACKUPS_DIR;
	return env && env.trim() !== "" ? env : join(dirname(skillsRoot()), ".skill-backups");
}

/** Machine-local mutation lock; sits beside the manifest so tests move with it. */
export function lockPath() {
	return join(dirname(manifestPath()), ".skill-manager.lock");
}

/** Staging area for fetches; never inside the skill root, so the watcher cannot see half-written skills. */
export function stagingRoot() {
	const env = process.env.DSH_SKILL_MANAGER_STAGING_DIR;
	return env && env.trim() !== "" ? env : join(process.env.TEMP ?? process.env.TMPDIR ?? "/tmp", "dsh-skill-manager");
}

/** Timestamp suffix shared by every backup directory name. */
export function stamp(date = new Date()) {
	const pad = (value) => String(value).padStart(2, "0");
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * Roots this manager does not own but can still read (and migrate from).
 *
 * The compatibility root `~/.agents/skills` is scanned by the provider at rank 500,
 * so skills living there are visible to the model yet cannot be disabled or removed
 * from here. The manager enumerates them itself instead of trusting a registry call:
 * that keeps the view correct even when the catalog query fails, and it is what
 * powers the page's read-only rows and their migrate action.
 */
export function foreignRoots() {
	const env = process.env.DSH_SKILL_MANAGER_FOREIGN_ROOTS;
	if (env !== undefined && env.trim() !== "") {
		return env
			.split(process.platform === "win32" ? ";" : ":")
			.map((entry) => entry.trim())
			.filter((entry) => entry !== "");
	}
	const agentsHome = process.env.DSH_AGENTS_HOME?.trim() || join(homedir(), ".agents");
	return [join(agentsHome, "skills")];
}

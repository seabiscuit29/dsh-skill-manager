// Migration: bring a skill published from ANOTHER local root into the managed root.
//
// Why this exists: a deployment can publish skills from several roots
// (`<project>/.dsh/skills`, `<project>/.agents/skills`, `~/.dsh/skills`,
// `~/.agents/skills`, …). The manager owns one of them (ADR-0002: `~/.dsh/skills`),
// so a skill living elsewhere is visible to the model but read-only here — it
// cannot be disabled or removed from this page. Migration moves such a skill into
// the managed root with a single same-volume rename, then records it in the ledger;
// nothing inside the skill is rewritten.
import { homedir } from "node:os";
import { join } from "node:path";
import { exists, hashSkillPath, isDirectory, renameWithRetry } from "./fsutil.js";
import { withLock } from "./lock.js";
import { loadManifest, manifestEntry, saveManifest } from "./manifest.js";
import { hiddenZone, skillsRoot } from "./paths.js";
import { listContainerEntries } from "./scan.js";
import { readSkillSummary, validateSkill } from "./validate.js";

/**
 * Roots this manager does not own but can still migrate from.
 * `$DSH_AGENTS_HOME/skills` (else `~/.agents/skills`) is the compatibility root the
 * provider still scans at rank 500; the env seam exists for tests.
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

/** Where a managed-root container for `name` would live. */
function managedTarget(form, name, root) {
	return form === "bundle" ? join(root, name) : join(root, `${name}.md`);
}

/**
 * Frontmatter names already present under the given directories — whatever the
 * on-disk entry name and form are. Comparing by path/form instead would miss a
 * flat `<name>.md` colliding with an incoming bundle `<name>/`, and a directory
 * whose name differs from its frontmatter name.
 */
function presentNames(dirs) {
	const names = new Set();
	for (const dir of dirs) {
		for (const item of listContainerEntries(dir)) names.add(readSkillSummary(item.path).name);
	}
	return names;
}

/**
 * List what could be migrated and what blocks it, without moving anything.
 * @returns `{ candidates: [{name, form, from, to, description}], blocked: [{name, reason}] }`
 */
export function scanMigratable({ root = skillsRoot(), zone = hiddenZone(), foreign = foreignRoots() } = {}) {
	const candidates = [];
	const blocked = [];
	const taken = presentNames([root, zone]);
	const claimed = new Set();
	for (const dir of foreign) {
		for (const item of listContainerEntries(dir)) {
			const identity = validateSkill(item.path);
			if (!identity.ok) {
				blocked.push({
					name: item.diskName,
					reason: `invalid frontmatter: ${identity.errors.map((error) => error.message).join("; ")}`,
					from: item.path,
				});
				continue;
			}
			if (taken.has(identity.name)) {
				blocked.push({
					name: identity.name,
					reason: "already present in the managed root (or in the hidden zone)",
					from: item.path,
				});
				claimed.add(identity.name);
				continue;
			}
			if (claimed.has(identity.name)) {
				blocked.push({
					name: identity.name,
					reason: "another root publishes the same skill name; migrate one of them explicitly",
					from: item.path,
				});
				continue;
			}
			claimed.add(identity.name);
			candidates.push({
				name: identity.name,
				form: identity.form,
				from: item.path,
				to: managedTarget(identity.form, identity.name, root),
				description: identity.description,
			});
		}
	}
	return { candidates, blocked };
}

/**
 * Move one skill from a foreign root into the managed root and adopt it.
 * @returns `{ ok, name, from, to, message }`
 */
export async function migrateSkill(name, options = {}) {
	const root = options.root ?? skillsRoot();
	const zone = options.zone ?? hiddenZone();
	const manifestFile = options.manifestFile;
	const foreign = options.foreign ?? foreignRoots();

	return withLock(async () => {
		const { candidates, blocked } = scanMigratable({ root, zone, foreign });
		const candidate = candidates.find((entry) => entry.name === name || entry.from.endsWith(name));
		if (candidate === undefined) {
			const reason = blocked.find((entry) => entry.name === name);
			throw new Error(
				reason === undefined
					? `no migratable skill named "${name}" was found in ${foreign.join(", ")}`
					: `"${name}" cannot be migrated: ${reason.reason}`,
			);
		}

		const identity = validateSkill(candidate.from);
		if (!identity.ok) {
			throw new Error(`"${name}" cannot be migrated: ${identity.errors.map((error) => error.message).join("; ")}`);
		}

		// Same-volume rename only: a cross-volume move would be a copy that can leave a
		// half-written skill behind, which is exactly what this project refuses to do.
		await renameWithRetry(candidate.from, candidate.to);

		const manifest = loadManifest(manifestFile);
		const entry = manifestEntry({
			name: identity.name,
			diskName: identity.name,
			form: identity.form,
			source: null,
			ref: null,
			description: identity.description,
		});
		entry.phase = "committed";
		entry.migratedFrom = candidate.from;
		entry.files = hashSkillPath(candidate.to).files;
		manifest.skills[identity.name] = entry;
		await saveManifest(manifest, manifestFile);

		return {
			ok: true,
			name: identity.name,
			from: candidate.from,
			to: candidate.to,
			message: `migrated "${identity.name}" into ${root} and recorded it in the ledger — manageable from the next turn`,
		};
	}, `migrate ${name}`);
}

/**
 * Migrate everything that can be migrated.
 * @returns `{ moved: [...], blocked: [...], candidates: number }`
 */
export async function migrateAll(options = {}) {
	const root = options.root ?? skillsRoot();
	const zone = options.zone ?? hiddenZone();
	const foreign = options.foreign ?? foreignRoots();
	const scan = scanMigratable({ root, zone, foreign });
	if (options.dryRun === true) {
		return { dryRun: true, moved: scan.candidates, blocked: scan.blocked, candidates: scan.candidates.length };
	}
	const moved = [];
	const blocked = [...scan.blocked];
	for (const candidate of scan.candidates) {
		try {
			moved.push(await migrateSkill(candidate.name, { ...options, root, zone, foreign }));
		} catch (error) {
			blocked.push({ name: candidate.name, reason: error.message, from: candidate.from });
		}
	}
	return { dryRun: false, moved, blocked, candidates: scan.candidates.length };
}

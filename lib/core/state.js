// Enablement: the manager's own primitive, because neither the skill registry
// nor the filesystem provider has an enable/disable concept.
//
// Disabling moves a skill into the hidden zone — a sibling of the skill root, so
// the provider (which only ever looks at a root's direct children) stops seeing
// it, the files stay intact and one rename brings it back. Nothing is rewritten,
// so a disabled skill's content stays byte-identical to what was installed.
import { join } from "node:path";
import { ensureDir, exists, hashSkillPath, isDirectory, renameWithRetry } from "./fsutil.js";
import { withLock } from "./lock.js";
import { loadManifest, manifestEntry, saveManifest } from "./manifest.js";
import { hiddenZone, skillsRoot } from "./paths.js";
import { validateSkill } from "./validate.js";

/** Where a skill's container currently lives, in the live root or the hidden zone. */
export function locateSkill(name, { root = skillsRoot(), zone = hiddenZone(), diskName } = {}) {
	const candidate = diskName ?? name;
	const forms = [
		{ form: "bundle", path: join(root, candidate), kind: "dir" },
		{ form: "flat", path: join(root, `${candidate}.md`), kind: "file" },
	];
	for (const candidateForm of forms) {
		if (candidateForm.kind === "dir" ? isDirectory(candidateForm.path) && exists(join(candidateForm.path, "SKILL.md")) : exists(candidateForm.path)) {
			return { state: "enabled", form: candidateForm.form, path: candidateForm.path, diskName: candidate };
		}
	}
	const zoned = [
		{ form: "bundle", path: join(zone, candidate), kind: "dir" },
		{ form: "flat", path: join(zone, `${candidate}.md`), kind: "file" },
	];
	for (const candidateForm of zoned) {
		if (candidateForm.kind === "dir" ? isDirectory(candidateForm.path) && exists(join(candidateForm.path, "SKILL.md")) : exists(candidateForm.path)) {
			return { state: "disabled", form: candidateForm.form, path: candidateForm.path, diskName: candidate };
		}
	}
	return undefined;
}

/** Find a ledger entry by frontmatter name or by on-disk name. */
function findEntry(manifest, name) {
	if (manifest.skills[name] !== undefined) return { key: name, entry: manifest.skills[name] };
	for (const [key, entry] of Object.entries(manifest.skills)) {
		if (entry?.diskName === name) return { key, entry };
	}
	return undefined;
}

/**
 * Disable or enable one skill. Idempotent: re-disabling an already disabled
 * skill, or enabling an already enabled one, reports success without moving
 * anything.
 * @returns `{ ok, changed, name, state, from, to, message }`
 */
export async function setSkillEnabled(name, enabled, options = {}) {
	const root = options.root ?? skillsRoot();
	const zone = options.zone ?? hiddenZone();
	const manifestFile = options.manifestFile;

	return withLock(async () => {
		const manifest = loadManifest(manifestFile);
		const found = findEntry(manifest, name);
		const current = locateSkill(name, { root, zone, diskName: found?.entry?.diskName });
		if (current === undefined) {
			throw new Error(
				found === undefined
					? `no skill named "${name}" is installed`
					: `"${name}" is recorded in the manifest but its files are missing on disk`,
			);
		}

		const targetState = enabled ? "enabled" : "disabled";
		if (current.state === targetState) {
			return {
				ok: true,
				changed: false,
				name,
				state: current.state,
				message: `"${name}" is already ${targetState}`,
			};
		}

		// Identity comes from the frontmatter, so a skill that cannot be parsed
		// cannot be recorded — deleting it is the honest alternative.
		const identity = validateSkill(current.path);
		if (!identity.ok) {
			throw new Error(
				`"${name}" cannot be ${enabled ? "enabled" : "disabled"}: ${identity.errors.map((error) => error.message).join("; ")}`,
			);
		}

		const fileName = current.form === "bundle" ? current.diskName : `${current.diskName}.md`;
		const zoneDir = enabled ? root : zone;
		const from = current.path;
		const to = join(zoneDir, fileName);
		if (exists(to)) {
			throw new Error(`the ${enabled ? "skill root" : "hidden zone"} already contains ${to}`);
		}

		const existing = found?.entry;
		const entry = existing ?? manifestEntry({ name: identity.name, diskName: current.diskName, form: current.form });
		entry.name = identity.name;
		entry.diskName = current.diskName;
		entry.form = current.form;
		entry.description = identity.description;
		entry.state = enabled ? "enabled" : "disabled";
		entry.phase = "moving";
		entry.updatedAt = new Date().toISOString();
		manifest.skills[entry.name] = entry;
		if (found !== undefined && found.key !== entry.name) delete manifest.skills[found.key];
		await saveManifest(manifest, manifestFile);

		ensureDir(zoneDir);
		await renameWithRetry(from, to);

		entry.state = enabled ? "enabled" : "disabled";
		entry.phase = "committed";
		entry.updatedAt = new Date().toISOString();
		entry.files = hashSkillPath(to).files;
		if (enabled) {
			entry.disabled = undefined;
		} else {
			entry.disabled = { at: entry.updatedAt, zone: "sibling", from, to };
		}
		await saveManifest(manifest, manifestFile);

		return {
			ok: true,
			changed: true,
			name: identity.name,
			state: entry.state,
			from,
			to,
			message: enabled
				? `enabled "${identity.name}" — visible again from the next turn`
				: `disabled "${identity.name}" — it stays on disk, hidden from the catalog, from the next turn`,
		};
	}, enabled ? `enable ${name}` : `disable ${name}`);
}

/**
 * Record an already-installed skill in the ledger (no file movement).
 * Untracked skills are the common case after a manual install or a migration.
 */
export async function adoptSkill(name, options = {}) {
	const root = options.root ?? skillsRoot();
	const zone = options.zone ?? hiddenZone();
	const manifestFile = options.manifestFile;
	const source = options.source ?? null;

	return withLock(async () => {
		const manifest = loadManifest(manifestFile);
		const current = locateSkill(name, { root, zone });
		if (current === undefined) throw new Error(`no skill named "${name}" is installed in ${root}`);

		const identity = validateSkill(current.path);
		if (!identity.ok) {
			throw new Error(`"${name}" cannot be adopted: ${identity.errors.map((error) => error.message).join("; ")}`);
		}

		const entry = manifestEntry({
			name: identity.name,
			diskName: current.diskName,
			form: current.form,
			source,
			ref: null,
			description: identity.description,
		});
		entry.state = current.state;
		entry.phase = "committed";
		entry.files = hashSkillPath(current.path).files;
		manifest.skills[identity.name] = entry;
		await saveManifest(manifest, manifestFile);

		return {
			ok: true,
			name: identity.name,
			source,
			state: current.state,
			message: `adopted "${identity.name}"${source === null ? " with source recorded as local" : ` from ${source}`}`,
		};
	}, `adopt ${name}`);
}

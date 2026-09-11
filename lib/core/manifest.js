// The manifest is the manager's ledger: where each skill came from, which commit,
// which files, and whether it is currently disabled. It is NOT part of skill
// discovery — `.manifest.json` is neither `<name>/SKILL.md` nor `<name>.md`, so
// the provider never sees it and writing it triggers no catalog churn.
import { readText, writeFileAtomic } from "./fsutil.js";
import { manifestPath } from "./paths.js";

/** Manifest schema version; bump only with a migration. */
export const MANIFEST_VERSION = 1;

/** A fresh, empty ledger. */
export function emptyManifest(root = "user") {
	return { version: MANIFEST_VERSION, root, skills: {} };
}

/**
 * Load the ledger.
 * A missing file is a valid empty state; malformed content throws, because
 * silently starting over would orphan every recorded skill.
 */
export function loadManifest(file = manifestPath()) {
	const text = readText(file);
	if (text === undefined) return emptyManifest();
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`manifest is not valid JSON (${file}): ${error.message}`);
	}
	if (parsed === null || typeof parsed !== "object" || parsed.skills === null || typeof parsed.skills !== "object") {
		throw new Error(`manifest has an unexpected shape (${file}); expected { version, root, skills }`);
	}
	return {
		version: typeof parsed.version === "number" ? parsed.version : MANIFEST_VERSION,
		root: typeof parsed.root === "string" ? parsed.root : "user",
		skills: parsed.skills,
	};
}

/** Persist the ledger atomically (temp file + rename in the same directory). */
export async function saveManifest(manifest, file = manifestPath()) {
	const next = {
		version: MANIFEST_VERSION,
		root: typeof manifest.root === "string" ? manifest.root : "user",
		skills: manifest.skills ?? {},
	};
	await writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
}

/**
 * Build one ledger entry.
 * `diskName` is recorded alongside `name` because the provider never compares
 * the on-disk entry name with the frontmatter name, so the two can differ and
 * the manager must know which directory a skill actually occupies.
 */
export function manifestEntry({
	name,
	diskName,
	form,
	source = null,
	ref = null,
	files = {},
	description = "",
	now = new Date().toISOString(),
}) {
	return {
		name,
		diskName: diskName ?? name,
		form,
		source,
		ref,
		files,
		description,
		state: "enabled",
		installedAt: now,
		updatedAt: now,
	};
}

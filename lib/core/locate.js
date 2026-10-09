// Finding a skill's container on disk — one implementation, because the case rules it
// encodes are the same question everywhere it is asked and getting them wrong is silent.
//
// Why a directory listing decides, and not a joined path:
//
//   * macOS/APFS is case-INSENSITIVE but case-PRESERVING: `foo.md` and `foo.MD` are the
//     same file, so `exists("foo.md")` is true for an on-disk `foo.MD` — and a caller that
//     then records or renames `foo.md` names a path the disk does not have.
//   * Linux is case-SENSITIVE: `foo.md` and `foo.MD` are two different files, so only a
//     listing can say which one exists — `exists("foo.md")` is plainly false.
//   * Windows/NTFS behaves like APFS, and is corrected by the same code path.
//
// A name-guessing probe is therefore wrong on both kinds of filesystem, in opposite
// directions. Listing the directory is the only answer that holds on all three.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { exists } from "./fsutil.js";

/**
 * A skill container inside one directory: a bundle directory holding `SKILL.md`, or a flat
 * `.md` file. `diskName` is the spelling the DIRECTORY uses, which is what must be recorded
 * and later renamed — never the spelling the caller asked for.
 * @typedef {{ form: "bundle" | "flat", path: string, diskName: string }} Container
 */

/**
 * Find a container among already-listed directory entries.
 * @param dir - the directory the entries came from.
 * @param entries - its entry names, as `readdirSync` reported them.
 * @param name - the skill name to look for, in any case and with or without `.md`.
 * @returns the container, or undefined when this directory holds neither form.
 */
export function findContainerIn(dir, entries, name) {
	const folded = name.toLowerCase();

	// A bundle wins over a flat file of the same name: the provider publishes both, and the
	// directory form is the one that can carry supporting files.
	const exact = entries.includes(name) ? name : entries.find((entry) => entry.toLowerCase() === folded);
	if (exact !== undefined) {
		const path = join(dir, exact);
		let isDir = false;
		try {
			isDir = statSync(path).isDirectory();
		} catch {
			isDir = false;
		}
		// A directory without SKILL.md is not a skill; fall through instead of claiming a
		// path the provider would refuse to publish.
		if (isDir && exists(join(path, "SKILL.md"))) return { form: "bundle", path, diskName: exact };
	}

	const flat = entries.find((entry) => entry.toLowerCase() === `${folded}.md`);
	if (flat === undefined) return undefined;
	const path = join(dir, flat);
	if (!exists(path)) return undefined;
	return { form: "flat", path, diskName: flat.replace(/\.md$/i, "") };
}

/**
 * Find a skill container in one directory.
 * @returns the container, or undefined when the directory is missing or holds neither form.
 */
export function findContainer(dir, name) {
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return undefined;
	}
	return findContainerIn(dir, entries, name);
}

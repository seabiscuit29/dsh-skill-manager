// Filesystem primitives: atomic writes, Windows-tolerant renames, hashing and
// small directory helpers. Self-contained on purpose — this plugin imports no
// @deepseek-ai package, so it cannot drift with their internal APIs.
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";

/** Windows error codes that mean "someone holds the handle right now", not "impossible". */
const TRANSIENT = new Set(["EACCES", "EBUSY", "EPERM"]);

/** Sleep helper for the retry loops below. */
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether a path exists (no throw). */
export function exists(path) {
	try {
		return existsSync(path);
	} catch {
		return false;
	}
}

/** Whether a path is a directory. */
export function isDirectory(path) {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** Whether a path is a regular file. */
export function isFile(path) {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/** Read UTF-8 text, or undefined when the file is missing. */
export function readText(path) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

/** Ensure a directory exists. */
export function ensureDir(path) {
	mkdirSync(path, { recursive: true });
}

/**
 * Read a file as UTF-8 and report whether the bytes really were UTF-8.
 * A lossy decode is detected by re-encoding and comparing byte-for-byte.
 * @returns text plus a validity flag, or undefined when the file cannot be read.
 */
export function readUtf8Checked(path) {
	let buffer;
	try {
		buffer = readFileSync(path);
	} catch {
		return undefined;
	}
	const text = buffer.toString("utf8");
	return { text, valid: Buffer.from(text, "utf8").equals(buffer) };
}

/**
 * Write a file atomically: same-directory temp file, then rename over the goal.
 * Retries the rename on Windows transient errors.
 */
export async function writeFileAtomic(path, text) {
	ensureDir(dirname(path));
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, text, "utf8");
	await renameWithRetry(tmp, path);
}

/**
 * Rename with the retry policy DSH itself uses for atomic writes: 20 ms doubling
 * to 200 ms, eight attempts, only for transient Windows codes.
 * A cross-volume rename is refused instead of silently degrading to copy+delete,
 * because a half-finished copy inside the skill root is worse than a clear error.
 */
export async function renameWithRetry(from, to, attempts = 8) {
	let delay = 20;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			renameSync(from, to);
			return;
		} catch (error) {
			if (error?.code === "EXDEV") {
				throw new Error(
					`cross-volume move refused (${from} -> ${to}); keep the hidden zone and the skill root on one volume`,
				);
			}
			if (!TRANSIENT.has(error?.code) || attempt === attempts) throw error;
			await sleep(delay);
			delay = Math.min(delay * 2, 200);
		}
	}
}

/** Copy a directory tree. */
export function copyTree(from, to) {
	ensureDir(dirname(to));
	cpSync(from, to, { recursive: true });
}

/** Remove a file or directory tree, ignoring absence. */
export function removePath(path) {
	rmSync(path, { recursive: true, force: true });
}

/** sha256 of one file, as `sha256:<hex>`. */
export function hashFile(path) {
	return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

/** Files never worth hashing or counting as part of a skill. */
const IGNORED = new Set([".git", ".DS_Store", "Thumbs.db", "node_modules"]);
/** Oversized members are skipped rather than hashed (a skill bundle is tiny). */
const MAX_HASH_BYTES = 8 * 1024 * 1024;

/**
 * Hash every file under a skill directory into a `relative/path -> sha256:…` map.
 * `skipped` lists members that were too large to hash.
 */
export function hashTree(root) {
	const files = {};
	const skipped = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (IGNORED.has(entry.name)) continue;
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(path);
				continue;
			}
			if (!entry.isFile()) continue;
			const key = relative(root, path).split(sep).join("/");
			try {
				if (statSync(path).size > MAX_HASH_BYTES) {
					skipped.push(key);
					continue;
				}
				files[key] = hashFile(path);
			} catch {
				skipped.push(key);
			}
		}
	};
	walk(root);
	return { files, skipped };
}

/**
 * Hash a skill container the way the manifest records it: a directory hashes
 * its tree, a flat `.md` skill hashes that single file under its own name.
 */
export function hashSkillPath(path) {
	if (isDirectory(path)) return hashTree(path);
	return { files: { [path.replace(/^.*[\\/]/, "")]: hashFile(path) }, skipped: [] };
}

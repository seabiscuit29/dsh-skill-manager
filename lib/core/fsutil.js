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
	readlinkSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";

/**
 * Error codes that mean "someone holds this path right now", not "impossible".
 *
 * The first three are the Windows shapes (`EACCES`/`EBUSY`/`EPERM`). The rest are the
 * macOS ones: a Finder-locked file (`chflags uchg`), a `chmod 500` parent, or Spotlight
 * and iCloud/FileProvider holding a directory open make `rmSync` fail with `ENOTEMPTY`
 * or `ENOTSUP`, and `force: true` does NOT suppress `ENOTEMPTY` — it only suppresses
 * `ENOENT`. Retrying is what turns those into a brief wait instead of a hard failure.
 */
const TRANSIENT = new Set(["EACCES", "EBUSY", "EPERM", "ENOTEMPTY", "ENOTSUP"]);

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
 *
 * Only a MISSING file reports undefined. Any other read failure (EACCES on a backup
 * restored with the wrong owner, EPERM on a Finder-locked file, an iCloud-evicted
 * placeholder) is rethrown: callers treat `undefined` as "there is nothing here", and
 * for the ledger that means "start over with an empty manifest" — silently forgetting
 * every tracked skill because a file could not be read.
 * @returns text plus a validity flag, or undefined when the file does not exist.
 */
export function readUtf8Checked(path) {
	let buffer;
	try {
		buffer = readFileSync(path);
	} catch (error) {
		if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return undefined;
		throw error;
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
 * to 200 ms, eight attempts, only for transient codes.
 * A cross-volume rename is refused instead of silently degrading to copy+delete,
 * because a half-finished copy inside the skill root is worse than a clear error.
 * The refusal keeps its `EXDEV` code so callers can branch on the code and never
 * have to match on this message.
 */
export async function renameWithRetry(from, to, attempts = 8) {
	let delay = 20;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			renameSync(from, to);
			return;
		} catch (error) {
			if (error?.code === "EXDEV") {
				const refused = new Error(
					`cross-volume move refused (${from} -> ${to}); keep the hidden zone and the skill root on one volume`,
				);
				refused.code = "EXDEV";
				throw refused;
			}
			if (!TRANSIENT.has(error?.code) || attempt === attempts) throw error;
			await sleep(delay);
			delay = Math.min(delay * 2, 200);
		}
	}
}

/**
 * Copy a directory tree.
 *
 * `verbatimSymlinks` is load-bearing, not a detail. Without it `cpSync` REWRITES every
 * relative symlink into an absolute one pointing at the copy's source. A staged skill is
 * copied out of `os.tmpdir()` and the staging directory is deleted right afterwards, so
 * each rewritten link then dangles at a `/var/folders/...` path that no longer exists —
 * the provider stops publishing it and the install still reports success. Relative links
 * inside a skill (a shared fixture, a dev checkout) are normal on macOS and Linux.
 * `preserveTimestamps` keeps mtimes meaningful for the copy.
 */
export function copyTree(from, to) {
	ensureDir(dirname(to));
	cpSync(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
}

/** Remove a file or directory tree, ignoring absence. */
export function removePath(path) {
	rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

/** sha256 of one file, as `sha256:<hex>`. */
export function hashFile(path) {
	return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

/**
 * Files never worth hashing or counting as part of a skill.
 * Compared case-insensitively: APFS is case-insensitive but case-preserving, and Finder,
 * a Windows-authored checkout or an unzip all happily produce `.ds_store` / `NODE_MODULES`.
 */
const IGNORED = new Set([".git", ".ds_store", "thumbs.db", "node_modules"]);
/** Oversized members are skipped rather than hashed (a skill bundle is tiny). */
const MAX_HASH_BYTES = 8 * 1024 * 1024;

/**
 * Hash every file under a skill directory into a `relative/path -> digest` map.
 * A symbolic link is recorded as `symlink:<target>` instead of being dropped: it is part
 * of the skill's content, so a deleted or re-pointed link must make `verify` report a
 * difference. Directory links are recorded and NOT followed, which also removes the risk
 * of walking a link that points outside the skill (or back into it).
 * `skipped` lists members that were too large to hash.
 */
export function hashTree(root) {
	const files = {};
	const skipped = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (IGNORED.has(entry.name.toLowerCase())) continue;
			const path = join(dir, entry.name);
			const key = relative(root, path).split(sep).join("/");
			if (entry.isSymbolicLink()) {
				try {
					files[key] = `symlink:${readlinkSync(path)}`;
				} catch {
					skipped.push(key);
				}
				continue;
			}
			if (entry.isDirectory()) {
				walk(path);
				continue;
			}
			if (!entry.isFile()) continue;
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

// Install, remove and verify. One implementation serves both entries — the
// /skill command and the Settings - Skills page — so the two can never disagree.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
	copyTree,
	ensureDir,
	exists,
	hashSkillPath,
	isDirectory,
	removePath,
	renameWithRetry,
} from "./fsutil.js";
import { withLock } from "./lock.js";
import { loadManifest, manifestEntry, saveManifest } from "./manifest.js";
import { backupsDir, hiddenZone, skillsRoot, stamp, stagingRoot } from "./paths.js";
import { describeSource, parseSourceSpec } from "./source.js";
import { locateSkill } from "./state.js";
import { validateSkill } from "./validate.js";

/** Fetch budget; a shallow clone of a skills repo finishes far inside this. */
const FETCH_TIMEOUT_MS = 60_000;

/** Run git without ever letting it block on an interactive credential prompt. */
function git(args, options = {}) {
	return execFileSync("git", args, {
		encoding: "utf8",
		timeout: FETCH_TIMEOUT_MS,
		env: {
			...process.env,
			GIT_TERMINAL_PROMPT: "0",
			GIT_ASKPASS: "",
			GCM_INTERACTIVE: "never",
		},
		stdio: ["ignore", "pipe", "pipe"],
		...options,
	});
}

/** Turn a git failure into something a user can act on. */
function friendlyGitError(error, spec) {
	const stderr = `${error?.stderr ?? ""}${error?.message ?? ""}`;
	const lastLine = stderr.trim().split("\n").filter(Boolean).slice(-1)[0] ?? "";
	if (/could not read Username|Authentication failed|terminal prompts disabled|Permission denied/i.test(stderr)) {
		return `git needs credentials for ${spec.url}; configure a credential helper (interactive prompts are disabled inside the host)`;
	}
	if (/Remote branch .* not found|couldn't find remote ref|not our ref/i.test(stderr)) {
		return `ref "${spec.ref}" does not exist in ${spec.url}`;
	}
	if (/not found|404|403/i.test(stderr)) {
		return `cannot read ${spec.url} (missing, or private without credentials): ${lastLine}`;
	}
	if (error?.code === "ENOENT") return "git is not available on PATH";
	if (error?.code === "ETIMEDOUT" || /timed out/i.test(stderr)) {
		return `git timed out after ${FETCH_TIMEOUT_MS / 1000}s (network or proxy problem)`;
	}
	return `git failed: ${lastLine || error?.message}`;
}

/**
 * Fetch a source into the staging directory (never inside the skill root, so a
 * half-written skill can never be discovered).
 * @returns `{ payload, ref }` — the staged skill container and its commit.
 */
function fetchToStaging(spec, staging) {
	if (spec.kind === "local") {
		const payload = join(staging, "payload");
		if (isDirectory(spec.localPath)) {
			copyTree(spec.localPath, payload);
		} else {
			ensureDir(payload);
			copyTree(spec.localPath, join(payload, spec.localPath.replace(/^.*[\\/]/, "")));
		}
		return { payload, ref: null };
	}

	const clone = join(staging, "clone");
	ensureDir(clone);
	try {
		git(["clone", "--depth", "1", "--branch", spec.ref, spec.url, clone]);
	} catch (error) {
		throw new Error(friendlyGitError(error, spec));
	}
	let ref = null;
	try {
		ref = git(["-C", clone, "rev-parse", "HEAD"]).trim();
	} catch {
		ref = null;
	}
	const payload = spec.path === undefined ? clone : join(clone, spec.path);
	if (!exists(payload)) {
		throw new Error(`path "${spec.path}" does not exist in ${spec.url}@${spec.ref}`);
	}
	return { payload, ref };
}

/** Move a staged container into place, degrading to copy+delete across volumes. */
async function placeInto(from, to) {
	try {
		await renameWithRetry(from, to);
		return;
	} catch (error) {
		if (error?.code !== "EXDEV" && !/cross-volume/.test(String(error?.message))) throw error;
	}
	copyTree(from, to);
	removePath(from);
}

/** Shallow equality for two `{ rel: sha256 }` maps. */
function sameFiles(left, right) {
	if (left === undefined || right === undefined) return false;
	const leftKeys = Object.keys(left);
	if (leftKeys.length !== Object.keys(right).length) return false;
	return leftKeys.every((key) => left[key] === right[key]);
}

/** Resolve a ledger entry by frontmatter name or on-disk name. */
function findEntry(manifest, name) {
	if (manifest.skills[name] !== undefined) return { key: name, entry: manifest.skills[name] };
	for (const [key, entry] of Object.entries(manifest.skills)) {
		if (entry?.diskName === name) return { key, entry };
	}
	return undefined;
}

/**
 * Install (or reinstall) one skill from a source spec.
 * Ordering is deliberate: fetch and validate happen before anything in the root
 * is touched, and an existing version is only moved once the new one is known good.
 */
export async function installSkill(rawSpec, options = {}) {
	const force = options.force === true;
	const root = options.root ?? skillsRoot();
	const zone = options.zone ?? hiddenZone();
	const manifestFile = options.manifestFile;

	const parsed = parseSourceSpec(rawSpec);
	if (!parsed.ok) throw new Error(parsed.error);
	const spec = parsed.spec;

	return withLock(async () => {
		const staging = join(stagingRoot(), `stage-${process.pid}-${Date.now()}`);
		ensureDir(staging);
		try {
			const { payload, ref } = fetchToStaging(spec, staging);
			const identity = validateSkill(payload);
			if (!identity.ok) {
				throw new Error(
					`refused to install: ${identity.errors.map((error) => `${error.rule}: ${error.message}`).join("; ")}`,
				);
			}

			const manifest = loadManifest(manifestFile);
			const entryFound = findEntry(manifest, identity.name);
			const existing =
				locateSkill(identity.name, { root, zone, diskName: entryFound?.entry?.diskName }) ??
				locateSkill(identity.diskName, { root, zone });

			const source = describeSource(spec);
			if (existing !== undefined) {
				const recorded = entryFound?.entry;
				const sameSource = recorded?.source === source && (spec.kind === "local" || recorded?.ref === ref);
				const files = hashSkillPath(existing.path).files;
				if (sameSource && sameFiles(recorded?.files, files)) {
					return {
						ok: true,
						skipped: true,
						name: identity.name,
						ref,
						message: `"${identity.name}" is already installed from the same source (${ref ?? "local"})`,
					};
				}
				if (!force) {
					const origin =
						recorded === undefined
							? "not tracked by the manifest"
							: `source ${recorded.source ?? "local"}${recorded.ref === null || recorded.ref === undefined ? "" : ` @ ${String(recorded.ref).slice(0, 12)}`}`;
					throw new Error(
						`"${identity.name}" is already installed (${origin}); pass --force to replace it (the old copy is kept in the backup area)`,
					);
				}
				await moveToBackups(existing.path, existing.diskName);
			}

			const target = identity.form === "bundle" ? join(root, identity.name) : join(root, `${identity.name}.md`);
			ensureDir(root);
			await placeInto(payload, target);

			const entry = manifestEntry({
				name: identity.name,
				diskName: identity.name,
				form: identity.form,
				source,
				ref,
				description: identity.description,
			});
			entry.files = hashSkillPath(target).files;
			entry.phase = "committed";
			manifest.skills[identity.name] = entry;
			if (entryFound !== undefined && entryFound.key !== identity.name) delete manifest.skills[entryFound.key];
			await saveManifest(manifest, manifestFile);

			return {
				ok: true,
				skipped: false,
				name: identity.name,
				form: identity.form,
				ref,
				source,
				path: target,
				message: `installed "${identity.name}"${ref === null ? "" : ` @ ${ref.slice(0, 12)}`} — visible from the next turn`,
			};
		} finally {
			removePath(staging);
		}
	}, "install");
}

/** Park a container in the backup area and return where it went. */
async function moveToBackups(path, diskName) {
	const dir = backupsDir();
	ensureDir(dir);
	const suffix = path.endsWith(".md") ? ".md" : "";
	const target = join(dir, `${diskName}-${stamp()}${suffix}`);
	await renameWithRetry(path, target);
	return target;
}

/**
 * Remove one skill: the container moves to the backup area (recoverable) and the
 * ledger entry goes away. `purge` also deletes this skill's earlier backups.
 */
export async function removeSkill(name, options = {}) {
	const purge = options.purge === true;
	const force = options.force === true;
	const root = options.root ?? skillsRoot();
	const zone = options.zone ?? hiddenZone();
	const manifestFile = options.manifestFile;

	return withLock(async () => {
		const manifest = loadManifest(manifestFile);
		const found = findEntry(manifest, name);
		const existing = locateSkill(name, { root, zone, diskName: found?.entry?.diskName });
		if (existing === undefined) {
			throw new Error(`no skill named "${name}" is installed (already removed?)`);
		}
		if (found === undefined && !force) {
			throw new Error(`"${name}" is not tracked by the manifest; pass --force to remove it anyway`);
		}

		const backupPath = await moveToBackups(existing.path, existing.diskName);
		if (found !== undefined) {
			delete manifest.skills[found.key];
			await saveManifest(manifest, manifestFile);
		}

		let purged = 0;
		if (purge) {
			const dir = backupsDir();
			const { readdirSync } = await import("node:fs");
			if (exists(dir)) {
				for (const item of readdirSync(dir)) {
					if (item.startsWith(`${existing.diskName}-`)) {
						removePath(join(dir, item));
						purged += 1;
					}
				}
			}
			removePath(backupPath);
		}

		return {
			ok: true,
			name,
			state: existing.state,
			backupPath,
			purged,
			message: purge
				? `removed "${name}" and purged ${purged} backup(s)`
				: `removed "${name}" — a copy is kept at ${backupPath}`,
		};
	}, `remove ${name}`);
}

/**
 * Compare a skill's files against the ledger. Local only: the manager never
 * needs the network to answer "are these files still what was installed".
 */
export function verifySkill(name, options = {}) {
	const root = options.root ?? skillsRoot();
	const zone = options.zone ?? hiddenZone();
	const manifest = loadManifest(options.manifestFile);
	const found = findEntry(manifest, name);
	if (found === undefined) {
		return { ok: false, name, error: `"${name}" is not tracked by the manifest; run /skill adopt first` };
	}
	const existing = locateSkill(name, { root, zone, diskName: found.entry.diskName });
	if (existing === undefined) {
		return { ok: false, name, error: `"${name}" is recorded in the manifest but its files are missing on disk` };
	}
	const current = hashSkillPath(existing.path).files;
	const recorded = found.entry.files ?? {};
	const modified = Object.keys(recorded).filter((key) => current[key] !== undefined && current[key] !== recorded[key]);
	const missing = Object.keys(recorded).filter((key) => current[key] === undefined);
	const extra = Object.keys(current).filter((key) => recorded[key] === undefined);
	return {
		ok: true,
		name: found.entry.name,
		state: existing.state,
		path: existing.path,
		clean: modified.length === 0 && missing.length === 0,
		modified,
		missing,
		extra,
	};
}

// Which dsh is this plugin actually running on — and was that runtime verified?
//
// dsh 0.2.0 refuses to mount a bundle whose `@deepseek-ai/dsh*` peer ranges reject the
// runtime, and it does so silently: no entry is appended, so nothing the plugin logs can
// report it. Two ways out exist. Narrow ranges make the plugin disappear at every dsh
// minor bump (that is how 0.1.6 vanished on 0.2.0-rc.2). Wide ranges keep it loading, at
// the price of running untested code against a changed runtime.
//
// This module buys both: the declared range covers the whole 0.x line, and the plugin
// says out loud which runtime it found. An unverified runtime is then *visible* in
// `doctor`, in `/skill list`, and on the page — instead of silent in either direction.
//
// Discovery is dependency-free on purpose (this plugin imports no @deepseek-ai package):
// the running code lives inside the installation that owns it, so the CLI entry point
// points at the package whose version is the runtime version.
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dshHome } from "./paths.js";

/**
 * dsh release lines this plugin has been verified against. Entries are release lines, not
 * exact builds: everything sharing their `major.minor` counts as verified, because that is
 * the contract surface a plugin can actually be tested against.
 */
export const VERIFIED_RUNTIMES = ["0.1.5-rc.1", "0.2.0-rc.2"];

/** `major.minor` of a version string, which is what a verification covers. */
function releaseLine(version) {
	return String(version).split("-")[0].split(".").slice(0, 2).join(".");
}

/**
 * Whether one runtime is covered by the verified set.
 * @param version - the running dsh version, or undefined when undiscovered.
 * @param verified - the verified release lines.
 * @returns `true`/`false`, or `undefined` when the runtime is unknown.
 */
export function isVerifiedRuntime(version, verified = VERIFIED_RUNTIMES) {
	if (typeof version !== "string" || version.trim() === "") return undefined;
	return verified.some((entry) => releaseLine(entry) === releaseLine(version));
}

/**
 * Walk up from a filesystem location looking for the dsh package that owns it.
 *
 * Two shapes are searched at every level: the plain `node_modules/@deepseek-ai/dsh` of an
 * npm/npx install, and `node_modules/<version>/node_modules/@deepseek-ai/dsh`, which is how
 * pnpm nests a store — the running packages are then one level deeper than npm would put
 * them, so a walk that only knows the first shape reports "unknown runtime" on every macOS
 * pnpm install.
 *
 * A packaged desktop build keeps dsh inside an `app.asar` archive, which `existsSync` cannot
 * see and which this plugin therefore never claims to have identified (reporting a version
 * it cannot read would be worse than reporting none). Preflight covers that case.
 * @param start - a file or directory inside the installation.
 * @returns the absolute `…/@deepseek-ai/dsh/package.json`, or undefined.
 */
export function findDshPackage(start) {
	if (typeof start !== "string" || start.trim() === "") return undefined;
	let current = start;
	// A file points at its directory; a directory is used as is.
	if (/\.[cm]?js$|\.json$/.test(current)) current = dirname(current);
	for (let depth = 0; depth < 12; depth++) {
		const modules = join(current, "node_modules");
		const direct = join(modules, "@deepseek-ai", "dsh", "package.json");
		if (existsSync(direct)) return direct;
		let store = [];
		try {
			store = readdirSync(modules, { withFileTypes: true });
		} catch {
			store = [];
		}
		for (const entry of store) {
			if (!entry.isDirectory()) continue;
			const nested = join(modules, entry.name, "node_modules", "@deepseek-ai", "dsh", "package.json");
			if (existsSync(nested)) return nested;
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return undefined;
}

/** Read the version out of a located dsh package.json, tolerating any read/shape failure. */
function versionOf(packageFile) {
	try {
		const parsed = JSON.parse(readFileSync(packageFile, "utf8"));
		return typeof parsed?.version === "string" && parsed.version !== "" ? parsed.version : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Whether a located dsh copy is the LEGACY profile-shared install
 * (`~/.dsh/profiles/node_modules/@deepseek-ai/dsh`).
 *
 * That directory is the pre-0.2 layout: every package in it is a symbolic link into
 * whichever npx cache happened to create it, so it keeps resolving long after the
 * runtime has moved on. It is the one layout that must never be mistaken for the
 * running runtime — a real installation holds real directories.
 */
function isLegacySharedInstall(packageFile) {
	try {
		// A pnpm-nested copy sits two levels deeper than the scope directory.
		const scope = packageFile.includes(`${join("node_modules", "node_modules")}`)
			? dirname(dirname(dirname(packageFile)))
			: dirname(dirname(packageFile));
		const entries = readdirSync(scope, { withFileTypes: true });
		return entries.length > 0 && entries.every((entry) => entry.isSymbolicLink());
	} catch {
		return false;
	}
}

/** Numeric-aware comparison of two dsh versions, so `0.2.0-rc.2` outranks `0.1.0-rc.7`. */
function compareVersions(left, right) {
	const parse = (version) => {
		const [core, ...rest] = String(version).split("-");
		return { core: core.split(".").map((part) => Number.parseInt(part, 10) || 0), pre: rest.join("-") };
	};
	const a = parse(left);
	const b = parse(right);
	for (let index = 0; index < Math.max(a.core.length, b.core.length); index++) {
		const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0);
		if (difference !== 0) return difference;
	}
	// A release outranks its own prereleases; two prereleases compare as text, which is
	// enough to order rc.1 < rc.2 — the only shape dsh publishes.
	if (a.pre === "" && b.pre !== "") return 1;
	if (a.pre !== "" && b.pre === "") return -1;
	return a.pre.localeCompare(b.pre);
}

/**
 * The version of the dsh inside a packaged desktop build's `app.asar`.
 *
 * A packaged build is the normal way this plugin runs on macOS, and its dsh is not on the
 * filesystem at all: `existsSync` cannot see through an asar, so the walk above finds only
 * the stale legacy profile copy. Reading the archive is therefore the difference between
 * `doctor` naming the runtime that is actually executing and naming an abandoned cache.
 *
 * Returns undefined for anything it cannot parse; a guessed version would be worse than none.
 * @param archive - path to the `app.asar` file.
 * @returns `{ version, path }`, or undefined.
 */
function asarDshPackage(archive) {
	let fd;
	try {
		fd = openSync(archive, "r");
		const head = Buffer.alloc(16);
		if (readSync(fd, head, 0, 16, 0) !== 16) return undefined;
		const headerSize = head.readUInt32LE(12);
		if (headerSize <= 0 || headerSize > 512 * 1024 * 1024) return undefined;
		const raw = Buffer.alloc(headerSize);
		if (readSync(fd, raw, 0, headerSize, 16) !== headerSize) return undefined;
		const files = JSON.parse(raw.toString("utf8"))?.files;
		let node = files?.dsh?.files?.node_modules?.files?.["@deepseek-ai"]?.files?.dsh?.files?.["package.json"];
		if (node === undefined) return undefined;
		const size = Number(node.size ?? 0);
		if (!Number.isFinite(size) || size <= 0) return undefined;
		const base = 16 + headerSize;
		const probe = Buffer.alloc(16);
		const probeLength = readSync(fd, probe, 0, probe.length, base + Number(node.offset));
		const skip = Math.max(probe.subarray(0, probeLength).toString("utf8").search(/[[{"]/), 0);
		const buffer = Buffer.alloc(size);
		const read = readSync(fd, buffer, 0, size, base + Number(node.offset) + skip);
		const parsed = JSON.parse(buffer.subarray(0, read).toString("utf8"));
		const version = typeof parsed?.version === "string" && parsed.version !== "" ? parsed.version : undefined;
		return version === undefined ? undefined : { version, path: `${archive}/dsh/node_modules/@deepseek-ai/dsh/package.json` };
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				/* the archive is closed best-effort; the version was already read */
			}
		}
	}
}

/** Every `app.asar` of a packaged desktop build, in the places installers use. */
function packagedArchives() {
	const archives = [];
	const push = (root, name) => {
		const archive = join(root, name);
		if (existsSync(archive)) archives.push(archive);
	};
	if (process.platform === "darwin") {
		for (const applications of [join(homedir(), "Applications"), "/Applications"]) {
			let bundles = [];
			try {
				bundles = readdirSync(applications).filter((entry) => entry.endsWith(".app"));
			} catch {
				bundles = [];
			}
			for (const bundle of bundles) push(join(applications, bundle, "Contents", "Resources"), "app.asar");
		}
		return archives;
	}
	if (process.platform === "win32") {
		const local = process.env.LOCALAPPDATA;
		if (typeof local === "string" && local !== "") {
			for (const base of [join(local, "Programs"), local]) {
				let dirs = [];
				try {
					dirs = readdirSync(base);
				} catch {
					dirs = [];
				}
				for (const dir of dirs) push(join(base, dir, "resources"), "app.asar");
			}
		}
		return archives;
	}
	let opt = [];
	try {
		opt = readdirSync("/opt");
	} catch {
		opt = [];
	}
	for (const dir of opt) push(join("/opt", dir, "resources"), "app.asar");
	return archives;
}

/**
 * Identify the dsh runtime this process runs on.
 *
 * Every anchor is resolved and the BEST candidate wins, rather than the first one found.
 * This matters on macOS and Linux: `~/.dsh/profiles/node_modules` is a pre-0.2 shared
 * install whose every package is a symbolic link into an old npx cache, so it keeps
 * resolving forever and shadowed the real runtime — `doctor` reported the *cache* version
 * (`0.1.0-rc.7`) while the process actually ran `0.2.0-rc.2`. A legacy shared install is
 * therefore only used when nothing else is visible, and otherwise the highest version wins.
 *
 * `DSH_RUNTIME_VERSION` overrides the discovery entirely, for a deployment this walk
 * cannot see (a bundled runtime, a container, a relocated installation).
 * @returns `{ version, file, verified }`; every field is undefined when undiscovered.
 */
export function dshRuntime() {
	const override = process.env.DSH_RUNTIME_VERSION;
	if (typeof override === "string" && override.trim() !== "") {
		const version = override.trim();
		return { version, file: undefined, verified: isVerifiedRuntime(version) };
	}

	const starts = [];
	if (typeof process.argv?.[1] === "string") starts.push(process.argv[1]);
	try {
		starts.push(fileURLToPath(import.meta.url));
	} catch {
		/* an exotic loader can refuse URL conversion; the other anchors still apply */
	}
	starts.push(join(dshHome(), "profiles"));

	const candidates = [];
	const seen = new Set();
	const add = (version, file, legacy) => {
		if (version === undefined || seen.has(file)) return;
		seen.add(file);
		candidates.push({ version, file, verified: isVerifiedRuntime(version), legacy });
	};
	for (const start of starts) {
		const file = findDshPackage(start);
		if (file === undefined) continue;
		add(versionOf(file), file, isLegacySharedInstall(file));
	}
	// A packaged desktop build keeps its dsh inside `app.asar`, where the walk above cannot
	// reach it; without this the plugin would report the stale legacy profile cache instead
	// of the runtime that is actually executing it.
	for (const archive of packagedArchives()) {
		const found = asarDshPackage(archive);
		if (found === undefined) continue;
		add(found.version, found.path, false);
	}
	if (candidates.length === 0) return { version: undefined, file: undefined, verified: undefined };

	const modern = candidates.filter((candidate) => !candidate.legacy);
	const pool = modern.length > 0 ? modern : candidates;
	pool.sort((left, right) => compareVersions(right.version, left.version));
	const best = pool[0];
	return { version: best.version, file: best.file, verified: best.verified };
}

/**
 * One diagnostic line for the identified runtime.
 * @param runtime - a value returned by {@link dshRuntime}.
 * @returns the report line, warning included when the runtime is unverified.
 */
export function runtimeLine(runtime) {
	const verified = `verified: ${VERIFIED_RUNTIMES.join(", ")}`;
	if (runtime?.version === undefined) return `dsh runtime: unknown (could not locate the running dsh package; ${verified})`;
	if (runtime.verified === true) return `dsh runtime: ${runtime.version} — verified (${verified})`;
	return `dsh runtime: ${runtime.version} — UNVERIFIED (${verified}); the peer range accepts it, but this plugin was never tested against that release line`;
}

/**
 * The warning line a report prepends when the runtime is unverified, or undefined when
 * there is nothing to warn about (verified, or undiscoverable).
 * @param runtime - a value returned by {@link dshRuntime}.
 * @returns the warning text, or undefined.
 */
export function runtimeWarning(runtime) {
	if (runtime?.verified !== false) return undefined;
	return `! 未验证的 dsh 运行时 unverified dsh runtime: ${runtime.version}（peer 范围已放行，但本插件未在该版本线上验证过）`;
}

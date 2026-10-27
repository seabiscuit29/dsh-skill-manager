// Pre-restart preflight for the dsh-skill-manager swap.
//
// The failure mode this guards against is a profile that COMPOSES but cannot
// BOOT: an inserted entry pointing at a package that was just uninstalled, a
// package whose entry file is missing, or the same entry id inserted twice.
// `dsh --profile <name> --dump-config` renders the composed patch layers but
// never resolves entry modules, so it cannot see any of those. This script can.
//
// Patch semantics it relies on (dsh-app-boot `applyEntryPatches`):
//   * a patch item with `insert` and no patch-level `id` APPENDS its entries;
//   * a patch item with a patch-level `id` and `insert` appends into that group;
//   * a patch item with `id` and no `insert` is an OVERRIDE of an existing entry
//     (cross-layer repeats of those ids are legal and expected).
// Only appended entries create new entry ids, so only those can collide.
//
// Read-only: it reads manifests, patch files and node_modules, and imports the
// host entry to prove it loads. It writes nothing.
//
// Usage:
//   node tools/preflight.mjs
//   node tools/preflight.mjs --profile web --package D:/DSH/dsh-skill-manager
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
/** Read one `--flag value` argument. */
function arg(name, fallback) {
	const index = args.indexOf(`--${name}`);
	return index === -1 || args[index + 1] === undefined ? fallback : args[index + 1];
}

const PROFILE = arg("profile", "web");
const PACKAGE_DIR = resolve(arg("package", "."));
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const PROFILE_DIR = join(DSH_HOME, "profiles", PROFILE);
/** The re-snapshot command for THIS platform; telling a macOS user to run PowerShell is a dead end. */
const RESYNC_COMMAND = process.platform === "win32" ? "tools\\resync-profile.ps1" : "bash tools/resync-profile.sh";

/**
 * The packaged desktop build ships dsh INSIDE an asar archive. Plain Node cannot see
 * through one, so `existsSync(<app>.asar/dsh/node_modules/...)` is false even though the
 * running runtime lives exactly there — which is how the gate came to be evaluated against
 * a stale npx cache. These helpers read an asar directly; Electron's own `fs` already does,
 * and returns a hit first, so this only fills the plain-Node gap.
 *
 * Layout: a Chromium pickle — `u32` total size at 4, `u32` header size at 12, the JSON index
 * from offset 16 — with file payloads addressed by `offset` from the end of the index.
 * Payloads in the shipped build carry a small non-JSON prefix, so the reader skips to the
 * first value rather than assuming the payload starts exactly at `offset`.
 */
/** Open archives, keyed by file, each with its parsed header and data offset. */
const asarIndexes = new Map();
/** Cache failures, so a path that is not an archive is not re-probed on every call. */
const asarMisses = new Set();

/** The `…app.asar/…` part of a path, and the archive-relative path inside it. */
function splitAsarPath(path) {
	const markerIndex = path.indexOf("app.asar");
	if (markerIndex === -1) return undefined;
	return {
		archive: path.slice(0, markerIndex + "app.asar".length),
		inner: path.slice(markerIndex + "app.asar".length).replace(/^[\\/]+/, ""),
	};
}

/** Parse (once) the asar header of a given archive file. */
function asarIndexOf(archive) {
	if (asarIndexes.has(archive)) return asarIndexes.get(archive);
	if (asarMisses.has(archive)) return undefined;
	let fd;
	try {
		fd = openSync(archive, "r");
		const head = Buffer.alloc(16);
		if (readSync(fd, head, 0, 16, 0) !== 16) throw new Error("truncated asar preamble");
		const headerSize = head.readUInt32LE(12);
		if (headerSize <= 0 || headerSize > 512 * 1024 * 1024) throw new Error("implausible asar header size");
		const raw = Buffer.alloc(headerSize);
		if (readSync(fd, raw, 0, headerSize, 16) !== headerSize) throw new Error("truncated asar header");
		const index = { fd, base: 16 + headerSize, header: JSON.parse(raw.toString("utf8")) };
		if (index.header === null || typeof index.header !== "object") throw new Error("asar header is not an object");
		asarIndexes.set(archive, index);
		return index;
	} catch {
		if (fd !== undefined) closeSync(fd);
		asarMisses.add(archive);
		return undefined;
	}
}

/** Walk one asar header entry down a slash-separated path. */
function asarEntry(index, inner) {
	let current = index.header.files;
	let entry;
	for (const segment of inner.split("/").filter(Boolean)) {
		entry = current?.[segment];
		if (entry === undefined) return undefined;
		current = entry.files;
	}
	return entry;
}

/** Whether a path exists on disk or inside an asar archive. */
function pathExists(path) {
	if (existsSync(path)) return true;
	const split = splitAsarPath(path);
	if (split === undefined) return false;
	const index = asarIndexOf(split.archive);
	if (index === undefined) return false;
	if (split.inner === "") return true;
	return asarEntry(index, split.inner) !== undefined;
}

/** Read a file from inside an asar archive, trimming the payload's non-JSON prefix. */
function readAsarText(split) {
	const index = asarIndexOf(split.archive);
	if (index === undefined) return undefined;
	const entry = asarEntry(index, split.inner);
	if (entry === undefined) return undefined;
	if (entry.unpacked === true) {
		try {
			return readFileSync(`${split.archive}.unpacked/${split.inner}`, "utf8");
		} catch {
			return undefined;
		}
	}
	const size = Number(entry.size ?? 0);
	if (!Number.isFinite(size) || size <= 0) return undefined;
	// One probe read locates where the value really starts; the entry is then read exactly,
	// so trailing bytes of the next member can never leak into the parse.
	const probe = Buffer.alloc(16);
	const probeLength = readSync(index.fd, probe, 0, probe.length, index.base + Number(entry.offset));
	const start = probe.subarray(0, probeLength).toString("utf8").search(/[[{"]/);
	const skip = start <= 0 ? 0 : start;
	const buffer = Buffer.alloc(size);
	const read = readSync(index.fd, buffer, 0, size, index.base + Number(entry.offset) + skip);
	return buffer.subarray(0, read).toString("utf8");
}

/** Base modules a client bundle may require without declaring them external. */
const BASE_SEED = new Set([
	"react",
	"react/jsx-runtime",
	"react-dom",
	"react-dom/client",
	"@deepseek-ai/cordis",
	"@deepseek-ai/dsh-client-store",
	"@deepseek-ai/dsh-client-ui-slots",
	"@deepseek-ai/dsh-client-ui-primitives",
	"@deepseek-ai/dsh-client-ui-dockkit",
]);

/** Packages this swap must have retired. */
const RETIRED = ["@deepseek-ai/dsh-client-ui-settings-skills", "@deepseek-ai/dsh-skill-manager"];

/** `--package-only` checks the package contract alone (used by CI on every OS). */
const PACKAGE_ONLY = args.includes("--package-only");

const errors = [];
const warnings = [];
const notes = [];
const fail = (message) => errors.push(message);
const warn = (message) => warnings.push(message);
const note = (message) => notes.push(message);

/** Parse JSON, reporting rather than throwing. Tolerates a UTF-8 BOM. */
function readJson(file) {
	let text;
	try {
		// Prefer the asar-aware path: the running runtime lives inside the packaged desktop
		// build's archive, where a plain `readFileSync` reports the file as missing.
		const split = splitAsarPath(file);
		const fromArchive = split === undefined ? undefined : readAsarText(split);
		text = fromArchive ?? readFileSync(file, "utf8");
	} catch (error) {
		fail(`cannot parse ${file}: ${error.message}`);
		return undefined;
	}
	try {
		return JSON.parse(text.replace(/^\uFEFF/, ""));
	} catch (error) {
		fail(`cannot parse ${file}: ${error.message}`);
		return undefined;
	}
}

/** Leading-space count of a line. */
function indentOf(line) {
	return line.length - line.trimStart().length;
}

/**
 * Parse a cordis patch file into appended entries and override ids.
 * A small purpose-built subset parser: these files are flat lists of insert
 * blocks and id-targeted overrides, and this keeps the tool dependency-free.
 * @returns `{ appended: [{id, name}], overrides: [id] }`
 */
function parsePatch(file) {
	if (!existsSync(file)) return { file, appended: [], overrides: [], parsed: false };
	const appended = [];
	const overrides = [];
	let item = null; // top-level patch item
	const flush = () => {
		if (item === null) return;
		if (item.insert === true) {
			// Entries this block appends: the block's own id is a GROUP TARGET, the
			// ids nested inside are the new entries.
			appended.push(...item.entries);
			if (item.ownId !== undefined && item.entries.length > 0) note(`${file}: group insert into "${item.ownId}"`);
		} else if (item.ownId !== undefined) {
			overrides.push(item.ownId);
		}
		item = null;
	};

	for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
		const line = rawLine.replace(/#.*$/, "").trimEnd();
		if (line.trim() === "") continue;
		const indent = indentOf(line);
		const entryId = /^\s*-\s*id:\s*['"]?([^'"]+)['"]?\s*$/.exec(line);
		const plainId = /^\s*id:\s*['"]?([^'"]+)['"]?\s*$/.exec(line);
		const nameMatch = /^\s*name:\s*['"]?([^'"]+)['"]?\s*$/.exec(line);

		if (indent === 0 && line.startsWith("- ")) {
			flush();
			item = { insert: false, ownId: undefined, entries: [], entryIndent: undefined };
			if (/^-\s*insert:\s*$/.test(line)) {
				item.insert = true;
				continue;
			}
			if (entryId !== null) item.ownId = entryId[1].trim();
			continue;
		}
		if (item === null) continue;
		if (item.insert !== true) {
			if (/^\s*insert:\s*$/.test(line)) {
				item.insert = true;
				continue;
			}
			if (indent >= 2 && plainId !== null && item.ownId === undefined) item.ownId = plainId[1].trim();
			continue;
		}
		// Inside an insert block, only the block's DIRECT entries are appended. A row may
		// nest its own child list — a dsh 0.2 agent preset carries `config.plugins`, and
		// those ids belong to that row, not to the profile root. Counting them appended
		// reported hundreds of phantom duplicate ids.
		if (entryId !== null) {
			if (item.entryIndent === undefined) item.entryIndent = indent;
			if (indent === item.entryIndent) item.entries.push({ id: entryId[1].trim(), name: undefined });
			continue;
		}
		if (nameMatch !== null && item.entries.length > 0 && indent === item.entryIndent + 2) {
			item.entries[item.entries.length - 1].name = nameMatch[1].trim();
		}
	}
	flush();
	return { file, appended, overrides, parsed: true };
}

/** Split a module specifier into its package and optional subpath. */
function splitSpecifier(specifier) {
	const segments = specifier.split("/");
	const packageSegments = specifier.startsWith("@") ? segments.slice(0, 2) : segments.slice(0, 1);
	return { packageName: packageSegments.join("/"), subpath: segments.slice(packageSegments.length).join("/") };
}

/**
 * Resolve a package directory the way the loader does: install copy, then profile.
 * Uses the asar-aware probe, because the install anchor of a packaged desktop build is
 * inside `app.asar` and a plain `existsSync` reports every one of its packages as missing.
 */
function resolvePackageDir(packageName, { installAnchor, profileDir }) {
	const candidates = [];
	if (installAnchor !== null) candidates.push(join(installAnchor, "node_modules", ...packageName.split("/")));
	candidates.push(join(profileDir, "node_modules", ...packageName.split("/")));
	candidates.push(join(dirname(profileDir), "node_modules", ...packageName.split("/")));
	for (const dir of candidates) {
		if (pathExists(join(dir, "package.json"))) return dir;
	}
	return undefined;
}

/** The file an export subpath (or `main`) points at, or undefined. */
function exportTarget(pkg, subpath) {
	const entry = subpath === "." ? (pkg.exports?.["."] ?? pkg.main) : pkg.exports?.[subpath];
	if (entry === undefined) return undefined;
	if (typeof entry === "string") return entry;
	return entry.default ?? entry.import ?? entry.require;
}

/**
 * Prove one entry specifier resolves to a real file, the way the loader will.
 * Handles package subpaths (`@scope/pkg/sub`), which is what the first-party
 * bundles use for multi-entry packages.
 *
 * `cordis:*` names are cordis BUILT-IN specifiers, not packages: dsh's own resolver
 * short-circuits them (`if (name.startsWith("cordis:")) return void 0`) and the loader
 * gives them built-in semantics (`cordis:group` is the group row). Resolving them as npm
 * packages reported a false "does not resolve" error the moment an upstream bundle
 * started using `cordis:group` (dsh 0.2.1-rc.4, `dsh-experimental-session-search`).
 */
function checkEntrySpecifier(label, specifier, context) {
	if (specifier.startsWith("cordis:")) {
		note(`${label}: "${specifier}" is a cordis built-in specifier (no package resolution)`);
		return;
	}
	const { packageName, subpath } = splitSpecifier(specifier);
	const dir = resolvePackageDir(packageName, context);
	if (dir === undefined) {
		fail(`${label}: entry mounts "${specifier}" but package "${packageName}" does not resolve from the profile or the installation`);
		return;
	}
	const pkg = readJson(join(dir, "package.json"));
	if (pkg === undefined) return;
	if (subpath !== "") {
		const target = exportTarget(pkg, `./${subpath}`);
		if (target === undefined) {
			warn(`${label}: "${specifier}" has no "./${subpath}" export (the loader may still resolve it by path)`);
			return;
		}
		if (!pathExists(join(dir, target))) fail(`${label}: "${specifier}" points at a missing file: ${target}`);
		return;
	}
	const target = exportTarget(pkg, ".");
	if (target === undefined || !pathExists(join(dir, target))) {
		fail(`${label}: entry "${specifier}" resolves to ${dir} but its entry file is missing — this bricks the boot`);
	}
}

console.log(`preflight: package=${PACKAGE_DIR}`);
console.log(`preflight: profile=${PROFILE_DIR}\n`);

// ------------------------------------------------ dsh 0.2+ compatibility gate
/** Manifest of a dsh copy; reads through an asar archive when the runtime is bundled. */
function runtimeManifestOf(dir) {
	return readJson(join(dir, "package.json"));
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
	if (a.pre === "" && b.pre !== "") return 1;
	if (a.pre !== "" && b.pre === "") return -1;
	return a.pre.localeCompare(b.pre);
}

/**
 * Whether a dsh copy is the LEGACY profile-shared install
 * (`~/.dsh/profiles/node_modules/@deepseek-ai/dsh`).
 *
 * Pre-0.2 layouts put one shared install there, and on macOS/Linux every package in it is a
 * symlink into whichever npx cache created it. Such a copy keeps resolving forever, so the
 * naive "first candidate that has a package.json" rule picked IT and evaluated the gate
 * against a runtime the process is not running — reporting `dsh 0.1.0-rc.7 SKIPS this bundle`
 * on a healthy macOS deployment whose runtime is 0.2.0-rc.2.
 */
function isLegacySharedInstall(dir) {
	try {
		const scope = join(dirname(dirname(dir)));
		const entries = readdirSync(scope, { withFileTypes: true });
		return entries.length > 0 && entries.every((entry) => entry.isSymbolicLink());
	} catch {
		return false;
	}
}

/**
 * Every dsh a PACKAGED build might be running, derived from standard install locations.
 *
 * A packaged app keeps its dsh inside an asar archive under its own resources directory,
 * which no walk up from the project can reach — on macOS the app lives in `/Applications`
 * while the plugin is checked out in the home directory. These are the locations the
 * platform installers use, searched in the order a user is most likely to have used.
 * @returns candidate `…/@deepseek-ai/dsh` directories, existing ones only.
 */
function packagedRuntimeCandidates() {
	const roots = [];
	const home = homedir();
	if (process.platform === "darwin") {
		for (const applications of [join(home, "Applications"), "/Applications", "/Applications/Utilities"]) {
			let bundles = [];
			try {
				bundles = readdirSync(applications).filter((entry) => entry.endsWith(".app"));
			} catch {
				continue;
			}
			for (const bundle of bundles) roots.push(join(applications, bundle, "Contents", "Resources"));
		}
	} else if (process.platform === "win32") {
		const local = process.env.LOCALAPPDATA;
		if (typeof local === "string" && local !== "") {
			for (const base of [join(local, "Programs"), local]) {
				let dirs = [];
				try {
					dirs = readdirSync(base);
				} catch {
					continue;
				}
				for (const dir of dirs) roots.push(join(base, dir, "resources"));
			}
		}
	} else {
		let opt = [];
		try {
			opt = readdirSync("/opt");
		} catch {
			opt = [];
		}
		for (const dir of opt) roots.push(join("/opt", dir, "resources"));
		roots.push("/usr/lib/resources", "/usr/share/resources");
	}
	const found = [];
	for (const root of roots) {
		for (const archive of ["app.asar", "app"]) {
			const dir = join(root, archive, "dsh", "node_modules", "@deepseek-ai", "dsh");
			if (pathExists(join(dir, "package.json"))) found.push(dir);
		}
	}
	return found;
}

/**
 * Locate the dsh installation whose version the gate must be evaluated against.
 *
 * Every candidate is collected and the BEST one wins, rather than the first that exists:
 * the runtime the process actually runs, not merely a dsh package that happens to resolve.
 * Preference order: an explicit `--dsh-root` / `$DSH_INSTALL_ROOT` (a deliberate override),
 * then a real installation over a legacy shared one, then the highest version.
 *
 * `DSH_RUNTIME_VERSION` pins the version outright, for a runtime this walk cannot see.
 * @returns the `@deepseek-ai/dsh` package directory, or undefined.
 */
function locateDshRoot() {
	const explicit = arg("dsh-root", process.env.DSH_INSTALL_ROOT);
	if (typeof explicit === "string" && explicit.trim() !== "") {
		const dir = resolve(explicit.trim());
		return pathExists(join(dir, "package.json")) ? dir : undefined;
	}

	const candidates = [];
	const add = (dir) => {
		if (!pathExists(join(dir, "package.json"))) return;
		const manifest = runtimeManifestOf(dir);
		const version = typeof manifest?.version === "string" ? manifest.version : undefined;
		if (version === undefined) return;
		if (candidates.some((candidate) => candidate.dir === dir)) return;
		// `dsh-app-boot` is the runtime's own version oracle, so its presence marks a real
		// installation rather than a dependency copy that merely happens to resolve.
		candidates.push({ dir, version, legacy: isLegacySharedInstall(dir), oracle: pathExists(join(dirname(dir), "dsh-app-boot", "lib", "index.js")) });
	};

	// 1. the installation the process itself runs from.
	for (const start of [process.argv?.[1], process.execPath]) {
		if (typeof start !== "string" || start.trim() === "") continue;
		let current = resolve(start);
		for (let depth = 0; depth < 8; depth++) {
			add(join(current, "node_modules", "@deepseek-ai", "dsh"));
			add(join(current, "@deepseek-ai", "dsh"));
			const parent = dirname(current);
			if (parent === current) break;
			current = parent;
		}
	}
	// 2. a packaged build installed in the platform's usual place.
	for (const dir of packagedRuntimeCandidates()) add(dir);
	// 3. the legacy shared profile install, and the npx caches a `npx @deepseek-ai/dsh` run leaves.
	add(join(PROFILE_DIR, "node_modules", "@deepseek-ai", "dsh"));
	const caches = [
		process.env.npm_config_cache,
		process.env.LOCALAPPDATA === undefined ? undefined : join(process.env.LOCALAPPDATA, "npm-cache"),
		join(homedir(), ".npm"),
		join(homedir(), "AppData", "Local", "npm-cache"),
	].filter((entry) => typeof entry === "string" && entry !== "" && existsSync(entry));
	for (const cache of caches) {
		const npx = join(cache, "_npx");
		if (!existsSync(npx)) continue;
		for (const entry of readdirSync(npx)) add(join(npx, entry, "node_modules", "@deepseek-ai", "dsh"));
	}

	const modern = candidates.filter((candidate) => !candidate.legacy);
	const pool = modern.length > 0 ? modern : candidates;
	pool.sort((left, right) => Number(right.oracle) - Number(left.oracle) || compareVersions(right.version, left.version));
	return pool[0]?.dir;
}

/**
 * Fail when dsh would refuse to load this bundle.
 *
 * dsh 0.2.0 added a gate before any patch layer is applied: every
 * `@deepseek-ai/dsh*` entry in `peerDependencies` must satisfy the running version,
 * `peerDependenciesMeta.optional` is ignored, and a mismatch makes the whole bundle
 * a no-op — the plugin silently never mounts, and nothing in the plugin's own doctor
 * can report it, because doctor never runs. A `^0.1.5-rc.1` range cost exactly that.
 * @param pkg - the parsed package.json of the plugin.
 */
async function checkCompatibilityGate(pkg) {
	const root = locateDshRoot();
	const pinned = process.env.DSH_RUNTIME_VERSION;
	if (root === undefined && !(typeof pinned === "string" && pinned.trim() !== "")) {
		note("compatibility gate: not evaluated (no dsh install located; pass --dsh-root <dir>)");
		return;
	}
	const runtime =
		typeof pinned === "string" && pinned.trim() !== ""
			? pinned.trim()
			: runtimeManifestOf(root)?.version;
	if (typeof runtime !== "string") {
		note("compatibility gate: not evaluated (the located dsh package has no version)");
		return;
	}
	const manifest = { name: pkg.name, version: pkg.version, peerDependencies: pkg.peerDependencies ?? {} };
	const peers = Object.entries(manifest.peerDependencies).filter(
		([peer]) => peer === "@deepseek-ai/dsh" || peer.startsWith("@deepseek-ai/dsh-"),
	);
	if (peers.length === 0) {
		note(`compatibility gate: PASS (dsh ${runtime}; no @deepseek-ai/dsh* peers declared, so the bundle always loads)`);
		return;
	}
	if (root !== undefined) note(`compatibility gate: runtime source ${root} (dsh ${runtime})`);

	let issue;
	let mechanism = "the real dsh implementation";
	// Prefer the `dsh-app-boot` that this very process already loaded: when preflight is run
	// from inside the harness it is in the module cache, and importing it by its own URL works
	// even when the installation is packed in an asar archive that `existsSync` — but not the
	// loader — cannot see.
	const loaded = Object.keys(createRequire(import.meta.url).cache ?? {}).find((key) =>
		key.replaceAll("\\", "/").includes("@deepseek-ai/dsh-app-boot/lib/index."),
	);
	const bootEntries = [
		loaded,
		root === undefined ? undefined : join(dirname(root), "dsh-app-boot", "lib", "index.js"),
	].filter((entry) => typeof entry === "string");
	try {
		let boot;
		for (const entry of bootEntries) {
			try {
				boot = await import(pathToFileURL(entry).href);
			} catch {
				continue;
			}
			if (typeof boot?.evaluatePluginCompatibility === "function") break;
			boot = undefined;
		}
		if (typeof boot?.evaluatePluginCompatibility !== "function") {
			throw new Error("dsh-app-boot is not installed next to dsh, and none is loaded in this process");
		}
		issue = boot.evaluatePluginCompatibility(manifest, {}, runtime);
	} catch (error) {
		// Same rule, evaluated locally: this is the shape the gate implements.
		mechanism = `a local re-implementation (${error.message})`;
		// `semver` is loaded from whichever anchor has it: the located installation keeps it
		// next to the runtime, while a packaged build keeps it inside the archive, where only
		// the profile's own resolution can find it.
		const anchors = [root, PROFILE_DIR, PACKAGE_DIR].filter((entry) => typeof entry === "string");
		let semver;
		let semverError;
		for (const anchor of anchors) {
			try {
				semver = createRequire(join(anchor, "package.json"))("semver");
				break;
			} catch (failure) {
				semverError = failure;
			}
		}
		if (semver === undefined) {
			note(`compatibility gate: not evaluated (${semverError?.message ?? "semver is not resolvable"})`);
			return;
		}
		try {
			const unsatisfied = peers.filter(([, range]) => !semver.satisfies(runtime, range, { includePrerelease: true }));
			issue = unsatisfied.length === 0 ? undefined : { peers: Object.fromEntries(unsatisfied) };
		} catch (semverError) {
			note(`compatibility gate: not evaluated (${semverError.message})`);
			return;
		}
	}

	if (issue === undefined) {
		note(`compatibility gate: PASS (dsh ${runtime} satisfies ${peers.length} peer range(s), checked with ${mechanism})`);
		return;
	}
	fail(
		`compatibility gate: dsh ${runtime} SKIPS this bundle — peerDependencies ${JSON.stringify(issue.peers)} do not accept it, ` +
			"and optional peers are not exempt (checked with " +
			mechanism +
			"). dsh appends no entry for it, so the plugin never mounts and nothing it logs can say so. " +
			`Widen the ranges (e.g. ">=<oldest-verified> <next-minor>-0") or grant the exact-version exemption for ${pkg.name}@${pkg.version} with \`dsh plugin allow-version\`.`,
	);
}

// ---------------------------------------------------------------- package side
console.log("package checks");
const pkgFile = join(PACKAGE_DIR, "package.json");
if (!existsSync(pkgFile)) {
	fail(`no package.json at ${PACKAGE_DIR}`);
} else {
	const pkg = readJson(pkgFile);
	if (pkg !== undefined) {
		const name = pkg.name;
		note(`package: ${name} v${pkg.version}`);
		if (typeof name !== "string" || name === "") fail("package.json has no name");
		if (String(name).startsWith("@deepseek-ai/")) {
			warn("package stays inside the @deepseek-ai scope: an official release of the same name would shadow it");
		}

		// 1. every declared export target must exist (a missing entry bricks the profile).
		for (const subpath of [".", "./client", "./cordis.patch.yml", "./package.json"]) {
			const target = exportTarget(pkg, subpath);
			if (target === undefined) {
				fail(`exports["${subpath}"] is not declared`);
				continue;
			}
			if (!existsSync(join(PACKAGE_DIR, target))) fail(`exports["${subpath}"] points at a missing file: ${target}`);
		}

		// 1b. No UTF-8 BOM in the files a strict JSON/YAML parser reads. The launcher
		// parses package.json with a bare JSON.parse, which THROWS on a BOM — a
		// PowerShell `Set-Content -Encoding UTF8` (PS 5.1) adds one silently.
		for (const relative of ["package.json", "cordis.patch.yml"]) {
			const file = join(PACKAGE_DIR, relative);
			if (!existsSync(file)) continue;
			const head = readFileSync(file).subarray(0, 3);
			if (head.length === 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
				fail(`${relative} starts with a UTF-8 BOM; the launcher's JSON/YAML parser throws on it — rewrite the file without a BOM`);
			}
		}

		// 2. bundle declaration: the single criterion for auto-mounting.
		// dsh 0.2 accepts a path or a list of paths here (`bundlePatchFiles`).
		const patchRel = pkg.dsh?.bundle?.patch;
		const patchFiles = typeof patchRel === "string" ? [patchRel] : Array.isArray(patchRel) ? patchRel : undefined;
		if (patchFiles === undefined || patchFiles.some((file) => typeof file !== "string")) {
			fail("package.json does not declare dsh.bundle.patch (dsh plugin add would install it as a plain dependency)");
		} else {
			const missing = patchFiles.filter((file) => !existsSync(join(PACKAGE_DIR, file)));
			if (missing.length > 0) {
				fail(`dsh.bundle.patch points at a missing file: ${missing.join(", ")}`);
			} else {
				for (const file of patchFiles) {
					const patch = parsePatch(join(PACKAGE_DIR, file));
					if (patch.appended.length === 0) fail(`${file} appends no entry`);
					for (const entry of patch.appended) {
						if (entry.name === undefined) {
							fail(`${file}: appended entry "${entry.id}" has no name`);
							continue;
						}
						if (entry.name !== name) {
							warn(`${file}: entry "${entry.id}" mounts "${entry.name}" but the package is "${name}"`);
						}
						note(`bundle appends entry: id=${entry.id} name=${entry.name}`);
					}
				}
			}
		}

		// 3. client half declaration.
		const client = pkg.dsh?.client;
		if (client === undefined) {
			note("no dsh.client declaration: this package has no browser half");
		} else {
			if (client.platform !== "web") fail(`dsh.client.platform must be "web"; got ${JSON.stringify(client.platform)}`);
			const clientRel = exportTarget(pkg, "./client");
			if (clientRel === undefined) {
				fail('dsh.client is declared but exports["./client"] is missing');
			} else {
				const clientFile = join(PACKAGE_DIR, clientRel);
				// The package under test is the checkout, but read through the same helper so a
				// package inside an asar archive is still inspectable.
				const split = splitAsarPath(clientFile);
				let text = "";
				try {
					text = split === undefined ? readFileSync(clientFile, "utf8") : (readAsarText(split) ?? "");
				} catch {
					text = "";
				}
				if (text === "") {
					fail(`client bundle is missing or empty: ${clientRel}`);
				} else {
					const idMatch = /__ModuleLoader__\.load\(\{\s*id:\s*["']([^"']+)["']/.exec(text);
					if (idMatch === null) {
						fail(`client bundle is not a lazy-CJS factory package: ${clientRel}`);
					} else {
						if (idMatch[1] === name) note(`client bundle id matches the package name: ${idMatch[1]}`);
						else warn(`client bundle id "${idMatch[1]}" differs from the package name "${name}"`);
						// The module-system preamble is load-bearing: a bundle that assigns to
						// `exports` without declaring it throws "exports is not defined" inside
						// the browser loader, which surfaces as "Failed to load plugins".
						const usesCjs = /\bexports\.[A-Za-z_$]/.test(text) || /\bmodule\.exports\b/.test(text);
						const declaresCjs =
							/\b(?:var|let|const)\s+exports\b/.test(text) && /\b(?:var|let|const)\s+module\b/.test(text);
						if (usesCjs && !declaresCjs) {
							fail(
								`client bundle assigns to exports/module.exports without declaring them (add the "var module = { exports: {} }; var exports = module.exports;" preamble): ${clientRel}`,
							);
						}
						const required = [...text.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]);
						const external = new Set(pkg.dsh?.client?.external ?? []);
						const undeclared = [...new Set(required)].filter(
							(moduleName) => !BASE_SEED.has(moduleName) && !external.has(moduleName) && !moduleName.startsWith("."),
						);
						if (undeclared.length > 0) {
							fail(`client bundle requires non-seed modules that are not declared external: ${undeclared.join(", ")}`);
						} else {
							note(`client requires only allowed modules: ${[...new Set(required)].join(", ")}`);
						}
					}
				}
			}
		}

		// 4. the host entry must load and export a cordis plugin.
		try {
			const entry = await import(pathToFileURL(join(PACKAGE_DIR, exportTarget(pkg, ".") ?? "lib/index.js")).href);
			if (typeof entry.apply !== "function") fail("host entry does not export apply()");
			if (!Array.isArray(entry.inject)) fail("host entry does not export an inject array");
			note(`host entry loads: name=${entry.name} inject=[${(entry.inject ?? []).join(", ")}]`);
		} catch (error) {
			fail(`host entry failed to import: ${error.message}`);
		}

		// 5. dsh 0.2+ refuses to mount a bundle whose @deepseek-ai/dsh* peers exclude
		// the running version. Checked here because the failure is otherwise invisible.
		await checkCompatibilityGate(pkg);
	}
}

// ---------------------------------------------------------------- profile side
if (PACKAGE_ONLY) {
	note("--package-only: profile composition checks skipped (the package contract above is what CI verifies on every OS)");
} else {
console.log("\nprofile checks");
const profilePkgFile = join(PROFILE_DIR, "package.json");
if (!existsSync(profilePkgFile)) {
	fail(`no profile package.json at ${PROFILE_DIR}`);
} else {
	const profilePkg = readJson(profilePkgFile);
	const dependencies = Object.keys(profilePkg?.dependencies ?? {});
	const bundles = profilePkg?.dsh?.profile?.bundles ?? [];
	note(`profile dependencies: ${dependencies.join(", ") || "-"}`);
	note(`profile bundles: ${bundles.join(", ") || "-"}`);

	// Retired packages must be gone before the restart (this tool is meant to run
	// after the swap; before the swap these FAILs are the expected state).
	for (const retired of RETIRED) {
		if (dependencies.includes(retired)) fail(`retired package still installed: ${retired} (remove it, then re-run)`);
	}
	if (dependencies.includes("dsh-skill-manager") && !bundles.includes("dsh-skill-manager")) {
		warn("the new package is installed but not in dsh.profile.bundles — run: dsh plugin --profile web add <spec>");
	}

	// The loader resolves an entry's package against the *installation* first and the
	// profile second. In dsh 0.2 the installation is the npx checkout, so the anchor has
	// to be discovered: leaving it null made every first-party entry look unresolvable.
	const dshRoot = locateDshRoot();
	const installAnchor = dshRoot === undefined ? null : resolve(dshRoot, "..", "..", "..");
	if (installAnchor === null) {
		warn("no dsh installation located: entry packages are resolved against the profile only (pass --dsh-root <dir>)");
	} else {
		note(`installation anchor: ${installAnchor}`);
	}
	const legacyShared = join(dirname(PROFILE_DIR), "node_modules", "@deepseek-ai", "dsh");
	if (installAnchor !== null && existsSync(join(legacyShared, "package.json"))) {
		const legacyVersion = readJson(join(legacyShared, "package.json"))?.version;
		note(
			`legacy shared install still present: ${legacyShared} (dsh ${legacyVersion ?? "?"}) — harmless while the installation resolves first, but it is what a stale layout looks like`,
		);
	}

	const context = { installAnchor, profileDir: PROFILE_DIR };
	const appendedIds = new Map();
	const collectLayer = (label, patchFile) => {
		const patch = parsePatch(patchFile);
		if (!patch.parsed) {
			if (label.startsWith("profile")) fail(`profile patch file is missing: ${patchFile}`);
			return;
		}
		note(`${label}: appends ${patch.appended.length}, overrides ${patch.overrides.length}`);
		for (const entry of patch.appended) {
			if (appendedIds.has(entry.id)) {
				fail(
					`duplicate appended entry id "${entry.id}" (${appendedIds.get(entry.id)} and ${label}) — two entries with one id cannot mount`,
				);
			} else {
				appendedIds.set(entry.id, label);
			}
			if (entry.name !== undefined) checkEntrySpecifier(label, entry.name, context);
		}
	};

	for (const bundleName of bundles) {
		const dir = resolvePackageDir(bundleName, context);
		if (dir === undefined) {
			fail(`bundle "${bundleName}" does not resolve from the profile or the installation`);
			continue;
		}
		const bundlePkg = readJson(join(dir, "package.json"));
		// dsh 0.2 accepts a path OR a list of paths here (`bundlePatchFiles`), and
		// @deepseek-ai/dsh-web-app itself uses the list form — assuming a string made
		// this check crash on its own profile instead of reporting anything.
		const patchRel = bundlePkg?.dsh?.bundle?.patch;
		if (patchRel === undefined) {
			fail(`bundle "${bundleName}" declares no dsh.bundle.patch — the launcher throws on startup`);
			continue;
		}
		const patchFiles = typeof patchRel === "string" ? [patchRel] : Array.isArray(patchRel) ? patchRel : undefined;
		if (patchFiles === undefined || patchFiles.some((file) => typeof file !== "string")) {
			fail(
				`bundle "${bundleName}" declares dsh.bundle.patch as neither a path nor a list of paths — the launcher throws on startup`,
			);
			continue;
		}
		for (const file of patchFiles) collectLayer(`bundle ${bundleName}`, join(dir, file));
	}

	collectLayer("profile cordis.patch.yml", join(PROFILE_DIR, "cordis.patch.yml"));

	// The Settings - Skills section must have exactly one owner.
	if (dependencies.includes("@deepseek-ai/dsh-client-ui-settings-skills") && dependencies.includes("dsh-skill-manager")) {
		fail('both the retired read-only Skills page and the new plugin are installed: they claim the same settings.section id "skills"');
	}
	note(`appended entry ids total: ${appendedIds.size}`);

	// 7. the INSTALLED snapshot must match the source that was just validated:
	// pnpm treats a file: dependency as up to date by path alone, so a source fix
	// that was never re-snapshotted would boot the old code.
	const localName = readJson(pkgFile)?.name;
	const installedDir = typeof localName === "string" ? resolvePackageDir(localName, context) : undefined;
	if (installedDir !== undefined && resolve(installedDir) !== resolve(PACKAGE_DIR)) {
		const relativeFiles = ["package.json", "cordis.patch.yml"];
		const collect = (dir, prefix) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (entry.name.startsWith(".")) continue;
				const path = join(dir, entry.name);
				const rel = `${prefix}/${entry.name}`;
				if (entry.isDirectory()) collect(path, rel);
				else relativeFiles.push(rel);
			}
		};
		if (existsSync(join(PACKAGE_DIR, "lib"))) collect(join(PACKAGE_DIR, "lib"), "lib");
		const stale = relativeFiles.filter((rel) => {
			const from = join(PACKAGE_DIR, rel);
			const to = join(installedDir, rel);
			if (!existsSync(from) || !existsSync(to)) return true;
			return readFileSync(from).compare(readFileSync(to)) !== 0;
		});
		if (stale.length > 0) {
			fail(
				`the installed snapshot is stale (${stale.length} file(s) differ, e.g. ${stale.slice(0, 3).join(", ")}); run ${RESYNC_COMMAND} so the profile serves the current code`,
			);
		} else {
			note(`installed snapshot matches the source (${relativeFiles.length} files)`);
		}
	}
}
}

// ------------------------------------------------------------------- verdict
console.log("");
for (const item of notes) console.log(`  note  ${item}`);
for (const item of warnings) console.log(`  WARN  ${item}`);
for (const item of errors) console.log(`  FAIL  ${item}`);
console.log(`\n${errors.length === 0 ? "PASS" : "BLOCKED"}: ${errors.length} error(s), ${warnings.length} warning(s)`);
if (errors.length > 0) {
	console.log("\nDo NOT restart dsh web until every FAIL above is resolved.");
	process.exit(1);
}
console.log("Safe to restart dsh web.");

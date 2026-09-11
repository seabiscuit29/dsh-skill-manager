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
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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

const errors = [];
const warnings = [];
const notes = [];
const fail = (message) => errors.push(message);
const warn = (message) => warnings.push(message);
const note = (message) => notes.push(message);

/** Parse JSON, reporting rather than throwing. Tolerates a UTF-8 BOM. */
function readJson(file) {
	try {
		return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
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
		const idMatch = /^\s*-\s*id:\s*['"]?([^'"]+)['"]?\s*$/.exec(line) ?? /^\s*id:\s*['"]?([^'"]+)['"]?\s*$/.exec(line);
		const nameMatch = /^\s*name:\s*['"]?([^'"]+)['"]?\s*$/.exec(line);

		if (indent === 0 && line.startsWith("- ")) {
			flush();
			item = { insert: false, ownId: undefined, entries: [] };
			if (/^-\s*insert:\s*$/.test(line)) {
				item.insert = true;
				continue;
			}
			if (idMatch !== null) item.ownId = idMatch[1].trim();
			continue;
		}
		if (item === null) continue;
		if (/^\s*insert:\s*$/.test(line)) {
			item.insert = true;
			continue;
		}
		if (indent >= 4 && idMatch !== null) {
			item.entries.push({ id: idMatch[1].trim(), name: undefined });
			continue;
		}
		if (indent >= 4 && nameMatch !== null && item.entries.length > 0) {
			item.entries[item.entries.length - 1].name = nameMatch[1].trim();
			continue;
		}
		if (indent >= 2 && idMatch !== null && item.ownId === undefined) item.ownId = idMatch[1].trim();
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

/** Resolve a package directory the way the loader does: install copy, then profile. */
function resolvePackageDir(packageName, { installAnchor, profileDir }) {
	const candidates = [];
	if (installAnchor !== null) candidates.push(join(installAnchor, "node_modules", ...packageName.split("/")));
	candidates.push(join(profileDir, "node_modules", ...packageName.split("/")));
	candidates.push(join(dirname(profileDir), "node_modules", ...packageName.split("/")));
	for (const dir of candidates) {
		if (existsSync(join(dir, "package.json"))) return dir;
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
 */
function checkEntrySpecifier(label, specifier, context) {
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
		if (!existsSync(join(dir, target))) fail(`${label}: "${specifier}" points at a missing file: ${target}`);
		return;
	}
	const target = exportTarget(pkg, ".");
	if (target === undefined || !existsSync(join(dir, target))) {
		fail(`${label}: entry "${specifier}" resolves to ${dir} but its entry file is missing — this bricks the boot`);
	}
}

console.log(`preflight: package=${PACKAGE_DIR}`);
console.log(`preflight: profile=${PROFILE_DIR}\n`);

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
		const patchRel = pkg.dsh?.bundle?.patch;
		if (typeof patchRel !== "string") {
			fail("package.json does not declare dsh.bundle.patch (dsh plugin add would install it as a plain dependency)");
		} else if (!existsSync(join(PACKAGE_DIR, patchRel))) {
			fail(`dsh.bundle.patch points at a missing file: ${patchRel}`);
		} else {
			const patch = parsePatch(join(PACKAGE_DIR, patchRel));
			if (patch.appended.length === 0) fail(`${patchRel} appends no entry`);
			for (const entry of patch.appended) {
				if (entry.name === undefined) {
					fail(`${patchRel}: appended entry "${entry.id}" has no name`);
					continue;
				}
				if (entry.name !== name) {
					warn(`${patchRel}: entry "${entry.id}" mounts "${entry.name}" but the package is "${name}"`);
				}
				note(`bundle appends entry: id=${entry.id} name=${entry.name}`);
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
				const text = existsSync(clientFile) ? readFileSync(clientFile, "utf8") : "";
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
	}
}

// ---------------------------------------------------------------- profile side
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

	const context = { installAnchor: null, profileDir: PROFILE_DIR };
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
		const patchRel = bundlePkg?.dsh?.bundle?.patch;
		if (patchRel === undefined) {
			fail(`bundle "${bundleName}" declares no dsh.bundle.patch — the launcher throws on startup`);
			continue;
		}
		collectLayer(`bundle ${bundleName}`, join(dir, patchRel));
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
				`the installed snapshot is stale (${stale.length} file(s) differ, e.g. ${stale.slice(0, 3).join(", ")}); run tools/resync-profile.ps1 so the profile serves the current code`,
			);
		} else {
			note(`installed snapshot matches the source (${relativeFiles.length} files)`);
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

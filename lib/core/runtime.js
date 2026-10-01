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
import { existsSync, readFileSync } from "node:fs";
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
 * @param start - a file or directory inside the installation.
 * @returns the absolute `…/@deepseek-ai/dsh/package.json`, or undefined.
 */
export function findDshPackage(start) {
	if (typeof start !== "string" || start.trim() === "") return undefined;
	let current = start;
	// A file points at its directory; a directory is used as is.
	if (/\.[cm]?js$|\.json$/.test(current)) current = dirname(current);
	for (let depth = 0; depth < 12; depth++) {
		const candidate = join(current, "node_modules", "@deepseek-ai", "dsh", "package.json");
		if (existsSync(candidate)) return candidate;
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
 * Identify the dsh runtime this process runs on.
 *
 * Candidate anchors, in order: the CLI entry (`process.argv[1]`, which is how `dsh web`
 * starts), this plugin's own module location, and the legacy profile-shared install that
 * pre-0.2 layouts used. The first one that resolves wins; an installation this plugin
 * cannot see reports `undefined` rather than guessing.
 * @returns `{ version, file, verified }`; every field is undefined when undiscovered.
 */
export function dshRuntime() {
	const starts = [];
	if (typeof process.argv?.[1] === "string") starts.push(process.argv[1]);
	try {
		starts.push(fileURLToPath(import.meta.url));
	} catch {
		/* an exotic loader can refuse URL conversion; the other anchors still apply */
	}
	starts.push(join(dshHome(), "profiles"));
	for (const start of starts) {
		const file = findDshPackage(start);
		if (file === undefined) continue;
		const version = versionOf(file);
		if (version === undefined) continue;
		return { version, file, verified: isVerifiedRuntime(version) };
	}
	return { version: undefined, file: undefined, verified: undefined };
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

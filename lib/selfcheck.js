// Self-checks the manager can run against ITSELF: the browser half's contract with
// the client module system, and the runtime wiring of this host process.
//
// Two real incidents motivate these checks (see D:\DSH\PLUGIN-DEV-CHECKLIST.md):
//   * a dsh upgrade renamed the client Remote accessor (`connection.api.*` →
//     `ctx.remote.*`) and the Settings page silently stopped loading data;
//   * a hand-written bundle missed the `module`/`exports` preamble and the page
//     failed to load with "exports is not defined".
// Neither is visible to the host until a browser hits the page, so `doctor` reports
// them where a human is already looking.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Package root: this file lives at <root>/lib/selfcheck.js. */
const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** Modules a client bundle may require without declaring them external. */
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

/** The `exports["./client"]` target, whether declared as a string or an object. */
function clientExport(pkg) {
	const entry = pkg.exports?.["./client"];
	if (typeof entry === "string") return entry;
	return entry?.default;
}

/**
 * Verify the browser half still satisfies the client module system's contract.
 * @returns `{ ok, problems: string[], notes: string[] }`
 */
export function checkClientContract() {
	const problems = [];
	const notes = [];

	let pkg;
	try {
		pkg = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8").replace(/^\uFEFF/, ""));
	} catch (error) {
		return { ok: false, problems: [`package.json unreadable: ${error.message}`], notes };
	}

	const declaration = pkg.dsh?.client;
	if (declaration === undefined) {
		notes.push("no dsh.client declaration (host-only package)");
		return { ok: true, problems, notes };
	}
	if (declaration.platform !== "web") {
		problems.push(`dsh.client.platform must be "web"; got ${JSON.stringify(declaration.platform)}`);
	}

	const relative = clientExport(pkg);
	if (relative === undefined) {
		problems.push('dsh.client is declared but exports["./client"] is missing');
		return { ok: problems.length === 0, problems, notes };
	}

	let text;
	try {
		text = readFileSync(join(PACKAGE_DIR, relative), "utf8");
	} catch (error) {
		problems.push(`client bundle unreadable (${relative}): ${error.message}`);
		return { ok: false, problems, notes };
	}

	const idMatch = /__ModuleLoader__\.load\(\{\s*id:\s*["']([^"']+)["']/.exec(text);
	if (idMatch === null) {
		problems.push(`client bundle is not a lazy-CJS factory package (${relative})`);
	} else {
		if (idMatch[1] !== pkg.name) {
			problems.push(`client bundle id "${idMatch[1]}" differs from the package name "${pkg.name}"`);
		}
		notes.push(`client bundle ${relative} announces id "${idMatch[1]}"`);
	}

	const usesCjs = /\bexports\.[A-Za-z_$]/.test(text) || /\bmodule\.exports\b/.test(text);
	const declaresCjs = /\b(?:var|let|const)\s+exports\b/.test(text) && /\b(?:var|let|const)\s+module\b/.test(text);
	if (usesCjs && !declaresCjs) {
		problems.push('client bundle assigns to exports without declaring "var module = { exports: {} }; var exports = module.exports;"');
	}

	const required = [...text.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]);
	const external = new Set(declaration.external ?? []);
	const undeclared = [...new Set(required)].filter(
		(moduleName) => !BASE_SEED.has(moduleName) && !external.has(moduleName) && !moduleName.startsWith("."),
	);
	if (undeclared.length > 0) {
		problems.push(`client bundle requires non-seed modules without declaring them external: ${undeclared.join(", ")}`);
	} else if (required.length > 0) {
		notes.push(`client bundle requires only allowed modules: ${[...new Set(required)].join(", ")}`);
	}

	return { ok: problems.length === 0, problems, notes };
}

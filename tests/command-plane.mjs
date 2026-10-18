// Command-plane end-to-end test on Windows: drive the REAL `/skill` handler.
//
// `tests/smoke.mjs` exercises the core modules directly. This file goes one level up and
// exercises what a human actually types: it calls `apply()` with a stub cordis context,
// captures the registered command definition, and invokes its handler for every
// subcommand and flag. The only thing stubbed is the host (commands service, logger,
// nested webServer injection); every code path below the handler is the shipped one.
//
// Everything runs against a scratch skill root through the documented environment seams,
// so the real deployment is never touched.
//
// Usage: node tests/command-plane.mjs
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "dsh-cmdplane-"));
const root = join(scratch, "skills");
const foreign = join(scratch, "agents-skills");
process.env.DSH_HOME = join(scratch, "dsh-home");
process.env.DSH_SKILL_MANAGER_SKILLS_ROOT = root;
process.env.DSH_SKILL_MANAGER_MANIFEST_FILE = join(root, ".manifest.json");
process.env.DSH_SKILL_MANAGER_HIDDEN_DIR = join(scratch, ".skill-disabled");
process.env.DSH_SKILL_MANAGER_BACKUPS_DIR = join(scratch, ".skill-backups");
process.env.DSH_SKILL_MANAGER_STAGING_DIR = join(scratch, "staging");
process.env.DSH_SKILL_MANAGER_FOREIGN_ROOTS = foreign;
mkdirSync(root, { recursive: true });

const { apply, name: pluginName, inject } = await import("../lib/index.js");
const { loadManifest } = await import("../lib/core/manifest.js");
const { hiddenZone, backupsDir } = await import("../lib/core/paths.js");

let passed = 0;
let failed = 0;
/**
 * Synchronous diagnostic line: `console.log` buffers on a pipe, so a process that aborts
 * loses everything it printed since the last flush. `fs.writeSync(1, …)` cannot be lost.
 */
function trace(message) {
	try {
		writeSync(1, `  ..   ${message}\n`);
	} catch {
		/* diagnostics must never break the run */
	}
}
function check(label, condition, detail = "") {
	if (condition) {
		passed += 1;
		console.log(`  ok   ${label}`);
		return;
	}
	failed += 1;
	console.log(`  FAIL ${label}${detail === "" ? "" : ` — ${detail}`}`);
}

/** Write one skill bundle fixture. */
function bundle(dir, skillName, description, { crlf = false } = {}) {
	mkdirSync(dir, { recursive: true });
	const eol = crlf ? "\r\n" : "\n";
	writeFileSync(
		join(dir, "SKILL.md"),
		["---", `name: ${skillName}`, `description: ${description}`, "---", "", "Body.", ""].join(eol),
		"utf8",
	);
	return dir;
}

// ---------------------------------------------------------------- stub host
// The catalog the host would report. It must never claim more than the disk holds: the
// list view trusts the managed root over the catalog, and a row the provider invents would
// be a phantom. `bundled-demo` is added when the migrate section needs a bundled row.
let catalogNames = [];
const fakeCtx = {
	commands: {
		register(definition) {
			fakeCtx.definition = definition;
			return () => {};
		},
	},
	skills: {
		async snapshot() {
			return {
				skills: catalogNames.map((entry) => ({
					name: entry,
					description: `${entry} description`,
					source: entry === "bundled-demo" ? "bundled" : "user-dsh",
				})),
				complete: true,
			};
		},
	},
	logger: { warn() {} },
	// No webServer in this profile: the nested injection must simply never fire.
	inject() {},
	effect() {
		return { dispose() {} };
	},
	get() {
		return undefined;
	},
};

console.log("host wiring");
apply(fakeCtx);
check("the plugin announces its name", pluginName === "dsh-skill-manager", pluginName);
check("the plugin declares the commands service", Array.isArray(inject) && inject.includes("commands"));
check("apply registered a command definition", fakeCtx.definition !== undefined);
check("the command is named /skill", fakeCtx.definition?.name === "skill");
check("it advertises an input hint", typeof fakeCtx.definition?.input?.hint === "string" && fakeCtx.definition.input.hint.includes("doctor"));
check("it records the raw input (so /skill list is auditable)", fakeCtx.definition?.recordInput === true);

/** Run one `/skill ...` invocation exactly as the dispatcher would. */
const run = (rawInput) =>
	fakeCtx.definition.handler({
		commandId: "cmd-1",
		agent: { id: "agent-1", session: { header: { cwd: scratch } } },
		rawInput,
		attachments: [],
		signal: new AbortController().signal,
	});

// ---------------------------------------------------------------- list / search
console.log("\nlist and search");
{
	const empty = await run("list");
	check("an empty root reports so", empty.kind === "success" && /no skills installed/.test(empty.text), empty.text);

	const alpha = bundle(join(scratch, "incoming", "alpha-one"), "alpha-one", "First command-plane skill", { crlf: true });
	const installed = await run(`install ${alpha}`);
	check("install succeeds from a local path", installed.kind === "success", installed.text);
	check("install reports the name and ref", /installed "alpha-one"/.test(installed.text), installed.text);
	check("the bundle landed in the managed root", existsSync(join(root, "alpha-one", "SKILL.md")));
	check("the ledger records it", loadManifest().skills["alpha-one"] !== undefined);
	catalogNames = ["alpha-one"];

	const listed = await run("list");
	check("list shows the installed skill", /alpha-one/.test(listed.text));
	check("list marks it visible to the model", /目录可见 in-catalog/.test(listed.text), listed.text);
	check("list shows a CRLF skill's description intact", /First command-plane skill/.test(listed.text));

	const found = await run("search command-plane");
	check("search matches the description", found.kind === "success" && /alpha-one/.test(found.text), found.text);
	const none = await run("search zzz-nothing");
	check("search reports zero matches without failing", none.kind === "success" && /matches: 0/.test(none.text), none.text);
	const noQuery = await run("search");
	check("search without a query is an error with usage", noQuery.kind === "error" && /usage/i.test(noQuery.text));
}

// ---------------------------------------------------------------- disable / enable
console.log("\ndisable and enable (same-volume rename on NTFS)");
{
	const off = await run("disable alpha-one");
	check("disable succeeds", off.kind === "success", off.text);
	check("the entry moved into the hidden zone", existsSync(join(hiddenZone(), "alpha-one", "SKILL.md")));
	check("the managed root no longer holds it", !existsSync(join(root, "alpha-one")));
	check("the ledger says disabled", loadManifest().skills["alpha-one"]?.state === "disabled");

	const listedOff = await run("list");
	check("list marks it disabled", /alpha-one/.test(listedOff.text) && /已禁用 disabled/.test(listedOff.text), listedOff.text);

	const again = await run("disable alpha-one");
	check("disabling twice is an idempotent no-op, not a failure", again.kind === "success" && /already disabled/.test(again.text), again.text);

	const on = await run("enable alpha-one");
	check("enable succeeds", on.kind === "success", on.text);
	check("the entry is back in the managed root", existsSync(join(root, "alpha-one", "SKILL.md")));
	check("the hidden zone is empty again", readdirSync(hiddenZone()).length === 0, readdirSync(hiddenZone()).join(", "));
	check("the ledger says enabled", loadManifest().skills["alpha-one"]?.state === "enabled");
}

// ---------------------------------------------------------------- verify / remove
console.log("\nverify and remove");
{
	const clean = await run("verify alpha-one");
	check("verify reports a clean skill", clean.kind === "success" && /clean/.test(clean.text), clean.text);

	writeFileSync(join(root, "alpha-one", "SKILL.md"), readFileSync(join(root, "alpha-one", "SKILL.md"), "utf8") + "\ntampered\n", "utf8");
	const dirty = await run("verify alpha-one");
	check("verify reports the modification", dirty.kind === "success" && /modified=1/.test(dirty.text), dirty.text);

	const removed = await run("remove alpha-one");
	check("remove succeeds", removed.kind === "success", removed.text);
	check("remove left a backup", readdirSync(backupsDir()).length > 0, readdirSync(backupsDir()).join(", "));
	check("the skill is gone from the managed root", !existsSync(join(root, "alpha-one")));
	check("the ledger dropped the entry", loadManifest().skills["alpha-one"] === undefined);

	const missing = await run("remove alpha-one");
	check("removing a missing skill is an error, not a crash", missing.kind === "error", missing.text);
}

// ---------------------------------------------------------------- install variants
console.log("\ninstall variants (spaces, unicode path, --force)");
{
	// A source directory whose path contains a space and Chinese characters. The spec is
	// quoted because that is the only way one token can carry a space; unquoted it splits
	// into several positionals (Windows user directories look exactly like this).
	//
	// The `trace` markers below are synchronous writes to fd 1: this section once died on a
	// Windows CI runner with exit 127 and NO error text, and buffered console output is lost
	// when a process aborts.
	trace(`env: node ${process.version} ${process.platform}/${process.arch} tmp=${tmpdir()}`);

	// A source path containing a SPACE is the case quoting exists for, and it works
	// everywhere. A path containing non-ASCII characters is additionally guarded: Node 22 on
	// Windows aborts inside fs.cpSync for such paths (upstream bug), so the manager refuses
	// that combination with a message instead of taking the host down with it.
	const copySurvivesNonAscii = !(process.platform === "win32" && Number(process.versions.node.split(".")[0]) === 22);

	trace("step: create fixture with a spaced parent path");
	const spaced = bundle(join(scratch, "incoming dir", "plain package"), "spaced-path", "Installed from a spaced parent path");
	trace(`step: fixture created, exists=${existsSync(spaced)}`);
	trace("step: quoted install (space only)");
	const quotedInstall = await run(`install "${spaced}"`);
	trace(`step: quoted install -> ${quotedInstall.kind}`);
	check("install handles a QUOTED path containing a space", quotedInstall.kind === "success", quotedInstall.text);
	check("the bundle landed", existsSync(join(root, "spaced-path", "SKILL.md")));
	// The same spec unquoted must not silently install something else: it splits, so the
	// first positional is a truncated path and the failure names that path.
	const unquoted = await run(`install ${spaced}`);
	check(
		"an unquoted spaced path fails loudly instead of installing the wrong thing",
		unquoted.kind === "error" && !existsSync(join(root, "incoming")),
		unquoted.text,
	);

	trace("step: create fixture with a spaced + CJK parent path");
	const cjk = bundle(join(scratch, "incoming dir", "技能 包"), "cjk-path", "Installed from a spaced unicode path");
	trace(`step: fixture created, exists=${existsSync(cjk)}, skillFile=${existsSync(join(cjk, "SKILL.md"))}`);
	trace("step: quoted install (space + CJK)");
	const cjkInstall = await run(`install "${cjk}"`);
	trace(`step: quoted install -> ${cjkInstall.kind}`);
	if (copySurvivesNonAscii) {
		check("install handles a QUOTED path with spaces and CJK characters", cjkInstall.kind === "success", cjkInstall.text);
		check("the CJK-sourced bundle landed", existsSync(join(root, "cjk-path", "SKILL.md")));
	} else {
		// Refused, not crashed: the guard exists precisely so the host survives this.
		check(
			"Node 22 on Windows REFUSES a non-ASCII copy instead of crashing the process",
			cjkInstall.kind === "error" && /non-ASCII|ASCII/.test(cjkInstall.text),
			cjkInstall.text,
		);
		check("the refused CJK install wrote nothing", !existsSync(join(root, "cjk-path")));
	}

	const replacement = bundle(join(scratch, "incoming", "spaced-path-v2"), "spaced-path", "Replaced via --force");
	const forced = await run(`install ${replacement} --force`);
	check("install --force replaces an existing skill", forced.kind === "success", forced.text);
	check("the new description is live", /Replaced via --force/.test(readFileSync(join(root, "spaced-path", "SKILL.md"), "utf8")));
	check("the replaced version went to the backup area", readdirSync(backupsDir()).length > 0);

	const conflict = bundle(join(scratch, "incoming", "spaced-conflict"), "spaced-path", "Should be refused");
	const refused = await run(`install ${conflict}`);
	check("installing over an existing name without --force is refused", refused.kind === "error", refused.text);

	const bad = await run("install D:/definitely/not/a/skill");
	check("install from a bad path fails cleanly", bad.kind === "error", bad.text);
	const noSpec = await run("install");
	check("install without a spec prints usage", noSpec.kind === "error" && /usage/i.test(noSpec.text));
}

// ---------------------------------------------------------------- adopt
console.log("\nadopt (untracked skill already in the root)");
{
	const dir = bundle(join(root, "adopt-me"), "adopt-me", "Sitting in the root untracked");
	const adopted = await run("adopt adopt-me --source https://example.com/adopt-me");
	check("adopt succeeds", adopted.kind === "success", adopted.text);
	check("the ledger now records it", loadManifest().skills["adopt-me"]?.source === "https://example.com/adopt-me");
	const listed = await run("list");
	check("the adopted skill is no longer flagged untracked", !/adopt-me.*未入账 untracked/.test(listed.text), listed.text);
	check("the fixture directory exists", existsSync(dir));
}

// ---------------------------------------------------------------- migrate
console.log("\nmigrate (foreign root, dry run, non-migratable)");
{
	const outsider = bundle(join(foreign, "outsider"), "outsider", "Published from the agents root");
	const dry = await run("migrate outsider --dry-run");
	check("dry run previews without moving", dry.kind === "success" && /would migrate/.test(dry.text) && existsSync(join(outsider, "SKILL.md")), dry.text);

	const moved = await run("migrate outsider");
	check("migrate moves the skill", moved.kind === "success", moved.text);
	check("it now lives in the managed root", existsSync(join(root, "outsider", "SKILL.md")));
	check("the source is gone", !existsSync(join(foreign, "outsider")));
	check("the ledger records the origin", String(loadManifest().skills.outsider?.migratedFrom ?? "").includes("agents-skills"));

	const batch = await run("migrate");
	check("batch migrate succeeds when nothing is left", batch.kind === "success" && /migrated: 0\/0/.test(batch.text), batch.text);

	// The bundled skill is read-only for a different reason: no rename can move it, and the
	// answer must say so instead of "not found in <foreign root>".
	catalogNames = [...catalogNames, "bundled-demo"];
	const bundled = await run("migrate bundled-demo");
	check("migrating a bundled skill is refused", bundled.kind === "error", bundled.text);
	check(
		"the refusal names the provider root instead of 'not found'",
		/由 bundled 提供/.test(bundled.text) && !/no migratable skill/.test(bundled.text),
		bundled.text,
	);
	const unknown = await run("migrate no-such-skill");
	check("migrating an unknown skill says so", unknown.kind === "error" && /no such skill/.test(unknown.text), unknown.text);
}

// ---------------------------------------------------------------- doctor
console.log("\ndoctor");
{
	const report = await run("doctor");
	const text = report.text ?? "";
	check("doctor succeeds", report.kind === "success");
	check("doctor reports the root", /skill root: .* exists/.test(text));
	check("doctor reports the hidden zone", /hidden zone: .*/.test(text));
	check("doctor reports wiring", /wiring: commands=ok/.test(text), text);
	check("doctor does not claim routes in a headless profile", /routes=n\/a \(no web server\)/.test(text), text);
	check("doctor reports the client half", /client half: ok/.test(text));
	check("doctor reports the catalog query", /catalog query: \d+ entries, complete/.test(text));
	check("doctor reports the dsh runtime it found", /dsh runtime: \S+/.test(text), text);
	check("doctor counts the ledger", /manifest: .* \(\d+ tracked\)/.test(text));
}

// ---------------------------------------------------------------- misc / errors
console.log("\nunknown input");
{
	const unknown = await run("frobnicate");
	check("an unknown subcommand returns usage as an error", unknown.kind === "error" && /usage/i.test(unknown.text));
	const flagsOnly = await run("--force");
	check("a flag with no subcommand falls back to list", flagsOnly.kind === "success" && /skills:/.test(flagsOnly.text), flagsOnly.text);
}

console.log("\nargument tokenizer (quoted specs)");
{
	const { tokenizeInput } = await import("../lib/index.js");
	const plain = tokenizeInput("list");
	check("a bare word is one token", plain.length === 1 && plain[0] === "list");
	const quoted = tokenizeInput('install "C:\\my skills\\x" --force');
	check("a quoted path stays one token", quoted.length === 3 && quoted[1] === "C:\\my skills\\x", JSON.stringify(quoted));
	check("flags survive alongside quotes", quoted[2] === "--force");
	const single = tokenizeInput("adopt x --source 'https://e.com/a b'");
	check("single quotes group a token too", single[3] === "https://e.com/a b", JSON.stringify(single));
	const empty = tokenizeInput("   ");
	check("blank input yields no tokens", empty.length === 0);
	const trailing = tokenizeInput('install "unterminated');
	check("an unterminated quote keeps the rest", trailing.length === 2 && trailing[1] === "unterminated", JSON.stringify(trailing));
	check("backslashes are not escapes", tokenizeInput("install C:\\a\\b")[1] === "C:\\a\\b");
}

console.log(`\n${passed} passed, ${failed} failed`);
console.log(`scratch: ${scratch}`);
if (failed > 0) process.exit(1);

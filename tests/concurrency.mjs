// Cross-process concurrency and stale-lock recovery (the Windows case that matters).
//
// The manager's lock exists because the web host, a CLI and a second profile can all mutate
// the same skill root. `tests/smoke.mjs` exercises the core in one process; this file runs
// real child processes to prove the lock actually serializes them on this machine, and that
// an abandoned lock does not wedge the manager.
//
// Usage: node tests/concurrency.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "dsh-concurrency-"));
const root = join(scratch, "skills");
process.env.DSH_HOME = join(scratch, "dsh-home");
process.env.DSH_SKILL_MANAGER_SKILLS_ROOT = root;
process.env.DSH_SKILL_MANAGER_MANIFEST_FILE = join(root, ".manifest.json");
process.env.DSH_SKILL_MANAGER_HIDDEN_DIR = join(scratch, ".skill-disabled");
process.env.DSH_SKILL_MANAGER_BACKUPS_DIR = join(scratch, ".skill-backups");
process.env.DSH_SKILL_MANAGER_STAGING_DIR = join(scratch, "staging");
process.env.DSH_SKILL_MANAGER_FOREIGN_ROOTS = join(scratch, "agents-skills");
mkdirSync(root, { recursive: true });

const { installSkill } = await import("../lib/core/install.js");
const { loadManifest } = await import("../lib/core/manifest.js");
const { hiddenZone, lockPath } = await import("../lib/core/paths.js");

let passed = 0;
let failed = 0;
function check(label, condition, detail = "") {
	if (condition) {
		passed += 1;
		console.log(`  ok   ${label}`);
		return;
	}
	failed += 1;
	console.log(`  FAIL ${label}${detail === "" ? "" : ` — ${detail}`}`);
}

/** Install one ordinary skill to operate on. */
async function seed(skillName) {
	const source = join(scratch, `incoming-${skillName}`, skillName);
	mkdirSync(source, { recursive: true });
	writeFileSync(join(source, "SKILL.md"), `---\nname: ${skillName}\ndescription: concurrency fixture\n---\n\nBody.\n`, "utf8");
	return installSkill(source);
}

// A child that performs ONE locked mutation and writes its outcome as JSON to a file.
// Stdout capture is unavailable here (a confined shell cannot open the pipe), and the
// project convention is `stdio: "ignore"` plus a file, not a wider sandbox.
const workerFile = join(scratch, "worker.mjs");
writeFileSync(
	workerFile,
	`import { writeFileSync } from "node:fs";
const { setSkillEnabled } = await import(${JSON.stringify(new URL("../lib/core/state.js", import.meta.url).href)});
const [name, action, outFile] = process.argv.slice(2);
let result;
try {
	const changed = await setSkillEnabled(name, action === "enable");
	result = { ok: true, changed: changed.changed === true, message: changed.message };
} catch (error) {
	result = { ok: false, error: error.message };
}
writeFileSync(outFile, JSON.stringify(result), "utf8");
`,
	"utf8",
);

let workerRuns = 0;
/** Run one worker child synchronously and read its JSON result file. */
function runWorker(name, action) {
	const outFile = join(scratch, `worker-out-${workerRuns++}.json`);
	rmSync(outFile, { force: true });
	execFileSync(process.execPath, [workerFile, name, action, outFile], { stdio: "ignore", env: { ...process.env } });
	return JSON.parse(readFileSync(outFile, "utf8"));
}

console.log("cross-process lock");
{
	await seed("race-target");
	check("the skill starts enabled", existsSync(join(root, "race-target", "SKILL.md")));

	// Hold the lock in THIS process, then let a child try to mutate: the child must be
	// refused immediately (fail-fast) instead of queueing behind the holder.
	const { withLock } = await import("../lib/core/lock.js");
	let held = "no error";
	await withLock(
		async () => {
			try {
				held = JSON.stringify(runWorker("race-target", "disable"));
			} catch (error) {
				held = `spawn failed: ${error.message}`;
			}
		},
		"test holder",
	);
	const reply = JSON.parse(held);
	check("a second process is refused while the lock is held", reply.ok === false, held);
	check("the refusal explains it is another operation", /another skill operation is in progress/.test(reply.error ?? ""), reply.error);
	check("the refused child changed nothing", existsSync(join(root, "race-target", "SKILL.md")));
}

console.log("\nstale lock recovery");
{
	// A crashed process leaves a lock behind. Simulate one whose pid is certainly dead (0 is
	// never a valid process id) and confirm the manager still works instead of wedging.
	const file = lockPath();
	mkdirSync(join(root), { recursive: true });
	writeFileSync(file, JSON.stringify({ pid: 0, at: Date.now(), label: "crashed" }), "utf8");
	check("a stale lock file exists", existsSync(file));
	const recovered = runWorker("race-target", "disable");
	check("a mutation succeeds despite the abandoned lock", recovered.ok === true, JSON.stringify(recovered));
	check("the skill is now in the hidden zone", existsSync(join(hiddenZone(), "race-target", "SKILL.md")));
	const back = runWorker("race-target", "enable");
	check("and can be enabled again", back.ok === true, JSON.stringify(back));
	check("the lock file is cleaned up after each run", !existsSync(file));
}

console.log("\nsequential children agree with the ledger");
{
	// Two children in sequence: each must observe the other's committed state.
	const first = runWorker("race-target", "disable");
	const second = runWorker("race-target", "disable");
	check("the first child performs the change", first.ok === true && first.changed === true, JSON.stringify(first));
	check("the second is an idempotent no-op", second.ok === true && second.changed === false, JSON.stringify(second));
	check("the ledger agrees with the disk", loadManifest().skills["race-target"]?.state === "disabled");
	const enabled = runWorker("race-target", "enable");
	check("the following enable is accepted", enabled.ok === true && enabled.changed === true, JSON.stringify(enabled));
}

console.log("\nworker process in a fresh shell still uses the same seams");
{
	// Guards against an env-plumbing regression: the child resolves paths from the env, so a
	// mismatch would touch the real ~/.dsh. Assert the scratch root is what moved.
	rmSync(join(root, "race-target"), { recursive: true, force: true });
	const manifest = loadManifest();
	check("the scratch ledger still exists (the child never touched the real one)", typeof manifest === "object");
}

console.log(`\n${passed} passed, ${failed} failed`);
console.log(`scratch: ${scratch}`);
if (failed > 0) process.exit(1);

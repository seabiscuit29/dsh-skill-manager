// Offline smoke test for the manager core.
//
// Everything runs against a scratch skill root via the documented environment
// seams, so the real deployment is never touched:
//   DSH_SKILL_MANAGER_SKILLS_ROOT / DSH_SKILL_MANAGER_MANIFEST_FILE
//
// Usage: node tests/smoke.mjs
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "dsh-smoke-"));
const root = join(scratch, "skills");
process.env.DSH_SKILL_MANAGER_SKILLS_ROOT = root;
process.env.DSH_SKILL_MANAGER_MANIFEST_FILE = join(root, ".manifest.json");
process.env.DSH_SKILL_MANAGER_HIDDEN_DIR = join(scratch, ".skill-disabled");
process.env.DSH_SKILL_MANAGER_BACKUPS_DIR = join(scratch, ".skill-backups");
process.env.DSH_SKILL_MANAGER_STAGING_DIR = join(scratch, "staging");
// Foreign roots must be redirected too: the migration tests would otherwise touch
// the real ~/.agents/skills of whoever runs them.
process.env.DSH_SKILL_MANAGER_FOREIGN_ROOTS = join(scratch, "agents-skills");

const { buildDoctor, buildRows } = await import("../lib/core/scan.js");
const { setSkillEnabled, adoptSkill } = await import("../lib/core/state.js");
const { installSkill, removeSkill, verifySkill } = await import("../lib/core/install.js");
const { parseSourceSpec } = await import("../lib/core/source.js");
const { loadManifest } = await import("../lib/core/manifest.js");
const { validateSkill } = await import("../lib/core/validate.js");
const { hiddenZone, backupsDir } = await import("../lib/core/paths.js");
const { migrateAll, migrateSkill, scanMigratable } = await import("../lib/core/migrate.js");

let passed = 0;
let failed = 0;
/** One assertion with a readable report line. */
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
function bundle(name, frontmatter, body = "Instructions.\n") {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}`, "utf8");
	return dir;
}

console.log("fixtures");
mkdirSync(root, { recursive: true });
bundle("alpha", "name: alpha\ndescription: Alpha bundle skill");
writeFileSync(join(root, "beta.md"), "---\nname: beta\ndescription: Beta flat skill\n---\n\nBody\n", "utf8");
bundle("Broken-Dir", "name: Broken\ndescription: invalid name on purpose");
bundle("legacy", "name: legacy\ndescription: legacy key\ndisableModelInvocation: true");

console.log("\nsource specs");
{
	const github = parseSourceSpec("github:mattpocock/skills#main/skills/productivity/grilling");
	check("github shorthand parses", github.ok && github.spec.kind === "github", JSON.stringify(github));
	check("github default path empty", github.ok && github.spec.path === "skills/productivity/grilling");
	check("github url rewritten", github.ok && github.spec.url === "https://github.com/mattpocock/skills.git");

	const bare = parseSourceSpec("github:owner/repo");
	check("missing ref defaults to main", bare.ok && bare.spec.ref === "main");

	const url = parseSourceSpec("https://example.com/x.git#v1/sub/dir");
	check("git url keeps fragment path", url.ok && url.spec.kind === "git-url" && url.spec.ref === "v1" && url.spec.path === "sub/dir");
	check("git url stripped of fragment", url.ok && !url.spec.url.includes("#"));

	const local = parseSourceSpec(root);
	check("existing local path parses", local.ok && local.spec.kind === "local");
	const missing = parseSourceSpec(join(scratch, "nope"));
	check("missing local path is rejected", !missing.ok && /does not exist/.test(missing.error));
	check("empty spec is rejected", !parseSourceSpec("   ").ok);
}

console.log("\nvalidation mirrors the provider");
{
	check("valid bundle passes", validateSkill(join(root, "alpha")).ok);
	check("valid flat passes", validateSkill(join(root, "beta.md")).ok);
	const broken = validateSkill(join(root, "Broken-Dir"));
	check("camelCase/invalid name rejected", !broken.ok && broken.errors.some((error) => error.rule === "name"));
	const legacy = validateSkill(join(root, "legacy"));
	check(
		"legacy invocation key rejected with canonical hint",
		!legacy.ok && legacy.errors.some((error) => error.rule === "invocation-key" && /disable-model-invocation/.test(error.message)),
	);
}

console.log("\nlist view");
{
	const view = buildRows();
	check("all four entries are listed", view.rows.length === 4, view.rows.map((row) => row.name).join(","));
	const alpha = view.rows.find((row) => row.name === "alpha");
	check("bundle recognised", alpha?.form === "bundle" && alpha?.state === "enabled");
	check("untracked before adopt", alpha?.tracked === false);
	const broken = view.rows.find((row) => row.diskName === "Broken-Dir");
	check("invalid frontmatter flagged", broken?.valid === false);
}

console.log("\ncross-root catalog rows");
{
	const view = buildRows({
		catalog: [
			{
				name: "external-one",
				description: "Published from another root",
				invocation: { modelInvocable: true, userInvocable: true },
				source: "user-agents",
				resourceBase: { kind: "directory", path: "/somewhere/external-one" },
			},
			{ name: "alpha", description: "duplicate of a managed skill", invocation: { modelInvocable: true, userInvocable: true }, source: "user-dsh" },
		],
	});
	const external = view.rows.find((row) => row.name === "external-one");
	check("catalog-only skill is listed read-only", external?.managed === false && external?.state === "enabled");
	check("its provider root is kept", external?.providerSource === "user-agents");
	check("a duplicate catalog entry does not shadow the managed row", view.rows.find((row) => row.name === "alpha")?.managed === true);
}

console.log("\nadopt + verify");
{
	const adopted = await adoptSkill("beta");
	check("adopt records the skill", adopted.ok && loadManifest().skills.beta !== undefined);
	const verified = verifySkill("beta");
	check("verify reports clean", verified.ok && verified.clean === true, JSON.stringify(verified));
	writeFileSync(join(root, "beta.md"), "---\nname: beta\ndescription: Beta flat skill\n---\n\nTampered\n", "utf8");
	const dirty = verifySkill("beta");
	check("verify detects a modified file", dirty.ok && dirty.clean === false && dirty.modified.length === 1);
}

console.log("\ndisable / enable");
{
	const disabled = await setSkillEnabled("alpha", false);
	check("disable reports the move", disabled.ok && disabled.changed === true);
	check("live copy gone", !existsSync(join(root, "alpha")));
	check("hidden copy present", existsSync(join(hiddenZone(), "alpha", "SKILL.md")));
	check("manifest marks it disabled", loadManifest().skills.alpha.state === "disabled");
	const rows = buildRows().rows;
	check("row reports disabled", rows.find((row) => row.name === "alpha")?.state === "disabled");

	const again = await setSkillEnabled("alpha", false);
	check("disable is idempotent", again.ok && again.changed === false);

	const enabled = await setSkillEnabled("alpha", true);
	check("enable moves it back", enabled.ok && existsSync(join(root, "alpha", "SKILL.md")));
	check("hidden copy gone", !existsSync(join(hiddenZone(), "alpha")));
}

console.log("\ninstall");
{
	const source = join(scratch, "incoming", "gamma");
	mkdirSync(source, { recursive: true });
	writeFileSync(join(source, "SKILL.md"), "---\nname: gamma\ndescription: Gamma from a local source\n---\n\nBody\n", "utf8");

	const installed = await installSkill(source);
	check("local install succeeds", installed.ok && installed.skipped === false, JSON.stringify(installed));
	check("placed under its frontmatter name", existsSync(join(root, "gamma", "SKILL.md")));
	check("ledger records the source", loadManifest().skills.gamma?.source !== null);

	const again = await installSkill(source);
	check("same source is idempotent", again.ok && again.skipped === true);

	const other = join(scratch, "incoming", "gamma2");
	mkdirSync(other, { recursive: true });
	writeFileSync(join(other, "SKILL.md"), "---\nname: gamma\ndescription: A different gamma\n---\n\nBody\n", "utf8");
	let conflict = "no error";
	try {
		await installSkill(other);
	} catch (error) {
		conflict = error.message;
	}
	check("same name from another source is refused", /already installed/.test(conflict), conflict);

	const forced = await installSkill(other, { force: true });
	check("--force replaces it and keeps a backup", forced.ok && existsSync(backupsDir()));
}

console.log("\nremove");
{
	const removed = await removeSkill("alpha");
	check("remove reports a backup path", removed.ok && existsSync(removed.backupPath), JSON.stringify(removed));
	check("live copy gone", !existsSync(join(root, "alpha")));
	check("ledger entry gone", loadManifest().skills.alpha === undefined);
	check("skill no longer listed", !buildRows().rows.some((row) => row.name === "alpha"));

	const untracked = buildRows().rows.find((row) => !row.tracked);
	if (untracked !== undefined) {
		let guarded = "no error";
		try {
			await removeSkill(untracked.name);
		} catch (error) {
			guarded = error.message;
		}
		check("untracked removal needs --force", /--force/.test(guarded), guarded);
	}
}

console.log("\nmigration from another root");
{
	const foreign = process.env.DSH_SKILL_MANAGER_FOREIGN_ROOTS;
	mkdirSync(join(foreign, "outsider"), { recursive: true });
	writeFileSync(
		join(foreign, "outsider", "SKILL.md"),
		"---\nname: outsider\ndescription: Lives in another root\n---\n\nBody\n",
		"utf8",
	);
	mkdirSync(join(foreign, "BrokenOutsider"), { recursive: true });
	writeFileSync(
		join(foreign, "BrokenOutsider", "SKILL.md"),
		"---\nname: BrokenOutsider\ndescription: bad name on purpose\n---\n\nBody\n",
		"utf8",
	);
	// A foreign skill whose name already exists in the managed root must be blocked,
	// never silently shadowed or overwritten.
	mkdirSync(join(foreign, "beta-collision"), { recursive: true });
	writeFileSync(
		join(foreign, "beta-collision", "SKILL.md"),
		"---\nname: beta\ndescription: collides with a managed skill\n---\n\nBody\n",
		"utf8",
	);

	const scan = scanMigratable();
	check("scan finds the migratable skill", scan.candidates.some((entry) => entry.name === "outsider"));
	check("scan reports the invalid one as blocked", scan.blocked.some((entry) => entry.name === "BrokenOutsider"));
	check(
		"scan reports a name collision as blocked",
		scan.blocked.some((entry) => entry.name === "beta" && /already present/.test(entry.reason)),
	);

	// Regression: other-root skills must be listed even when the registry catalog is
	// unavailable — depending on `ctx.skills.list()` alone silently hid them once.
	const withoutCatalog = buildRows({ catalog: undefined });
	const foreignRow = withoutCatalog.rows.find((entry) => entry.name === "outsider");
	check("a foreign-root skill is listed without any catalog", foreignRow !== undefined);
	check("it is read-only there", foreignRow?.managed === false && foreignRow?.state === "enabled");
	check("it names its root", /agents-skills/.test(foreignRow?.providerSource ?? ""), foreignRow?.providerSource);
	check(
		"an invalid foreign skill is listed but flagged",
		withoutCatalog.rows.find((entry) => entry.name === "BrokenOutsider")?.valid === false,
	);
	check(
		"a foreign duplicate does not shadow the managed row",
		withoutCatalog.rows.filter((entry) => entry.name === "beta").length === 1 &&
			withoutCatalog.rows.find((entry) => entry.name === "beta")?.managed === true,
	);

	const dry = await migrateAll({ dryRun: true });
	check("dry run moves nothing", dry.dryRun === true && existsSync(join(foreign, "outsider", "SKILL.md")));
	check("dry run still lists the candidate", dry.moved.some((entry) => entry.name === "outsider"));

	const moved = await migrateSkill("outsider");
	check(
		"migration reports both ends",
		moved.ok && moved.from.includes("agents-skills") && moved.to.startsWith(root),
		JSON.stringify(moved),
	);
	check("the source copy is gone", !existsSync(join(foreign, "outsider")));
	check("the skill now lives in the managed root", existsSync(join(root, "outsider", "SKILL.md")));
	check(
		"the ledger records the migration origin",
		loadManifest().skills.outsider?.migratedFrom?.includes("agents-skills") === true,
	);

	const row = buildRows().rows.find((entry) => entry.name === "outsider");
	check("a migrated skill is managed", row?.managed === true && row?.tracked === true && row?.state === "enabled");

	await setSkillEnabled("outsider", false);
	check("a migrated skill can be disabled", buildRows().rows.find((entry) => entry.name === "outsider")?.state === "disabled");
	await setSkillEnabled("outsider", true);

	let blocked = "no error";
	try {
		await migrateSkill("BrokenOutsider");
	} catch (error) {
		blocked = error.message;
	}
	check("migrating an invalid skill is refused", /cannot be migrated/.test(blocked), blocked);
}

console.log("\nself checks");
{
	const { checkClientContract } = await import("../lib/selfcheck.js");
	const contract = checkClientContract();
	check("client contract self-check passes on this package", contract.ok === true, contract.problems.join("; "));
	check("self-check reports the bundle it inspected", contract.notes.some((note) => /client bundle/.test(note)));
}

console.log("\ndoctor");
{
	const report = buildDoctor();
	check("doctor sees the root", report.rootExists === true);
	check("doctor counts hidden skills", typeof report.hiddenCount === "number");
	check("doctor surfaces untracked skills", Array.isArray(report.untracked));
}

console.log(`\n${passed} passed, ${failed} failed`);
console.log(`scratch: ${scratch}`);
if (failed > 0) {
	console.log(readFileSync(join(scratch, "skills", ".manifest.json"), "utf8"));
	process.exit(1);
}

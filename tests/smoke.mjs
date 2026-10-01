// Offline smoke test for the manager core.
//
// Everything runs against a scratch skill root via the documented environment
// seams, so the real deployment is never touched:
//   DSH_SKILL_MANAGER_SKILLS_ROOT / DSH_SKILL_MANAGER_MANIFEST_FILE
//
// Usage: node tests/smoke.mjs
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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
const { observeCatalog, catalogUsable } = await import("../lib/core/catalog.js");
const { formatRows } = await import("../lib/core/report.js");

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

console.log("\nsymlinked entries (the macOS 'symlink my checkout in' case)");
{
	// A symlinked skill IS published: the provider lists entries with `stat` semantics
	// (`dsh-fs-local` types a child by what the link points at), so the manager must
	// report it as a working skill — telling a user their live skill is invisible is
	// worse than saying nothing. Only a link whose target is gone is unpublished, and
	// that one must be called out loudly.
	// The link points OUTSIDE the managed root, exactly like a symlinked dev checkout:
	// a target inside the root would legitimately appear twice under one frontmatter name.
	const target = join(scratch, "dev", "linked-target");
	mkdirSync(target, { recursive: true });
	writeFileSync(
		join(target, "SKILL.md"),
		"---\nname: linked-target\ndescription: Real bundle behind a link\n---\n\nBody\n",
		"utf8",
	);
	const link = join(root, "linked-skill");
	let created = false;
	try {
		symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
		created = true;
	} catch {
		// Creating a link can be denied (Windows without developer mode); skip politely.
		console.log("  skip  link creation is not permitted on this machine");
	}
	if (created) {
		const row = buildRows().rows.find((entry) => entry.diskName === "linked-skill");
		check("a symlinked entry is listed", row !== undefined);
		check("a live link keeps its real form (bundle)", row?.form === "bundle");
		check("it is flagged as a symlink", row?.symlink === true);
		check("it is NOT flagged as broken", row?.brokenSymlink === false);
		check(
			"its note says the provider follows it",
			/follows it with stat semantics/.test((row?.notes ?? []).join(" ")),
		);
		check("it is not marked invalid frontmatter", row?.valid === true);
		check("doctor lists it as a followed symlink", buildDoctor().symlinked.includes("linked-target"));
		check("doctor does not call it broken", !buildDoctor().brokenSymlinks.includes("linked-target"));

		// The unpublished case is the one that must be surfaced: a link whose target is gone.
		const dangling = join(root, "dangling-skill");
		let danglingCreated = false;
		try {
			symlinkSync(join(scratch, "dev", "does-not-exist"), dangling, process.platform === "win32" ? "junction" : "dir");
			danglingCreated = true;
		} catch {
			console.log("  skip  dangling link creation is not permitted on this machine");
		}
		if (danglingCreated) {
			const broken = buildRows().rows.find((entry) => entry.diskName === "dangling-skill");
			check("a dangling link is surfaced", broken !== undefined);
			check("a dangling link is flagged broken", broken?.brokenSymlink === true);
			check("a dangling link is flagged as a symlink", broken?.symlink === true);
			check(
				"its note explains the provider never publishes it",
				/never publishes this entry/.test((broken?.notes ?? []).join(" ")),
			);
			check("doctor reports it as broken", buildDoctor().brokenSymlinks.includes("dangling-skill"));
		}
	}
}

console.log("\nprofile patch cleaner (shared by both installers)");
{
	// tools/profile-patch-clean.mjs is what both swap-profile.ps1 and swap-profile.sh call,
	// so its block matching is worth asserting directly.
	const { execFileSync } = await import("node:child_process");
	const { fileURLToPath } = await import("node:url");
	const { dirname } = await import("node:path");
	const repo = dirname(dirname(fileURLToPath(import.meta.url)));
	const patchFile = join(scratch, "cordis.patch.yml");
	writeFileSync(
		patchFile,
		[
			"# profile patch",
			"- insert:",
			"    - id: keep-me",
			"      name: '@deepseek-ai/dsh-mcp-client'",
			"",
			"- insert:",
			"    - id: retire-me",
			"      name: '@deepseek-ai/dsh-skill-manager'",
			"",
		].join("\n"),
		"utf8",
	);
	// stdio "ignore" on purpose: the assertion is about files and exit status, and
	// capturing a child's output through pipes is blocked in restricted sandboxes.
	execFileSync("node", [join(repo, "tools", "profile-patch-clean.mjs"), "--patch", patchFile, "--remove", "@deepseek-ai/dsh-skill-manager"], {
		stdio: "ignore",
	});
	const cleaned = readFileSync(patchFile, "utf8");
	check("the retired insert is gone", !cleaned.includes("retire-me"));
	check("the other insert survives", cleaned.includes("keep-me"));

	let refused = "no error";
	try {
		execFileSync("node", [join(repo, "tools", "profile-patch-clean.mjs"), "--patch", patchFile, "--remove", "@deepseek-ai/dsh-mcp-client"], {
			stdio: "ignore",
		});
	} catch (error) {
		refused = String(error.status ?? error.message);
	}
	check("removing an insert succeeds a second time", refused === "no error", refused);
	check("the second removal also took effect", !readFileSync(patchFile, "utf8").includes("keep-me"));
}

console.log("\ncatalog visibility");
{
	/** One registry double: `snapshot`/`list` exactly as the host service offers them. */
	const registry = ({ skills = [], complete = true, fail = undefined } = {}) => {
		const calls = [];
		const service = {
			calls,
			async snapshot(options) {
				calls.push(options);
				if (fail !== undefined) throw new Error(fail);
				return { skills, complete };
			},
		};
		return service;
	};
	const agent = { session: { header: { cwd: "C:\\work" } } };

	// The unscoped call is what made every healthy row read "not-in-catalog": dsh
	// reads the global layer alone without a scope, so the scope must be forwarded.
	const scoped = registry({ skills: [{ name: "alpha" }, { name: "beta" }] });
	const observation = await observeCatalog(scoped, { scope: agent, cwd: agent.session.header.cwd });
	check("the catalog query carries the invoking agent as scope", scoped.calls[0]?.scope === agent);
	check("the catalog query carries the session cwd", scoped.calls[0]?.cwd === "C:\\work");
	check("a complete observation is usable", catalogUsable(observation, 2) === true);
	check("names come from the observation", observation.names.has("beta") && observation.count === 2);

	const partial = await observeCatalog(registry({ skills: [{ name: "alpha" }], complete: false }), { scope: agent });
	check("an incomplete discovery is not usable for per-row claims", catalogUsable(partial, 2) === false);

	const broken = await observeCatalog(registry({ fail: "registry offline" }), { scope: agent });
	check("a failing query is recorded, not thrown", broken.error === "registry offline");
	check("a failing query is not usable", catalogUsable(broken, 2) === false);

	const empty = await observeCatalog(registry({ skills: [] }), { scope: agent });
	check("a complete-but-empty answer cannot condemn a row", catalogUsable(empty, 2) === false);

	// `list()` drops the completeness flag, so it can never back the marker.
	const legacy = { async list() { return [{ name: "alpha" }]; } };
	const listed = await observeCatalog(legacy, { scope: agent });
	check("a list()-only registry reports no completeness", listed.complete === undefined);
	check("a list()-only registry is not usable", catalogUsable(listed, 2) === false);

	// Cancellation is not a verdict about the catalog.
	let aborted = "no error";
	try {
		await observeCatalog(registry({ fail: "aborted" }), { signal: { aborted: true } });
	} catch (error) {
		aborted = error.message;
	}
	check("an aborted query propagates instead of being cached as an error", aborted === "aborted", aborted);

	const rowOf = (name) => ({
		name,
		form: "bundle",
		description: "",
		state: "enabled",
		managed: true,
		tracked: true,
		valid: true,
		symlink: false,
		ref: null,
		source: null,
	});
	const rows = [rowOf("alpha"), rowOf("beta")];
	const usableText = formatRows(rows, {
		summaries: [{ name: "alpha" }],
		names: new Set(["alpha"]),
		complete: true,
		count: 1,
		error: undefined,
	});
	check("a visible row is marked in-catalog", usableText.includes("目录可见 in-catalog"), usableText);
	check("an invisible row is marked not-in-catalog", usableText.includes("目录不可见 not-in-catalog"));
	const partialText = formatRows(rows, {
		summaries: [{ name: "alpha" }],
		names: new Set(["alpha"]),
		complete: false,
		count: 1,
		error: undefined,
	});
	check("an incomplete catalog prints no visibility marker", !partialText.includes("in-catalog"), partialText);
	check("an incomplete catalog says why markers are missing", partialText.includes("incomplete"), partialText);
	const failedText = formatRows(rows, {
		summaries: [],
		names: new Set(),
		complete: undefined,
		count: 0,
		error: "registry offline",
	});
	check("a failed catalog query prints no visibility marker", !failedText.includes("in-catalog"), failedText);
	check("a failed catalog query names the failure", failedText.includes("registry offline"), failedText);
	const emptyText = formatRows(rows, {
		summaries: [],
		names: new Set(),
		complete: true,
		count: 0,
		error: undefined,
	});
	check("a zero-entry answer prints no visibility marker", !emptyText.includes("in-catalog"), emptyText);
	check("a zero-entry answer explains itself", emptyText.includes("no entries"), emptyText);
	check("formatRows without an observation stays silent about the catalog", !formatRows(rows).includes("in-catalog"));
}

console.log("\nvalidation mirrors the provider (the install-it-and-it-vanishes cases)");
{
	const { validateSkill } = await import("../lib/core/validate.js");
	const { parseFrontmatter, frontmatterBoolean } = await import("../lib/core/validate.js");
	const caseDir = join(scratch, "cases");
	const write = (name, frontmatter) => {
		const dir = join(caseDir, name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\nBody\n`, "utf8");
		return dir;
	};

	// A repeated YAML key makes the provider's parser throw, so the skill is dropped.
	// Keeping the last value (the old behaviour) installed a skill nobody can see.
	const duplicate = write("dup-key", "name: dup-key\nname: other-key\ndescription: d");
	check("a duplicated frontmatter key is rejected", validateSkill(duplicate).ok === false);
	check(
		"the duplicate-key error names the field",
		/repeats "name"/.test((validateSkill(duplicate).errors ?? []).map((e) => e.message).join(" ")),
	);
	check("the parser reports the duplicate", parseFrontmatter("---\nname: a\nname: b\n---\n").duplicateKeys.includes("name"));

	// No trimming: `name: " foo "` is the name ` foo ` for the provider too.
	const padded = write("padded-name", 'name: " padded-name "\ndescription: d');
	check("a quoted padded name is rejected", validateSkill(padded).ok === false);

	// Same rule for booleans: the provider lower-cases the raw scalar, never trims it.
	check("a padded boolean literal is rejected", frontmatterBoolean(" true ") === undefined);
	check("an unpadded boolean literal is accepted", frontmatterBoolean("YES") === true);
	const paddedBool = write("padded-bool", 'name: padded-bool\ndescription: d\ndisable-model-invocation: " true "');
	check("a padded boolean makes the skill invalid", validateSkill(paddedBool).ok === false);
	check("a plain boolean keeps the skill valid", validateSkill(write("plain-bool", "name: plain-bool\ndescription: d\ndisable-model-invocation: true")).ok === true);

	// The provider only requires a non-empty string, so a whitespace-only description is
	// published; refusing it here reported a live skill as invalid.
	const spaces = write("space-desc", 'name: space-desc\ndescription: "   "');
	check("a whitespace-only description is accepted, like the provider", validateSkill(spaces).ok === true);

	// A nested key is not a top-level one: `metadata: { name: x }` must not impersonate
	// the skill's own name (the provider would drop a skill with no top-level name).
	const nested = write("nested-name", "metadata:\n  name: nested-name\ndescription: d");
	check("a nested name does not satisfy the top-level name", validateSkill(nested).ok === false);
}

console.log("\nnav icon self-heal (generation-aware)");
{
	const { ensureNavIconPatch } = await import("../lib/navicon.js");
	const previousHome = process.env.DSH_HOME;
	const fakeHome = join(scratch, "navhome");
	const shell = join(fakeHome, "profiles", "web", "node_modules", "@deepseek-ai", "dsh-client-ui-settings-general", "lib");
	mkdirSync(shell, { recursive: true });
	const shellFile = join(shell, "client.js");
	process.env.DSH_HOME = fakeHome;
	// The bundle shape both generations share; only the icon names differ.
	const bundleFor = (pluginsIcon) =>
		`function navIcon(id) {\n\tif (id === "plugins") return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.${pluginsIcon}, {\n\t\tclassName: SettingsRoot_module_css_default.navIcon,\n\t\tsize: 16\n\t});\n\treturn (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSettingsOutlineMedium, {\n\t\tclassName: SettingsRoot_module_css_default.navIcon,\n\t\tsize: 16\n\t});\n}\n`;

	// dsh 0.2 generation: `…Medium` icon names.
	writeFileSync(shellFile, bundleFor("IconPersonalizationOutlineMedium"), "utf8");
	const patched = ensureNavIconPatch();
	const afterPatch = readFileSync(shellFile, "utf8");
	check("the 0.2 shell generation is patched", patched.status === "patched", JSON.stringify(patched));
	check("the patch reports which generation it matched", patched.generation === "0.2+");
	check("it inserts the icon that generation ships", afterPatch.includes("IconSkillOutlineMedium, {"));
	check("it does not insert the retired numeric icon", !afterPatch.includes("IconSkillOutline16"));
	check("the inserted branch is valid JS", (() => {
		try {
			new Function(afterPatch.replace(/^/, ""));
			return true;
		} catch {
			return false;
		}
	})());
	check("a second run is idempotent", ensureNavIconPatch().status === "ok");
	check("a second run adds nothing", readFileSync(shellFile, "utf8") === afterPatch);

	// dsh 0.1 generation: numeric icon names, the shape the plugin shipped against.
	writeFileSync(shellFile, bundleFor("IconPersonalizationOutline16"), "utf8");
	const legacy = ensureNavIconPatch();
	check("the 0.1 shell generation is still patched", legacy.status === "patched", JSON.stringify(legacy));
	check("the legacy patch keeps the numeric icon", readFileSync(shellFile, "utf8").includes("IconSkillOutline16, {"));

	// An unknown shell shape must degrade to a reported status, never a crash.
	writeFileSync(shellFile, "function navIcon(id) { return null; }\n", "utf8");
	check("an unrecognized shell reports anchor-missing", ensureNavIconPatch().status === "anchor-missing");

	if (previousHome === undefined) delete process.env.DSH_HOME;
	else process.env.DSH_HOME = previousHome;
}

console.log("\ndsh home resolution");
{
	const { dshHome } = await import("../lib/core/paths.js");
	const previous = process.env.DSH_HOME;
	process.env.DSH_HOME = "~/some-dsh-home";
	const expanded = dshHome();
	check("a leading ~ is expanded", !expanded.startsWith("~"));
	check("the expanded home is absolute", /^[A-Za-z]:[\\/]|^\//.test(expanded));
	process.env.DSH_HOME = "relative-home";
	check("a relative DSH_HOME is resolved to an absolute path", /^[A-Za-z]:[\\/]|^\//.test(dshHome()));
	if (previous === undefined) delete process.env.DSH_HOME;
	else process.env.DSH_HOME = previous;
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

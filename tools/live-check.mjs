// Live acceptance check against the RUNNING dsh deployment.
//
// The unit suites prove the code; this proves the deployment: that the running host really
// mounted the routes, loaded the right plugin version, and that the documented behaviour
// holds for a real skill root — including the one bug a user hit before 0.1.9 (a "migrate"
// button on a bundled skill that no rename can move).
//
// It is deliberately narrow and reversible:
//   * it only ever touches ONE skill it creates itself (`zz-live-check-<random>`),
//   * that skill is installed and removed through the manager's own functions/routes,
//   * every other row is read-only,
//   * it cleans up in `finally`, even on failure.
//
// Usage:
//   node tools/live-check.mjs [--url http://127.0.0.1:3080] [--keep]
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
	const index = args.indexOf(`--${name}`);
	return index === -1 || args[index + 1] === undefined ? fallback : args[index + 1];
};
const BASE = arg("url", "http://127.0.0.1:3080").replace(/\/+$/, "");
const KEEP = args.includes("--keep");
const ORIGIN = new URL(BASE).origin;

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

/** Call one manager route; POSTs carry the same-origin header the page sends. */
async function call(routePath, { method = "GET", body } = {}) {
	const response = await fetch(`${BASE}/dsh-skills${routePath}`, {
		method,
		headers: {
			...(method === "POST" ? { origin: ORIGIN, "content-type": "application/json" } : {}),
		},
		body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
	});
	let payload;
	try {
		payload = await response.json();
	} catch {
		payload = undefined;
	}
	return { status: response.status, payload };
}

const { installSkill, removeSkill } = await import("../lib/core/install.js");
const { backupsDir, hiddenZone, skillsRoot } = await import("../lib/core/paths.js");
const { buildRows } = await import("../lib/core/scan.js");

const probeName = `zz-live-check-${randomBytes(3).toString("hex")}`;
// The source lives in the OS temp area: a confined caller may not create directories under
// the DSH home, and nothing about the probe needs to be there.
const sourceDir = join(tmpdir(), `dsh-live-check-source-${randomBytes(3).toString("hex")}`);
let installedOnce = false;

try {
	console.log(`live check against ${BASE}`);
	console.log(`probe skill: ${probeName}\n`);

	console.log("deployment");
	{
		const list = await call("/list");
		check("the manager route answers 200 (the plugin is mounted)", list.status === 200, String(list.status));
		check("the payload reports the running dsh runtime", typeof list.payload?.runtime?.line === "string", JSON.stringify(list.payload?.runtime));
		check("the runtime is identified as verified or unverified, never guessed", typeof list.payload?.runtime?.verified === "boolean");
		check("the managed root is the real one", String(list.payload?.root ?? "").endsWith(".dsh\\skills") || String(list.payload?.root ?? "").endsWith(".dsh/skills"), list.payload?.root);
		check("rows come back", Array.isArray(list.payload?.rows) && list.payload.rows.length > 0, String(list.payload?.rows?.length));
		const rows = list.payload?.rows ?? [];
		const readOnly = rows.filter((row) => row.managed === false);
		check("every read-only row carries a migrate decision", readOnly.every((row) => typeof row.migratable === "boolean"), JSON.stringify(readOnly.map((row) => row.name)));
		check(
			"every non-migratable read-only row explains why",
			readOnly.filter((row) => row.migratable === false).every((row) => typeof row.migrateReason === "string" && row.migrateReason.length > 0),
		);
		const bundled = readOnly.filter((row) => /bundled/i.test(String(row.providerSource)));
		if (bundled.length > 0) {
			check("a bundled row is never offered for migration", bundled.every((row) => row.migratable === false), JSON.stringify(bundled.map((row) => row.name)));
			const refused = await call("/migrate", { method: "POST", body: { name: bundled[0].name } });
			check(
				`migrating the bundled row "${bundled[0].name}" answers 400`,
				refused.status === 400,
				JSON.stringify(refused.payload),
			);
			check(
				"the refusal names the provider root instead of 'not found'",
				/bundled/i.test(String(refused.payload?.error)) && !/^no migratable skill/.test(String(refused.payload?.error)),
				String(refused.payload?.error),
			);
		} else {
			console.log("  ..   no bundled skill present on this deployment");
		}

		const doctor = await call("/doctor");
		check("the doctor route answers 200", doctor.status === 200, String(doctor.status));
		check("doctor reports the root and the hidden zone", doctor.payload?.rootExists === true && typeof doctor.payload?.zoneExists === "boolean");
	}

	console.log("\nlifecycle on a throwaway skill");
	{
		const { mkdirSync, writeFileSync } = await import("node:fs");		mkdirSync(sourceDir, { recursive: true });
		writeFileSync(
			join(sourceDir, "SKILL.md"),
			`---\nname: ${probeName}\ndescription: Temporary live-check probe; removed by tools/live-check.mjs\n---\n\nProbe body.\n`,
			"utf8",
		);
		const installed = await installSkill(sourceDir);
		installedOnce = installed.ok === true;
		check("install succeeds through the manager", installed.ok === true, installed.message);

		const listed = await call("/list");
		const row = (listed.payload?.rows ?? []).find((entry) => entry.name === probeName);
		check("the installed skill appears as managed", row?.managed === true && row?.state === "enabled");

		const off = await call("/set-enabled", { method: "POST", body: { name: probeName, enabled: false } });
		check("disable answers 200", off.status === 200 && off.payload?.changed === true, JSON.stringify(off.payload));
		const afterOff = await call("/list");
		const offRow = (afterOff.payload?.rows ?? []).find((entry) => entry.name === probeName);
		check("the row now says disabled", offRow?.state === "disabled");

		const on = await call("/set-enabled", { method: "POST", body: { name: probeName, enabled: true } });
		check("enable answers 200", on.status === 200 && on.payload?.changed === true, JSON.stringify(on.payload));

		const verified = await call(`/verify?name=${encodeURIComponent(probeName)}`);
		check("verify reports the probe clean", verified.status === 200 && verified.payload?.ok === true && verified.payload?.clean === true, JSON.stringify(verified.payload));

		const foreignOrigin = await fetch(`${BASE}/dsh-skills/set-enabled`, {
			method: "POST",
			headers: { origin: "http://evil.example", "content-type": "application/json" },
			body: JSON.stringify({ name: probeName, enabled: false }),
			signal: AbortSignal.timeout(20_000),
		});
		check("a foreign Origin is refused", foreignOrigin.status === 403, String(foreignOrigin.status));

		// `purge: true` on purpose: a probe is test debris, and every run that kept a backup
		// accumulated one more directory in the user's backup area.
		const removed = await call("/remove", { method: "POST", body: { name: probeName, purge: true } });
		check("remove answers 200 (purge leaves no backup)", removed.status === 200 && removed.payload?.ok === true, JSON.stringify(removed.payload));
		installedOnce = false;
		check("the probe left the managed root", buildRows().rows.every((entry) => entry.name !== probeName));
		check("the hidden zone does not hold it", buildRows({ root: hiddenZone() }).rows.every((entry) => entry.name !== probeName));
		// A purge must also leave nothing behind in the backup area: this tool is run
		// repeatedly, and one backup per run would quietly accumulate debris.
		const leftovers = readdirSync(backupsDir()).filter((entry) => entry.startsWith(probeName));
		check("a purged probe leaves no backup behind", leftovers.length === 0, leftovers.join(", "));
	}
} finally {
	if (!KEEP && installedOnce) {
		// Best-effort cleanup: the probe must never survive a failed run.
		try {
			await removeSkill(probeName, { purge: true, force: true });
			console.log(`\ncleanup: removed ${probeName} after the failed run`);
		} catch (error) {
			console.log(`\ncleanup: could not remove ${probeName}: ${error.message}`);
		}
	}
	rmSync(sourceDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

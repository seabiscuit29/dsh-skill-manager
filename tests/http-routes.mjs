// HTTP-plane end-to-end test: every `/dsh-skills/*` route, exactly as the page calls it.
//
// The page's only channel is these routes, so they are where "the browser can do it" is
// actually decided: same-origin enforcement, method checks, the 4 KiB body cap, the JSON
// body parsing, the 200/400 mapping and the payload contract the client half renders.
// A stub webServer captures the registered routes; FakeRequest/FakeResponse stand in for
// node's http objects. Everything below the route handler is the shipped code.
//
// Usage: node tests/http-routes.mjs
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "dsh-httproutes-"));
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
mkdirSync(foreign, { recursive: true });

const { mountSkillRoutes } = await import("../lib/http.js");
const { installSkill } = await import("../lib/core/install.js");

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

/** Write one skill bundle fixture into `dir`. */
function bundle(dir, skillName, description) {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), `---\nname: ${skillName}\ndescription: ${description}\n---\n\nBody.\n`, "utf8");
	return dir;
}

// ---------------------------------------------------------------- stub web server
const routes = new Map();
const removed = [];
const disposer = mountSkillRoutes({
	webServer: {
		register(route) {
			if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`);
			routes.set(route.path, route);
			return () => {
				routes.delete(route.path);
				removed.push(route.path);
			};
		},
	},
	// What the provider reports: one bundled skill (dsh ships its own skills that way) and
	// nothing from the managed root (the page trusts its own scan for that root).
	catalog: async () => [
		{
			name: "bundled-demo",
			description: "Shipped by dsh itself",
			source: "bundled",
			resourceBase: { kind: "directory", path: join(scratch, "bundled", "bundled-demo") },
		},
	],
});

class FakeResponse {
	constructor() {
		this.statusCode = 200;
		this.headers = {};
		this.chunks = [];
	}
	writeHead(code, headers) {
		this.statusCode = code;
		this.headers = { ...this.headers, ...(headers ?? {}) };
	}
	end(chunk) {
		if (chunk !== undefined && chunk !== null) this.chunks.push(String(chunk));
	}
	get body() {
		return this.chunks.join("");
	}
	get json() {
		try {
			return JSON.parse(this.body);
		} catch {
			return undefined;
		}
	}
}

/** One request: emits `data`/`end` on the next tick, like a real socket. */
function fakeRequest({ method = "GET", url = "/", headers = {}, body = "" } = {}) {
	const request = new EventEmitter();
	request.method = method;
	request.url = url;
	request.headers = { host: "127.0.0.1:3080", ...headers };
	request.destroy = () => {};
	setImmediate(() => {
		if (body !== "") request.emit("data", Buffer.from(body, "utf8"));
		request.emit("end");
	});
	return request;
}

const SAME_ORIGIN = { origin: "http://127.0.0.1:3080" };

/** Call one mounted route and resolve with the response. */
async function call(routePath, { method = "GET", body, headers = SAME_ORIGIN } = {}) {
	// Routes are exact PATHS; the query string belongs to the URL, not to the lookup key.
	const [pathname, query] = routePath.split("?");
	const route = routes.get(`/dsh-skills${pathname}`);
	if (route === undefined) throw new Error(`route not mounted: ${pathname}`);
	const response = new FakeResponse();
	const payload = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
	const url = `/dsh-skills${pathname}${query === undefined ? "" : `?${query}`}`;
	await route.handler(fakeRequest({ method, url, headers, body: payload }), response);
	// readJsonBody resolves from an event callback; give it one macrotask to settle.
	await new Promise((resolve) => setTimeout(resolve, 5));
	return response;
}

// ---------------------------------------------------------------- fixtures
bundle(join(root, "managed-one"), "managed-one", "A managed skill");
bundle(join(foreign, "outsider"), "outsider", "A skill from the agents root");
await installSkill(bundle(join(scratch, "incoming", "installed-one"), "installed-one", "Installed through the API"));

console.log("route registration");
{
	check("mounting registers exactly the documented routes", routes.size === 7, [...routes.keys()].join(", "));
	check(
		"every route is an exact path under /dsh-skills",
		[...routes.values()].every((route) => route.kind === "exact" && route.path.startsWith("/dsh-skills/")),
	);
}

console.log("\nGET /list");
{
	const response = await call("/list");
	const payload = response.json ?? {};
	check("list answers 200", response.statusCode === 200);
	check("list reports ok", payload.ok === true);
	check("list names the managed root and the hidden zone", typeof payload.root === "string" && typeof payload.zone === "string");
	check("list loads the manifest", payload.manifestLoaded === true);
	check("list returns rows", Array.isArray(payload.rows) && payload.rows.length >= 3, String(payload.rows?.length));
	const byName = new Map((payload.rows ?? []).map((row) => [row.name, row]));
	check("a skill sitting in the managed root is managed", byName.get("managed-one")?.managed === true);
	check("an untracked managed skill is flagged untracked", byName.get("managed-one")?.tracked === false);
	check("an installed skill is managed and tracked", byName.get("installed-one")?.managed === true && byName.get("installed-one")?.tracked === true);
	check("the foreign-root skill is read-only", byName.get("outsider")?.managed === false);
	check("the foreign-root skill is migratable", byName.get("outsider")?.migratable === true, JSON.stringify(byName.get("outsider")?.migratable));
	check("the bundled skill is NOT migratable", byName.get("bundled-demo")?.migratable === false);
	check(
		"the bundled row carries the reason the button needs",
		/bundled/.test(String(byName.get("bundled-demo")?.migrateReason ?? "")),
		String(byName.get("bundled-demo")?.migrateReason),
	);
	check("managed rows carry no migrate decision", byName.get("managed-one")?.migratable === undefined);
	// The runtime is reported even when this process cannot locate an installation (the test
	// scratch home has none): the line says so instead of omitting the field.
	check(
		"the payload reports the dsh runtime line",
		typeof payload.runtime?.line === "string" && /dsh runtime:/.test(payload.runtime.line),
		JSON.stringify(payload.runtime),
	);
}

console.log("\nGET /doctor");
{
	const response = await call("/doctor");
	const payload = response.json ?? {};
	check("doctor answers 200", response.statusCode === 200);
	check("doctor reports the root and counts", typeof payload.rootExists === "boolean" && typeof payload.liveCount === "number");
	check("doctor reports broken symlinks (new in 0.1.7)", Array.isArray(payload.brokenSymlinks));
}

console.log("\nGET /verify");
{
	// The documented contract is "the verifySkill() result, always 200": `ok` carries the
	// answer, so a refusal is a result rather than an HTTP failure.
	await installSkill(bundle(join(scratch, "incoming", "verify-target"), "verify-target", "Tracked, so it can be verified"));
	const ok = await call("/verify?name=verify-target");
	check("verify answers 200 for a clean tracked skill", ok.statusCode === 200 && ok.json?.ok === true && ok.json?.clean === true, ok.body);
	const untracked = await call("/verify?name=managed-one");
	check(
		"verifying an untracked skill answers 200 with ok:false and a reason",
		untracked.statusCode === 200 && untracked.json?.ok === false && /not tracked/.test(String(untracked.json?.error)),
		untracked.body,
	);
	const missing = await call("/verify");
	check("verify without a name answers 400", missing.statusCode === 400 && /name/.test(String(missing.json?.error)), missing.body);
	const unknown = await call("/verify?name=nope");
	check("verify of an unknown skill answers 200 with ok:false", unknown.statusCode === 200 && unknown.json?.ok === false, unknown.body);
}

console.log("\nPOST /set-enabled");
{
	const off = await call("/set-enabled", { method: "POST", body: { name: "managed-one", enabled: false } });
	check("disabling answers 200 and changed:true", off.statusCode === 200 && off.json?.changed === true, off.body);
	check("the skill moved to the hidden zone", existsSync(join(scratch, ".skill-disabled", "managed-one", "SKILL.md")));
	const on = await call("/set-enabled", { method: "POST", body: { name: "managed-one", enabled: true } });
	check("enabling answers 200 and changed:true", on.statusCode === 200 && on.json?.changed === true, on.body);
	check("the skill is back in the root", existsSync(join(root, "managed-one", "SKILL.md")));
	const invalid = await call("/set-enabled", { method: "POST", body: { name: "managed-one", enabled: "yes" } });
	check("a non-boolean enabled is rejected", invalid.statusCode === 400, invalid.body);
	const untrusted = await call("/set-enabled", { method: "POST", body: { name: "managed-one", enabled: false }, headers: { origin: "http://evil.example" } });
	check("a foreign Origin is refused", untrusted.statusCode === 403 && /origin/.test(String(untrusted.json?.error)), untrusted.body);
	check("the refused call changed nothing", existsSync(join(root, "managed-one", "SKILL.md")));
	const wrongMethod = await call("/set-enabled", { method: "GET" });
	check("a GET on a POST-only route answers 405 with allow", wrongMethod.statusCode === 405 && String(wrongMethod.headers.allow ?? "").includes("POST"), JSON.stringify(wrongMethod.headers));
	const badJson = await call("/set-enabled", { method: "POST", body: "{not json" });
	check("a malformed body answers 400", badJson.statusCode === 400 && /JSON/.test(String(badJson.json?.error)), badJson.body);
	const huge = await call("/set-enabled", { method: "POST", body: JSON.stringify({ name: "x".repeat(5000), enabled: true }) });
	check("an oversized body is refused", huge.statusCode === 400 && /exceed/i.test(String(huge.json?.error)), huge.body);
}

console.log("\nPOST /remove");
{
	const removedOne = await call("/remove", { method: "POST", body: { name: "installed-one" } });
	check("remove answers 200", removedOne.statusCode === 200 && removedOne.json?.ok === true, removedOne.body);
	check("remove reports a backup path", typeof removedOne.json?.backupPath === "string" && readdirSync(join(scratch, ".skill-backups")).length > 0);
	check("the skill left the root", !existsSync(join(root, "installed-one")));
	const again = await call("/remove", { method: "POST", body: { name: "installed-one" } });
	check("removing a missing skill answers 400", again.statusCode === 400, again.body);
}

console.log("\nPOST /migrate");
{
	const moved = await call("/migrate", { method: "POST", body: { name: "outsider" } });
	check("migrating a foreign skill answers 200", moved.statusCode === 200 && moved.json?.ok === true, moved.body);
	check("the skill lives in the managed root now", existsSync(join(root, "outsider", "SKILL.md")));
	const managed = await call("/migrate", { method: "POST", body: { name: "outsider" } });
	check("migrating an already-managed skill answers 400 with 'already'", managed.statusCode === 400 && /already in the managed root/.test(String(managed.json?.error)), managed.body);
	const bundled = await call("/migrate", { method: "POST", body: { name: "bundled-demo" } });
	check("migrating the bundled skill answers 400", bundled.statusCode === 400);
	// The name itself contains "bundled", so matching /bundled/ would pass on the WRONG text:
	// assert the SOURCE phrase, and that no generic fallback leaked through.
	check(
		"the bundled refusal names the provider root as the source",
		/由 bundled 提供/.test(String(bundled.json?.error)) && !/another root|未知来源/.test(String(bundled.json?.error)),
		bundled.body,
	);
	check("the bundled refusal explains the roots it searched", /not a movable local skill root/.test(String(bundled.json?.error)), bundled.body);
	const unknown = await call("/migrate", { method: "POST", body: { name: "ghost" } });
	check("migrating an unknown skill answers 400 and says it is not a movable root", unknown.statusCode === 400 && /不可迁移/.test(String(unknown.json?.error)), unknown.body);
}

console.log("\nPOST /adopt");
{
	bundle(join(root, "untracked-one"), "untracked-one", "In the root, not in the ledger");
	const adopted = await call("/adopt", { method: "POST", body: { name: "untracked-one", source: "https://example.com/x" } });
	check("adopt answers 200", adopted.statusCode === 200 && adopted.json?.ok === true, adopted.body);
	const listed = await call("/list");
	const row = (listed.json?.rows ?? []).find((entry) => entry.name === "untracked-one");
	check("the adopted skill is tracked", row?.tracked === true);
	const missing = await call("/adopt", { method: "POST", body: {} });
	check("adopt without a name answers 400", missing.statusCode === 400 && /name/.test(String(missing.json?.error)), missing.body);
}

console.log("\nteardown");
{
	check("the disposed mount removed every route", typeof disposer === "function");
	disposer();
	check("no routes remain registered", routes.size === 0, [...routes.keys()].join(", "));
	check("the disposer reported each removal", removed.length === 7, String(removed.length));
}

console.log(`\n${passed} passed, ${failed} failed`);
console.log(`scratch: ${scratch}`);
if (failed > 0) process.exit(1);

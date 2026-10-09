// Local HTTP face of the manager. The Settings - Skills page talks to these
// routes (same pattern as the plugin market in this deployment) instead of a
// generated Remote namespace: no code generation, no dependency on a first-party
// assembly selecting our namespace, and the whole feature works offline.
//
// Every route is same-origin checked, body-capped and routed through the same
// core functions the /skill command uses, so the two entries cannot diverge.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installSkill, removeSkill, verifySkill } from "./core/install.js";
import { loadManifest } from "./core/manifest.js";
import { migrateSkill, migrationVerdicts, unmigratableReason } from "./core/migrate.js";
import { buildDoctor, buildRows } from "./core/scan.js";
import { dshRuntime, runtimeLine } from "./core/runtime.js";
import { adoptSkill, setSkillEnabled } from "./core/state.js";
import { dshHome } from "./core/paths.js";

/** One JSON body may not exceed this; every request here is a few short fields. */
const MAX_BODY_BYTES = 4096;

/** All routes live under this prefix; a collision with another plugin throws at mount. */
export const ROUTE_PREFIX = "/dsh-skills";

/** Write one JSON response; never cached. */
function sendJson(response, status, payload) {
	response.writeHead(status, {
		"cache-control": "no-store",
		"content-type": "application/json; charset=utf-8",
	});
	response.end(JSON.stringify(payload));
}

/**
 * Split a `Host` header value into `hostname:port`, defaulting the port by scheme.
 * A bracketed IPv6 literal keeps its own colons, so the port can only be what follows the
 * closing bracket; an unbracketed value with two or more colons is a bare IPv6 literal
 * rather than `host:port`.
 */
function splitAuthority(value, protocol) {
	const text = String(value).trim().toLowerCase();
	let hostname;
	let port;
	if (text.startsWith("[")) {
		const close = text.indexOf("]");
		hostname = close === -1 ? text.slice(1) : text.slice(1, close);
		port = close === -1 ? "" : text.slice(close + 1).replace(/^:/, "");
	} else {
		const separator = text.lastIndexOf(":");
		const isBareIpv6 = text.indexOf(":") !== separator;
		hostname = separator === -1 || isBareIpv6 ? text : text.slice(0, separator);
		port = separator === -1 || isBareIpv6 ? "" : text.slice(separator + 1);
	}
	if (port === "") port = protocol === "https:" ? "443" : "80";
	return { hostname, port };
}

/** Whether a hostname names this machine's loopback interface. */
function isLoopback(hostname) {
	return hostname === "localhost" || hostname === "::1" || hostname === "0:0:0:0:0:0:0:1" || /^127\./.test(hostname);
}

/**
 * Decide whether a write request is same-origin.
 *
 * Two shapes have to be accepted, and only these two:
 *
 * 1. **An `Origin` that names the same server.** Compared after normalisation, never
 *    byte-exactly: a legitimate client may spell the same loopback server several ways
 *    (`localhost:PORT` vs `127.0.0.1:PORT`, `[::1]:PORT`, and `Host` header case, which
 *    RFC 7230 declares case-insensitive). A byte comparison rejects those with a 403 the
 *    user cannot act on.
 *
 * 2. **No `Origin` at all, but a `Host` that names loopback.** This is the case that
 *    matters in practice: some renderers and non-browser callers omit `Origin` entirely,
 *    and the desktop host's own UI does exactly that — so requiring the header made every
 *    write fail with "untrusted origin" while the page rendered fine (reads are not
 *    checked). It is also SAFE to accept: a request whose `Host` is loopback was addressed
 *    to this machine's own server, and a hostile web page cannot forge `Host` — it can
 *    only make the browser send it, and the browser always attaches `Origin` to a
 *    cross-origin `fetch`/form POST. Accepting absent-`Origin` requests *without* the
 *    loopback condition would be a real CSRF hole; the condition is what closes it.
 *
 * The report carries both spellings it looked at, because a bare "untrusted origin" tells
 * a user nothing about whether they hit a genuine cross-origin attempt or a shape the check
 * did not know, and this server has no log the Settings page can surface.
 * @returns `{ ok, origin, host, compared }` — `compared` is `"<origin> vs <host>"`.
 */
function checkSameOrigin(request) {
	const origin = request.headers.origin;
	const host = request.headers.host;
	const report = {
		ok: false,
		origin: origin ?? "(absent)",
		host: host ?? "(absent)",
		compared: `${origin ?? "(absent)"} vs ${host ?? "(absent)"}`,
	};
	if (host === undefined) return report;
	const authority = splitAuthority(host, "http:");

	if (origin === undefined) {
		// Shape 2: loopback only, and recorded as such so the 403 text stays truthful.
		report.ok = isLoopback(authority.hostname);
		if (!report.ok) report.compared = `(absent) vs ${host} (host is not loopback)`;
		return report;
	}

	let url;
	try {
		url = new URL(origin);
	} catch {
		return report;
	}
	const fromOrigin = splitAuthority(url.host, url.protocol);
	// `localhost`, `::1` and `127.0.0.1` all name the same interface; fold them to one name,
	// except a genuine cross-origin origin, which must NOT be folded.
	const fold = (hostname, loopback) => (loopback && hostname !== "127.0.0.1" ? "127.0.0.1" : hostname);
	report.ok =
		fold(fromOrigin.hostname, isLoopback(fromOrigin.hostname)) === fold(authority.hostname, isLoopback(authority.hostname)) &&
		fromOrigin.port === authority.port;
	return report;
}

/** Read a small JSON body with a hard cap. */
function readJsonBody(request, maxBytes = MAX_BODY_BYTES) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		request.on("data", (chunk) => {
			size += chunk.length;
			if (size > maxBytes) {
				reject(new Error(`request body exceeds ${maxBytes} bytes`));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8").trim();
			if (text === "") return resolve({});
			try {
				resolve(JSON.parse(text));
			} catch (error) {
				reject(new Error(`request body is not valid JSON: ${error.message}`));
			}
		});
		request.on("error", reject);
	});
}

/** Required string field of a request body. */
function requiredString(body, field) {
	const value = body?.[field];
	if (typeof value !== "string" || value.trim() === "") throw new Error(`"${field}" must be a non-empty string`);
	return value.trim();
}

/**
 * Opt-in request capture for diagnosing a client this server cannot otherwise see.
 *
 * The write guard rejected a real deployment with `origin (absent)`, which browsers do not
 * do for a same-origin `fetch` — so the client was something else, and there is no way to
 * tell which from the outside: this server keeps no access log the Settings page can show.
 * Setting `DSH_SKILL_MANAGER_DEBUG_HEADERS=1` makes the guard append what it saw to
 * `<dsh home>/dsh-skill-manager-headers.log`, and the 403 names that file.
 *
 * Off unless asked for: it writes a file, and a manager should not do that behind a user's
 * back. Never throws — a diagnostic that can break a request is worse than no diagnostic.
 */
const HEADER_LOG_LIMIT = 200;

/** Record one request's headers when the capture is enabled; never throws. */
function captureHeaders(request) {
	if (process.env.DSH_SKILL_MANAGER_DEBUG_HEADERS !== "1") return undefined;
	try {
		const file = join(dshHome(), "dsh-skill-manager-headers.log");
		let lines = [];
		try {
			lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
		} catch {
			lines = [];
		}
		lines.push(
			JSON.stringify({
				at: new Date().toISOString(),
				method: request.method,
				url: request.url,
				origin: request.headers.origin ?? null,
				host: request.headers.host ?? null,
				referer: request.headers.referer ?? null,
				userAgent: request.headers["user-agent"] ?? null,
				secFetchSite: request.headers["sec-fetch-site"] ?? null,
				secFetchMode: request.headers["sec-fetch-mode"] ?? null,
				allHeaders: request.headers,
			}),
		);
		writeFileSync(file, `${lines.slice(-HEADER_LOG_LIMIT).join("\n")}\n`, "utf8");
		return file;
	} catch {
		return undefined;
	}
}

/**
 * Mount the manager's routes on the host web server.
 * @param options.webServer - the host web server service.
 * @param options.catalog - optional provider of the deployment's catalog summaries,
 *   so the page can also show skills published from roots this manager does not own.
 * @returns a disposer removing every route it registered.
 */
export function mountSkillRoutes({ webServer, catalog }) {
	const disposers = [];
	const catalogOf = typeof catalog === "function" ? catalog : undefined;

	/** Catalog summaries plus the failure reason, so a broken query is visible, not silent. */
	const readCatalog = async () => {
		try {
			return { rows: await catalogOf?.() };
		} catch (error) {
			return { rows: undefined, error: error?.message ?? String(error) };
		}
	};

	const route = (path, methods, handler) => {
		disposers.push(
			webServer.register({
				kind: "exact",
				path: `${ROUTE_PREFIX}${path}`,
				handler: async (request, response) => {
					if (!methods.includes(request.method ?? "GET")) {
						response.writeHead(405, { allow: methods.join(", ") });
						response.end();
						return;
					}
					const originCheck = checkSameOrigin(request);
					if (methods.includes("POST") && !originCheck.ok) {
						// Report WHAT was compared: with only "untrusted origin" a user cannot tell a
						// genuine cross-origin attempt from a loopback alias the check did not know,
						// and this server has no log the Settings page can surface.
						const captured = captureHeaders(request);
						sendJson(response, 403, {
							ok: false,
							error: `untrusted origin (origin ${originCheck.origin} vs host ${originCheck.host})${
								captured === undefined ? "" : ` — headers captured to ${captured}`
							}`,
							origin: originCheck.origin,
							host: originCheck.host,
						});
						return;
					}
					try {
						await handler(request, response);
					} catch (error) {
						sendJson(response, 400, { ok: false, error: error?.message ?? String(error) });
					}
				},
			}),
		);
	};

	// Everything the page needs to render: the merged ledger/disk view, the foreign
	// roots this manager enumerates itself, plus whatever else the catalog knows.
	route("/list", ["GET"], async (request, response) => {
		const { rows: catalogRows, error: catalogError } = await readCatalog();
		const view = buildRows({ catalog: catalogRows });
		let manifestLoaded = true;
		try {
			loadManifest();
		} catch {
			manifestLoaded = false;
		}
		sendJson(response, 200, {
			ok: true,
			root: view.root,
			zone: view.zone,
			manifestFile: view.manifestFile,
			manifestLoaded,
			// Present only when the catalog query failed: the page surfaces it so a
			// partial list is never mistaken for a complete one.
			...(catalogError === undefined ? {} : { catalogError }),
			// The runtime this process runs on, so an unverified dsh release line is
			// visible in the page and not only in the command plane.
			runtime: (() => {
				const harness = dshRuntime();
				return { version: harness.version, line: runtimeLine(harness), verified: harness.verified };
			})(),
			// Whether each read-only row can actually be moved. The page used to render a
			// migrate button for every non-managed row, including bundled skills that no
			// rename can move — clicking one could only ever produce an error.
			rows: (() => {
				const verdicts = migrationVerdicts();
				for (const row of view.rows) {
					if (row.managed === true) continue;
					const verdict = verdicts.get(row.name);
					row.migratable = verdict?.migratable === true;
					if (row.migratable !== true) row.migrateReason = verdict?.reason ?? unmigratableReason(row);
				}
				return view.rows;
			})(),
		});
	});

	// Enable / disable one skill (the page's switch).
	route("/set-enabled", ["POST"], async (request, response) => {
		const body = await readJsonBody(request);
		const name = requiredString(body, "name");
		if (typeof body.enabled !== "boolean") throw new Error('"enabled" must be a boolean');
		const result = await setSkillEnabled(name, body.enabled);
		sendJson(response, 200, result);
	});

	// Remove one skill (the page's delete button, after its confirmation).
	route("/remove", ["POST"], async (request, response) => {
		const body = await readJsonBody(request);
		const name = requiredString(body, "name");
		const result = await removeSkill(name, { purge: body.purge === true, force: body.force === true });
		sendJson(response, 200, result);
	});

	// Pull a skill published from another local root into the managed root, so the
	// page's read-only rows can become manageable (same rename+adopt as the command).
	route("/migrate", ["POST"], async (request, response) => {
		const body = await readJsonBody(request);
		const name = requiredString(body, "name");
		// Answer with the real reason instead of the rename's "not found under <root>":
		// a row can be read-only for reasons a rename cannot fix. The catalog is part of the
		// view here — a bundled skill exists only as a catalog row, and without it the reason
		// degrades to a useless "unknown root" (a live check caught exactly that).
		const { rows: catalogRows } = await readCatalog();
		const row = buildRows({ catalog: catalogRows }).rows.find((entry) => entry.name === name);
		if (row?.managed === true) throw new Error(`"${name}" 已在受管根中 already in the managed root — nothing to migrate`);
		const verdict = migrationVerdicts().get(name);
		if (verdict === undefined) {
			throw new Error(`"${name}" 不可迁移 not migratable: ${unmigratableReason(row)}`);
		}
		if (verdict.migratable !== true) throw new Error(`"${name}" 不可迁移 not migratable: ${verdict.reason}`);
		const result = await migrateSkill(name);
		sendJson(response, 200, result);
	});

	// Adopt an untracked skill so the manager can report its source and state.
	route("/adopt", ["POST"], async (request, response) => {
		const body = await readJsonBody(request);
		const name = requiredString(body, "name");
		const source = typeof body.source === "string" && body.source.trim() !== "" ? body.source.trim() : null;
		const result = await adoptSkill(name, { source });
		sendJson(response, 200, result);
	});

	// Local integrity check for one skill.
	route("/verify", ["GET"], async (request, response) => {
		const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
		const name = url.searchParams.get("name");
		if (name === null || name === "") throw new Error('"name" query parameter is required');
		sendJson(response, 200, verifySkill(name));
	});

	// Environment and ledger diagnostics.
	route("/doctor", ["GET"], async (request, response) => {
		const { rows: catalogRows, error: catalogError } = await readCatalog();
		sendJson(response, 200, {
			ok: true,
			...buildDoctor({ catalog: catalogRows }),
			...(catalogError === undefined ? {} : { catalogError }),
		});
	});

	// Install is intentionally NOT exposed over HTTP: adding skills stays on the
	// explicit /skill command, while the page only manages what is installed.
	void installSkill;

	return () => {
		for (const dispose of disposers.reverse()) {
			try {
				dispose();
			} catch {
				// A route already gone must not block teardown of the others.
			}
		}
	};
}

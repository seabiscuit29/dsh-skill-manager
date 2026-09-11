// Local HTTP face of the manager. The Settings - Skills page talks to these
// routes (same pattern as the plugin market in this deployment) instead of a
// generated Remote namespace: no code generation, no dependency on a first-party
// assembly selecting our namespace, and the whole feature works offline.
//
// Every route is same-origin checked, body-capped and routed through the same
// core functions the /skill command uses, so the two entries cannot diverge.
import { installSkill, removeSkill, verifySkill } from "./core/install.js";
import { loadManifest } from "./core/manifest.js";
import { migrateSkill } from "./core/migrate.js";
import { buildDoctor, buildRows } from "./core/scan.js";
import { adoptSkill, setSkillEnabled } from "./core/state.js";

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

/** Reject cross-origin writes: the default same-origin policy is not enough on a loopback server. */
function sameOrigin(request) {
	const origin = request.headers.origin;
	const host = request.headers.host;
	if (origin === undefined || host === undefined) return false;
	try {
		return new URL(origin).host === host;
	} catch {
		return false;
	}
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
					if (methods.includes("POST") && !sameOrigin(request)) {
						sendJson(response, 403, { ok: false, error: "untrusted origin" });
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
			rows: view.rows,
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

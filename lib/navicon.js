// Keeps the Skills section's nav icon patched into the settings shell.
//
// The settings shell owns its navIcon mapping with no injection seam, so an
// extra section id falls back to the generic gear. This self-heal runs on every
// host boot, which means a dsh upgrade that overwrites the upstream bundle is
// re-patched automatically. Failures stay silent: a cosmetic patch must never
// break boot, and a gear icon is an acceptable degradation.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dshHome } from "./core/paths.js";

/** Marker proving the skills branch is already present. */
const MARKER = 'if (id === "skills") return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSkillOutline16, {';
/** The plugins branch the skills branch is inserted after. */
const ANCHOR = 'if (id === "plugins") return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPersonalizationOutline16, {';

/** Candidate locations of the settings-general client bundle. */
function candidates() {
	const home = dshHome();
	return [
		join(home, "profiles", "node_modules", "@deepseek-ai", "dsh-client-ui-settings-general", "lib", "client.js"),
		join(home, "profiles", "web", "node_modules", "@deepseek-ai", "dsh-client-ui-settings-general", "lib", "client.js"),
	];
}

/**
 * Ensure the settings shell maps the `skills` section id to the skill glyph.
 * Idempotent; returns a status record for diagnostics.
 * @returns `{ status: "ok" | "patched" | "anchor-missing" | "not-found" | "write-denied" }`
 */
export function ensureNavIconPatch() {
	for (const file of candidates()) {
		if (!existsSync(file)) continue;
		let raw;
		try {
			raw = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		if (raw.includes(MARKER)) return { status: "ok", file };
		const index = raw.indexOf(ANCHOR);
		if (index === -1) return { status: "anchor-missing", file };
		const end = raw.indexOf("});", index) + 3;
		const block = raw.slice(index, end);
		// Follow the file's own line endings: the upstream bundle is CRLF on Windows and
		// LF on macOS/Linux, and inserting the other style would leave the file mixed.
		const eol = raw.includes("\r\n") ? "\r\n" : "\n";
		const indent = `${eol}\t\t\t\t`;
		const addition =
			`${indent}if (id === "skills") return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSkillOutline16, {` +
			`${indent}\tclassName: SettingsRoot_module_css_default.navIcon,` +
			`${indent}\tsize: 16` +
			`${indent}});`;
		try {
			writeFileSync(file, raw.replace(block, block + addition), "utf8");
			return { status: "patched", file };
		} catch {
			return { status: "write-denied", file };
		}
	}
	return { status: "not-found" };
}

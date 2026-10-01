// Keeps the Skills section's nav icon patched into the settings shell.
//
// The settings shell owns its navIcon mapping with no injection seam, so an
// extra section id falls back to the generic gear. This self-heal runs on every
// host boot, which means a dsh upgrade that overwrites the upstream bundle is
// re-patched automatically. Failures stay silent: a cosmetic patch must never
// break boot, and a gear icon is an acceptable degradation.
//
// The shell's icon naming changed in dsh 0.2.0 (`IconXxx16` → `IconXxxMedium`),
// so the patch is generation-aware: it looks for the anchor that generation
// actually ships and inserts that generation's icon. A single hard-coded pair
// silently stopped matching — "anchor-missing" every boot — which is exactly the
// cosmetic failure this file exists to avoid.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dshHome } from "./core/paths.js";

/**
 * One shell generation: the plugins branch it ships, and the skills glyph it can
 * render. Newest first — a bundle carries one generation, so order is readability.
 */
const GENERATIONS = [
	{
		name: "0.2+",
		anchor:
			'if (id === "plugins") return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPersonalizationOutlineMedium, {',
		icon: "IconSkillOutlineMedium",
	},
	{
		name: "0.1",
		anchor:
			'if (id === "plugins") return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPersonalizationOutline16, {',
		icon: "IconSkillOutline16",
	},
];

/** Marker proving a generation's skills branch is already present. */
function markerOf(generation) {
	return `if (id === "skills") return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.${generation.icon}, {`;
}

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
 * @returns `{ status: "ok" | "patched" | "anchor-missing" | "not-found" | "write-denied", file?, generation? }`
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
		// Already patched for the generation this bundle ships: nothing to do. Checked
		// before anchoring so a re-run on a patched file cannot insert a second branch.
		for (const generation of GENERATIONS) {
			if (raw.includes(markerOf(generation))) return { status: "ok", file, generation: generation.name };
		}
		for (const generation of GENERATIONS) {
			const index = raw.indexOf(generation.anchor);
			if (index === -1) continue;
			const end = raw.indexOf("});", index) + 3;
			const block = raw.slice(index, end);
			// Follow the file's own line endings: the upstream bundle is CRLF on Windows and
			// LF on macOS/Linux, and inserting the other style would leave the file mixed.
			const eol = raw.includes("\r\n") ? "\r\n" : "\n";
			const indent = `${eol}\t\t\t\t`;
			const addition =
				`${indent}if (id === "skills") return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.${generation.icon}, {` +
				`${indent}\tclassName: SettingsRoot_module_css_default.navIcon,` +
				`${indent}\tsize: 16` +
				`${indent}});`;
			try {
				writeFileSync(file, raw.replace(block, block + addition), "utf8");
				return { status: "patched", file, generation: generation.name };
			} catch {
				return { status: "write-denied", file, generation: generation.name };
			}
		}
		// The file exists but matches no known generation: report the file so doctor
		// can show which bundle went unrecognized.
		return { status: "anchor-missing", file };
	}
	return { status: "not-found" };
}

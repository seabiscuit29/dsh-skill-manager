// Remove profile patch entries that mount the given packages.
//
// One implementation for both installers (tools/swap-profile.ps1 on Windows,
// tools/swap-profile.sh on macOS/Linux): the block matching is fiddly enough that
// two copies would drift. Idempotent, and it refuses to finish if a removed package
// is still referenced anywhere in the file.
//
// Usage:
//   node tools/profile-patch-clean.mjs --patch <file> --remove <pkg> [--remove <pkg>] [--dry-run]
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
/** Collect every `--flag value` pair. */
function valuesOf(flag) {
	const out = [];
	for (let index = 0; index < args.length; index++) {
		if (args[index] === `--${flag}` && args[index + 1] !== undefined) out.push(args[index + 1]);
	}
	return out;
}

const patchFile = valuesOf("patch")[0];
const packages = valuesOf("remove");
const dryRun = args.includes("--dry-run");

if (patchFile === undefined || packages.length === 0) {
	console.error("usage: node tools/profile-patch-clean.mjs --patch <file> --remove <pkg> [--remove <pkg>] [--dry-run]");
	process.exit(2);
}
if (!existsSync(patchFile)) {
	console.error(`patch file not found: ${patchFile}`);
	process.exit(2);
}

const before = readFileSync(patchFile, "utf8");
let after = before;
let removed = 0;

for (const name of packages) {
	// Match one `- insert:` block whose entry mounts this package name.
	const pattern = new RegExp(
		`\\r?\\n*- insert:\\s*\\r?\\n\\s*- id: [^\\r\\n]*\\r?\\n\\s*name: '${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'[^\\r\\n]*\\r?\\n?`,
		"g",
	);
	const matches = after.match(pattern);
	if (matches !== null) removed += matches.length;
	after = after.replace(pattern, "\n");
}

for (const name of packages) {
	if (after.includes(name)) {
		console.error(`refusing to continue: ${patchFile} still references ${name}`);
		process.exit(1);
	}
}

if (removed === 0) {
	console.log(`  no insert referenced ${packages.join(", ")} (already clean)`);
} else if (dryRun) {
	console.log(`  would remove ${removed} insert block(s) for ${packages.join(", ")}`);
} else {
	writeFileSync(patchFile, after, "utf8");
	console.log(`  removed ${removed} insert block(s) for ${packages.join(", ")}`);
}

const remaining = [...after.matchAll(/^\s*- id:\s*(.+)$/gm)].map((match) => match[1].trim());
console.log(`  remaining insert ids: ${remaining.join(", ") || "(none)"}`);

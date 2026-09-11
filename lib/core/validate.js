// Frontmatter parsing plus the validation rules mirrored from
// `@deepseek-ai/dsh-skill-filesystem`. The provider silently drops a skill it
// cannot parse (bad name, legacy camelCase invocation key, non-boolean
// invocation value); the manager refuses such a skill up front and says exactly
// why, so "the install succeeded" always means "the catalog will show it".
import { basename, join } from "node:path";
import { exists, isDirectory, isFile, readUtf8Checked } from "./fsutil.js";

/** The provider's skill-name grammar (`isSkillName` in @deepseek-ai/dsh-skill). */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Legacy camelCase invocation keys the provider rejects outright. */
const LEGACY_KEYS = [
	["disableModelInvocation", "disable-model-invocation"],
	["modelInvocable", "disable-model-invocation"],
	["userInvocable", "user-invocable"],
];

/** The provider's accepted boolean literals, case-insensitive. */
const BOOLEANS = new Map([
	["true", true],
	["false", false],
	["yes", true],
	["no", false],
	["on", true],
	["off", false],
	["1", true],
	["0", false],
]);

/** Whether a string is a valid kebab-case skill name. */
export function isSkillName(name) {
	return typeof name === "string" && SKILL_NAME.test(name);
}

/** Strip one layer of matching quotes from a scalar. */
function unquote(value) {
	if (value.length >= 2) {
		const first = value[0];
		const last = value[value.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1);
	}
	return value;
}

/**
 * Parse the leading `---` frontmatter block into a flat scalar map.
 * Only the scalars this manager cares about are interpreted; nested blocks are
 * recorded as present (`true`) because `metadata` is only checked for presence.
 * @returns `{ data, body }`, or undefined when the block is missing or unterminated.
 */
export function parseFrontmatter(text) {
	const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
	const lines = normalized.split("\n");
	if (lines[0]?.trim() !== "---") return undefined;
	let end = -1;
	for (let index = 1; index < lines.length; index++) {
		if (lines[index].trim() === "---") {
			end = index;
			break;
		}
	}
	if (end === -1) return undefined;

	const data = {};
	for (const line of lines.slice(1, end)) {
		if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const key = line.slice(0, colon).trim();
		if (key === "") continue;
		const rawValue = line.slice(colon + 1).trim();
		if (rawValue === "") {
			// Either an intentionally empty scalar or a nested block; both are
			// "present" for the only field where that matters (metadata).
			data[key] = true;
			continue;
		}
		data[key] = unquote(rawValue);
	}
	return { data, body: lines.slice(end + 1).join("\n") };
}

/**
 * Interpret a frontmatter boolean the way the provider does.
 * @returns the boolean, or `undefined` when the literal is not accepted.
 */
export function frontmatterBoolean(raw) {
	if (typeof raw === "boolean") return raw;
	if (typeof raw !== "string") return undefined;
	return BOOLEANS.get(raw.trim().toLowerCase());
}

/** Invocation policy resolved from frontmatter, defaulting to "both allowed". */
function parseInvocationPolicy(data) {
	const disableModelInvocation = frontmatterBoolean(data["disable-model-invocation"]);
	const userInvocable = frontmatterBoolean(data["user-invocable"]);
	return {
		modelInvocable: disableModelInvocation !== true,
		userInvocable: userInvocable !== false,
	};
}

/**
 * Validate one candidate skill: a directory containing `SKILL.md`, or a flat
 * `<name>.md` file.
 * @returns `{ ok: true, … }` with the resolved identity, or `{ ok: false, errors }`.
 */
export function validateSkill(target) {
	const errors = [];
	const push = (rule, message) => errors.push({ rule, message });

	let form;
	let skillFile;
	let diskName;
	if (isDirectory(target)) {
		form = "bundle";
		diskName = basename(target);
		skillFile = join(target, "SKILL.md");
		if (!exists(skillFile)) {
			push("layout", `bundle directory has no SKILL.md: ${target}`);
			return { ok: false, errors };
		}
	} else if (isFile(target) && target.toLowerCase().endsWith(".md")) {
		form = "flat";
		diskName = basename(target).replace(/\.md$/i, "");
		skillFile = target;
	} else {
		push(
			"layout",
			`source is neither a bundle directory (containing SKILL.md) nor a flat .md file: ${target}`,
		);
		return { ok: false, errors };
	}

	const read = readUtf8Checked(skillFile);
	if (read === undefined) {
		push("io", `cannot read ${skillFile}`);
		return { ok: false, errors };
	}
	if (!read.valid) {
		push("encoding", `${skillFile} is not valid UTF-8`);
		return { ok: false, errors };
	}

	const parsed = parseFrontmatter(read.text);
	if (parsed === undefined) {
		push("frontmatter", `${skillFile} has no closed YAML frontmatter block`);
		return { ok: false, errors };
	}
	const { data } = parsed;

	const name = typeof data.name === "string" ? data.name.trim() : "";
	if (!isSkillName(name)) {
		push(
			"name",
			`frontmatter "name" must be kebab-case (^[a-z0-9]+(-[a-z0-9]+)*$); got ${JSON.stringify(data.name ?? null)}`,
		);
	}

	const description = typeof data.description === "string" ? data.description.trim() : "";
	if (description === "") {
		push("description", 'frontmatter "description" is required and must not be empty');
	}

	for (const [legacy, canonical] of LEGACY_KEYS) {
		if (Object.hasOwn(data, legacy)) {
			push("invocation-key", `frontmatter field "${legacy}" is unsupported; use "${canonical}"`);
		}
	}

	for (const key of ["disable-model-invocation", "user-invocable"]) {
		if (!Object.hasOwn(data, key)) continue;
		if (frontmatterBoolean(data[key]) === undefined) {
			push(
				"invocation-value",
				`frontmatter "${key}" must be a boolean literal (true/false/yes/no/on/off/1/0); got ${JSON.stringify(data[key])}`,
			);
		}
	}

	// `whenToUse` and `metadata` are deliberately NOT validated: the provider
	// omits a mistyped value and keeps the skill, and neither grants invocation.
	const whenToUse = typeof data.whenToUse === "string" && data.whenToUse.trim() !== "" ? data.whenToUse.trim() : undefined;

	if (errors.length > 0) return { ok: false, errors };

	return {
		ok: true,
		name,
		description,
		whenToUse,
		form,
		diskName,
		skillFile,
		invocation: parseInvocationPolicy(data),
		frontmatter: data,
	};
}

/**
 * Tolerant summary used by the list views: never throws, reports what it found.
 * An unparseable skill still shows up (marked invalid) so the page can offer a
 * delete instead of hiding it.
 */
export function readSkillSummary(target) {
	const result = validateSkill(target);
	if (result.ok) {
		return {
			name: result.name,
			description: result.description,
			whenToUse: result.whenToUse,
			form: result.form,
			diskName: result.diskName,
			invocation: result.invocation,
			valid: true,
		};
	}
	const fallbackName = isDirectory(target) ? basename(target) : basename(target).replace(/\.md$/i, "");
	return {
		name: fallbackName,
		description: result.errors.map((error) => error.message).join("; "),
		form: isDirectory(target) ? "bundle" : "flat",
		diskName: fallbackName,
		invocation: { modelInvocable: false, userInvocable: false },
		valid: false,
		errors: result.errors,
	};
}

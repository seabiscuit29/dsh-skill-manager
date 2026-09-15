// Command-plane text rendering.
//
// The row report is what a human reads after `/skill list` or `/skill search`, so
// every mark it prints must be true: a mark that fires on a healthy skill (see
// core/catalog.js for the "not-in-catalog" incident) turns the whole report into
// noise the reader learns to ignore.
import { catalogNote, catalogUsable } from "./catalog.js";

/** Shorten long text for one-line command output. */
export function truncate(text, max) {
	const value = String(text ?? "").replace(/\s+/g, " ").trim();
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * Render rows as command-plane text.
 * @param rows - the management view's rows.
 * @param observation - optional catalog observation; the per-row visibility mark
 *   is printed only when it may be trusted, and one footer line explains why not.
 * @returns the report text.
 */
export function formatRows(rows, observation) {
	if (rows.length === 0) return "没有已安装的技能 no skills installed";
	const visible = catalogUsable(observation, rows.length);
	const lines = [`技能 skills: ${rows.length}`];
	for (const row of rows) {
		const marks = [];
		if (row.state === "disabled") marks.push("已禁用 disabled");
		if (row.state === "missing") marks.push("文件缺失 missing");
		if (!row.managed) marks.push(`其他根 ${row.providerSource ?? "other root"} (只读 read-only)`);
		else if (!row.tracked) marks.push("未入账 untracked");
		if (!row.valid) marks.push("frontmatter 非法 invalid");
		if (row.symlink === true) marks.push("符号链接 symlink（不会被收录 not published）");
		if (visible) marks.push(observation.names.has(row.name) ? "目录可见 in-catalog" : "目录不可见 not-in-catalog");
		const ref = row.ref === null || row.ref === undefined ? "" : ` @${String(row.ref).slice(0, 12)}`;
		const origin = row.source === null || row.source === undefined ? "" : ` ${row.source}${ref}`;
		lines.push(`  ${row.name} [${row.form}]${marks.length > 0 ? ` — ${marks.join(", ")}` : ""}${origin}`);
		if (row.description !== "") lines.push(`      ${truncate(row.description, 130)}`);
	}
	const note = catalogNote(observation, rows.length);
	if (note !== undefined) lines.push(`  ${note}`);
	return lines.join("\n");
}

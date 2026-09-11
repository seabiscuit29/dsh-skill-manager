// Source-spec parsing: the one grammar every install entry point shares.
import { exists, isDirectory, isFile } from "./fsutil.js";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

/** `github:owner/repo#ref/path` — the shorthand this project documents first. */
const GITHUB = /^github:(?<owner>[^/#\s]+)\/(?<repo>[^/#\s]+)(?:#(?<tail>.*))?$/;
/** Anything that looks like a git remote URL, with an optional `#ref/path` fragment. */
const GIT_URL = /^(?:https?:\/\/|git:\/\/|ssh:\/\/|git@)[^\s#]+$/;

/** Expand a leading `~` against the current home directory. */
function expandTilde(path) {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) return resolve(homedir(), path.slice(2));
	return path;
}

/**
 * Split `#ref/path…` into its ref and in-repo path parts.
 * The fragment belongs to this plugin only: it is stripped before any git call.
 */
function splitFragment(fragment) {
	if (fragment === undefined || fragment === "") return { ref: "main", path: undefined };
	const slash = fragment.indexOf("/");
	if (slash === -1) return { ref: fragment, path: undefined };
	return { ref: fragment.slice(0, slash), path: fragment.slice(slash + 1) || undefined };
}

/**
 * Parse an install source.
 * @param raw - `github:owner/repo#ref/path`, a git URL with an optional fragment, or a local path.
 * @returns a discriminated result; `kind` is `github`, `git-url` or `local`.
 */
export function parseSourceSpec(raw) {
	const spec = typeof raw === "string" ? raw.trim() : "";
	if (spec === "") return { ok: false, error: "empty source; pass github:owner/repo#ref/path, a git URL or a local path" };

	const github = GITHUB.exec(spec);
	if (github !== null) {
		const { owner, repo, tail } = github.groups;
		const { ref, path } = splitFragment(tail);
		return {
			ok: true,
			spec: { kind: "github", url: `https://github.com/${owner}/${repo}.git`, ref, path, raw: spec },
		};
	}

	// A remote URL is judged by the part before `#`: the fragment is ours, not git's.
	const hashIndex = spec.indexOf("#");
	const urlPart = hashIndex === -1 ? spec : spec.slice(0, hashIndex);
	if (GIT_URL.test(urlPart)) {
		const { ref, path } = splitFragment(hashIndex === -1 ? undefined : spec.slice(hashIndex + 1));
		return { ok: true, spec: { kind: "git-url", url: urlPart, ref, path, raw: spec } };
	}

	const localPath = resolve(expandTilde(spec));
	if (!exists(localPath)) {
		return { ok: false, error: `local path does not exist: ${localPath}` };
	}
	if (!isDirectory(localPath) && !isFile(localPath)) {
		return { ok: false, error: `local source is neither a directory nor a file: ${localPath}` };
	}
	return { ok: true, spec: { kind: "local", localPath, raw: spec } };
}

/** Human-readable form of a parsed spec, used in command output and manifest entries. */
export function describeSource(spec) {
	if (spec.kind === "local") return spec.raw;
	const path = spec.path === undefined ? "" : `/${spec.path}`;
	return spec.kind === "github" ? `github:${spec.url.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "")}#${spec.ref}${path}` : `${spec.url}#${spec.ref}${path}`;
}

/** Whether a spec is absolute-path based (used by the manifest to mark non-portable sources). */
export function isPortableSource(spec) {
	return spec.kind !== "local" && !isAbsolute(spec.raw ?? "");
}

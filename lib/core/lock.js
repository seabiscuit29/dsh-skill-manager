// Machine-local mutation lock. One writer at a time across the web host, the
// CLI and any second profile sharing the same skill root. Fail-fast by design:
// a queued second writer would only trade a clear error for a confusing delay.
import { execFileSync } from "node:child_process";
import { exists, readText, removePath, writeFileAtomic } from "./fsutil.js";
import { lockPath } from "./paths.js";

/** A lock older than this is considered abandoned (crashed process). */
const STALE_MS = 10 * 60 * 1000;

/** Read the lock record, or undefined when absent/corrupt. */
function readRecord(file) {
	const text = readText(file);
	if (text === undefined) return undefined;
	try {
		const record = JSON.parse(text);
		return typeof record === "object" && record !== null ? record : undefined;
	} catch {
		return undefined;
	}
}

/** Whether a pid is still running on this machine. */
function pidAlive(pid) {
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

/**
 * When a process started, as `ps` reports it.
 *
 * A bare `kill(pid, 0)` cannot tell "the process that took this lock" from "some process
 * that inherited its pid": macOS recycles pids aggressively, and a crashed host whose pid
 * was handed to anything long-lived looks like a live holder for the whole staleness
 * window, failing every mutation with "another skill operation is in progress". Comparing
 * the start time distinguishes the two — for the same pid they are fixed, so a difference
 * proves the pid was reused.
 *
 * Best effort by design: `ps` is missing on Windows and can be refused outright inside a
 * sandbox, in which case locks fall back to liveness alone rather than refusing to work.
 * @returns the start time, or undefined when it cannot be determined.
 */
export function processStart(pid) {
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
	if (process.platform === "win32") return undefined; // `ps` is not available; pid liveness decides
	try {
		const output = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
			encoding: "utf8",
			timeout: 5_000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		const text = output.trim();
		return text === "" ? undefined : text;
	} catch {
		return undefined;
	}
}

/**
 * Who holds the lock, when it is still held; undefined when free.
 * Abandoned when the record is unreadable, older than the staleness window, held by a
 * process that is gone, or held by a pid whose process start time no longer matches —
 * the pid-reuse case, which is the one a liveness check alone gets wrong.
 */
export function lockHolder() {
	const file = lockPath();
	const record = readRecord(file);
	if (record === undefined) return undefined;
	const at = typeof record.at === "number" ? record.at : 0;
	if (Date.now() - at > STALE_MS || !pidAlive(record.pid)) return undefined;
	if (typeof record.started === "string" && record.started !== "") {
		const started = processStart(record.pid);
		if (started !== undefined && started !== record.started) return undefined;
	}
	return record;
}

/**
 * Run a mutation under the lock, releasing it even when the body throws.
 * @param fn - async body owning the mutation.
 * @param label - human-readable operation name recorded in the lock.
 */
export async function withLock(fn, label = "skill operation") {
	const file = lockPath();
	const holder = lockHolder();
	if (holder !== undefined) {
		throw new Error(
			`another skill operation is in progress (${holder.label ?? "unknown"}, pid ${holder.pid}); retry in a moment`,
		);
	}
	if (exists(file)) removePath(file);
	const started = processStart(process.pid);
	await writeFileAtomic(
		file,
		JSON.stringify({ pid: process.pid, at: Date.now(), label, ...(started === undefined ? {} : { started }) }, null, 2),
	);
	try {
		return await fn();
	} finally {
		const current = readRecord(file);
		if (current !== undefined && current.pid === process.pid) removePath(file);
	}
}

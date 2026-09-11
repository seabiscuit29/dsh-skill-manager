// Machine-local mutation lock. One writer at a time across the web host, the
// CLI and any second profile sharing the same skill root. Fail-fast by design:
// a queued second writer would only trade a clear error for a confusing delay.
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

/** Who holds the lock, when it is still held; undefined when free. */
export function lockHolder() {
	const file = lockPath();
	const record = readRecord(file);
	if (record === undefined) return undefined;
	const at = typeof record.at === "number" ? record.at : 0;
	if (Date.now() - at > STALE_MS || !pidAlive(record.pid)) return undefined;
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
	await writeFileAtomic(file, JSON.stringify({ pid: process.pid, at: Date.now(), label }, null, 2));
	try {
		return await fn();
	} finally {
		const current = readRecord(file);
		if (current !== undefined && current.pid === process.pid) removePath(file);
	}
}

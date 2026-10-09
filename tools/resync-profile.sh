#!/usr/bin/env bash
# resync-profile.sh — re-snapshot the current source into the profile
# (macOS / Linux twin of tools/resync-profile.ps1).
#
# pnpm treats a `file:` dependency as up to date by path alone, so `add --force`
# never refreshes the snapshot: a code change without remove+add would boot the old
# code. Reliable refresh is therefore remove, then add.
#
# Usage:
#   bash tools/resync-profile.sh
#   bash tools/resync-profile.sh --dry-run
set -euo pipefail

PROFILE="${PROFILE:-web}"
DRY_RUN=0
while [ $# -gt 0 ]; do
	case "$1" in
		--dry-run) DRY_RUN=1 ;;
		--profile) PROFILE="$2"; shift ;;
		*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
	shift
done

SCRIPT_DIR="$(cd -- "${BASH_SOURCE[0]%/*}" && pwd)"
REPO="$(cd -- "$SCRIPT_DIR/.." && pwd)"
# The path is passed as an argument, never interpolated into the JavaScript source: a
# checkout path containing a quote or a backslash would otherwise produce a syntax error
# or a silently truncated path.
read_manifest_field() {
	node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(m[process.argv[2]]??""))' "$REPO/package.json" "$1"
}
PACKAGE="$(read_manifest_field name)"
VERSION="$(read_manifest_field version)"
SPEC="${SPEC:-file:$REPO}"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"

step() { printf '\n[%s] %s\n' "$1" "$2"; }

# The launcher, in order of preference.
#
# `dsh` is NOT on PATH when the desktop application is the installation: the packaged
# launcher lives inside the .app and is the only executable permitted to manage the
# reserved `desktop` profile — an npm copy refuses with "profile desktop is managed
# exclusively by the Electron application". So look for the packaged launcher FIRST,
# then PATH, and only then fall back to npx for an ordinary web/tui profile.
DSH_LAUNCHER="${DSH_LAUNCHER:-}"
if [ -z "$DSH_LAUNCHER" ]; then
	for candidate in \
		"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
		"$HOME/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"; do
		if [ -x "$candidate" ]; then DSH_LAUNCHER="$candidate"; break; fi
	done
fi
[ -n "$DSH_LAUNCHER" ] || DSH_LAUNCHER="$(command -v dsh 2>/dev/null || true)"

dsh_plugin() {
	if [ -n "$DSH_LAUNCHER" ]; then
		"$DSH_LAUNCHER" plugin --profile "$PROFILE" "$@"
	elif [ "$PROFILE" = "desktop" ]; then
		echo "  the desktop profile can only be managed by the packaged dsh launcher;" >&2
		echo "  pass it with DSH_LAUNCHER=<path to .../runtime/cli/bin/dsh>" >&2
		return 1
	else
		npx -y @deepseek-ai/dsh plugin --profile "$PROFILE" "$@"
	fi
}

echo "profile : $PROFILE_DIR"
echo "package : $REPO ($PACKAGE v$VERSION)"
[ "$DRY_RUN" = 1 ] && echo "mode    : dry run (no files change)"

step 1/3 "Removing the stale snapshot"
if [ "$DRY_RUN" = 1 ]; then
	echo "  would run: dsh plugin --profile $PROFILE remove $PACKAGE"
else
	dsh_plugin remove "$PACKAGE" || echo "  (exit $?, probably not installed — continuing)"
fi

step 2/3 "Reinstalling from source"
if [ "$DRY_RUN" = 1 ]; then
	echo "  would run: dsh plugin --profile $PROFILE add $SPEC"
else
	dsh_plugin add "$SPEC"
fi

step 3/3 "Pre-restart preflight (includes snapshot freshness)"
if [ "$DRY_RUN" = 1 ]; then
	echo "  would run: node $REPO/tools/preflight.mjs --profile $PROFILE"
	echo -e "\ndry run complete; nothing changed."
	exit 0
fi
node "$REPO/tools/preflight.mjs" --profile "$PROFILE" || {
	echo -e "\npreflight failed: do NOT restart dsh web yet." >&2
	exit 1
}

echo -e "\nsnapshot synced and preflight passed. Restart dsh web now."

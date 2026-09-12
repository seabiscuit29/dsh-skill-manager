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
PACKAGE="$(node -e "process.stdout.write(require('$REPO/package.json').name)")"
VERSION="$(node -e "process.stdout.write(require('$REPO/package.json').version)")"
SPEC="${SPEC:-file:$REPO}"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"

step() { printf '\n[%s] %s\n' "$1" "$2"; }

dsh_plugin() {
	if command -v dsh >/dev/null 2>&1; then
		dsh plugin --profile "$PROFILE" "$@"
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

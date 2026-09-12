#!/usr/bin/env bash
# swap-profile.sh — replace the two retired plugins with the merged dsh-skill-manager
# (macOS / Linux twin of tools/swap-profile.ps1).
#
# Order matters, and getting it wrong makes the profile refuse to boot:
#   back up → remove the retired packages → clean their profile inserts → install the
#   new bundle → run the pre-restart preflight.
#
# Usage:
#   bash tools/swap-profile.sh                 # execute
#   bash tools/swap-profile.sh --dry-run       # print the plan only
#   bash tools/swap-profile.sh --spec git+https://github.com/<owner>/dsh-skill-manager.git
set -euo pipefail

PROFILE="${PROFILE:-web}"
# Pure-bash path resolution: no reliance on external `dirname`, so the script also
# runs in minimal shells.
SCRIPT_DIR="$(cd -- "${BASH_SOURCE[0]%/*}" && pwd)"
REPO="$(cd -- "$SCRIPT_DIR/.." && pwd)"
SPEC="${SPEC:-file:$REPO}"
DRY_RUN=0

while [ $# -gt 0 ]; do
	case "$1" in
		--dry-run) DRY_RUN=1 ;;
		--spec) SPEC="$2"; shift ;;
		--profile) PROFILE="$2"; shift ;;
		*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
	shift
done

DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
PKG_FILE="$PROFILE_DIR/package.json"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
BACKUP_DIR="${BACKUP_DIR:-$REPO/backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"

RETIRED=("@deepseek-ai/dsh-client-ui-settings-skills" "@deepseek-ai/dsh-skill-manager")

step() { printf '\n[%s] %s\n' "$1" "$2"; }

# The official channel: `dsh plugin` forwards to pnpm inside the profile directory.
dsh_plugin() {
	if command -v dsh >/dev/null 2>&1; then
		dsh plugin --profile "$PROFILE" "$@"
	else
		npx -y @deepseek-ai/dsh plugin --profile "$PROFILE" "$@"
	fi
}

[ -f "$PKG_FILE" ] || { echo "profile package.json not found: $PKG_FILE" >&2; exit 1; }
[ -f "$PATCH_FILE" ] || { echo "profile cordis.patch.yml not found: $PATCH_FILE" >&2; exit 1; }

echo "profile : $PROFILE_DIR"
echo "spec    : $SPEC"
[ "$DRY_RUN" = 1 ] && echo "mode    : dry run (no files change)"

step 1/5 "Backing up the profile's package.json and cordis.patch.yml"
if [ "$DRY_RUN" = 1 ]; then
	echo "  would copy into $BACKUP_DIR"
else
	mkdir -p "$BACKUP_DIR"
	cp "$PKG_FILE" "$BACKUP_DIR/profile-$PROFILE-package.json.bak-$STAMP"
	cp "$PATCH_FILE" "$BACKUP_DIR/profile-$PROFILE-cordis.patch.yml.bak-$STAMP"
	echo "  $BACKUP_DIR/profile-$PROFILE-*.bak-$STAMP"
fi

step 2/5 "Removing the retired plugins"
for name in "${RETIRED[@]}"; do
	if [ "$DRY_RUN" = 1 ]; then
		echo "  would run: dsh plugin --profile $PROFILE remove $name"
	else
		echo "  remove $name"
		dsh_plugin remove "$name" || echo "  (exit $?, probably not installed — continuing)"
	fi
done

step 3/5 "Cleaning their inserts from cordis.patch.yml"
CLEAN_ARGS=(--patch "$PATCH_FILE")
for name in "${RETIRED[@]}"; do CLEAN_ARGS+=(--remove "$name"); done
[ "$DRY_RUN" = 1 ] && CLEAN_ARGS+=(--dry-run)
node "$REPO/tools/profile-patch-clean.mjs" "${CLEAN_ARGS[@]}"

step 4/5 "Installing the merged plugin"
if [ "$DRY_RUN" = 1 ]; then
	echo "  would run: dsh plugin --profile $PROFILE add $SPEC"
else
	dsh_plugin add "$SPEC"
fi

step 5/5 "Pre-restart preflight"
if [ "$DRY_RUN" = 1 ]; then
	echo "  would run: node $REPO/tools/preflight.mjs --profile $PROFILE"
	echo -e "\ndry run complete; nothing changed."
	exit 0
fi
node "$REPO/tools/preflight.mjs" --profile "$PROFILE" || {
	echo -e "\npreflight failed: do NOT restart dsh web yet." >&2
	echo "rollback: cp '$BACKUP_DIR/profile-$PROFILE-package.json.bak-$STAMP' '$PKG_FILE'" >&2
	echo "          cp '$BACKUP_DIR/profile-$PROFILE-cordis.patch.yml.bak-$STAMP' '$PATCH_FILE'" >&2
	exit 1
}

echo -e "\nPreflight passed. Restart dsh web now (Ctrl+C in its terminal, then start it again)."

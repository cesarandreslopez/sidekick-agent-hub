#!/usr/bin/env bash
# One-off cleanup of orphaned "Claude Code-credentials-<hash>" Keychain items (macOS).
#
# Claude Code names a config directory's Keychain item "Claude Code-credentials-"
# plus the first 8 hex characters of sha256(<directory>). When the directory is
# deleted the item stays behind, still holding a copy of a login. Sidekick builds
# before 0.27.6 minted such items whenever they ran against a throwaway
# SIDEKICK_CONFIG_DIR with the real HOME (for example inside another project's
# test suite).
#
# This script lists every suffixed item whose suffix matches none of the
# directories you still use. It cannot tell who created an item: other tools use
# CLAUDE_CONFIG_DIR too, so review the list and add those directories with --keep.
# It never reads a secret (attributes only) and deletes nothing without --delete
# plus a confirmation.
#
# Usage:
#   scripts/claude-keychain-orphans.sh [--keep DIR]... [--delete]
#
# Always kept: every Sidekick profile home, $CLAUDE_CONFIG_DIR of this shell,
# ~/.claude, and every --keep DIR. The unsuffixed "Claude Code-credentials" item
# (your normal login) is never listed.

set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This script is for the macOS Keychain; other platforms keep credentials in files." >&2
  exit 1
fi

keep_dirs=()
delete=0
while [ $# -gt 0 ]; do
  case "$1" in
    --keep)
      keep_dirs+=("$2")
      shift 2
      ;;
    --delete)
      delete=1
      shift
      ;;
    -h | --help)
      sed -n '2,23p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

config_root="${SIDEKICK_CONFIG_DIR:-$HOME/.config/sidekick}"
keep_dirs+=("$HOME/.claude")
[ -n "${CLAUDE_CONFIG_DIR:-}" ] && keep_dirs+=("$CLAUDE_CONFIG_DIR")
for home in "$config_root"/accounts/claude/profiles/*/home; do
  [ -d "$home" ] && keep_dirs+=("$home")
done

suffix_of() {
  printf %s "$1" | shasum -a 256 | cut -c1-8
}

keep_suffixes=" "
for dir in "${keep_dirs[@]}"; do
  keep_suffixes+="$(suffix_of "$dir") "
  # The same directory spelled through its resolved path.
  if resolved="$(cd "$dir" 2>/dev/null && pwd -P)"; then
    keep_suffixes+="$(suffix_of "$resolved") "
  fi
done

# service <TAB> creation time, attributes only (no -d: no secret is read).
items="$(
  security dump-keychain 2>/dev/null | awk '
    /^keychain: / { if (svc != "") print svc "\t" cdat; svc = ""; cdat = "" }
    /"svce"<blob>="Claude Code-credentials-[0-9a-f]+"/ {
      match($0, /Claude Code-credentials-[0-9a-f]+/); svc = substr($0, RSTART, RLENGTH)
    }
    /"cdat"<timedate>=/ { if (match($0, /"[0-9]+Z/)) cdat = substr($0, RSTART + 1, RLENGTH - 1) }
    END { if (svc != "") print svc "\t" cdat }
  '
)"

candidates=()
while IFS=$'\t' read -r service created; do
  [ -n "$service" ] || continue
  suffix="${service##*-}"
  case "$keep_suffixes" in
    *" $suffix "*) continue ;;
  esac
  candidates+=("$service")
  printf '%s\t%s\n' "$service" "$created"
done <<< "$items"

echo "${#candidates[@]} suffixed Claude Code Keychain item(s) match no kept directory." >&2
[ "${#candidates[@]}" -gt 0 ] || exit 0

if [ "$delete" -ne 1 ]; then
  echo "Dry run. Review the list, add directories you still use with --keep, then re-run with --delete." >&2
  exit 0
fi

printf 'Delete these %d Keychain item(s)? This cannot be undone. [y/N] ' "${#candidates[@]}" >&2
read -r answer
case "$answer" in
  y | Y | yes | YES) ;;
  *)
    echo "Aborted; nothing was deleted." >&2
    exit 1
    ;;
esac

deleted=0
for service in "${candidates[@]}"; do
  if security delete-generic-password -s "$service" >/dev/null 2>&1; then
    deleted=$((deleted + 1))
  else
    echo "Could not delete $service" >&2
  fi
done
echo "Deleted $deleted item(s)." >&2

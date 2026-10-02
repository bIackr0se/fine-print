#!/bin/sh
set -eu

package_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
scope=${1:-user}
case "$scope" in
  user|project|local) ;;
  *) printf '%s\n' 'Usage: sh install.sh [user|project|local]' >&2; exit 2 ;;
esac

command -v claude >/dev/null 2>&1 || {
  printf '%s\n' 'Claude Code is required. Install or update it from https://code.claude.com/docs/en/setup, then run this command again.' >&2
  exit 1
}

claude plugin marketplace add "$package_root"
claude plugin install fine-print@jr-mods --scope "$scope"
printf '%s\n' 'Fine Print is installed. Start a new local session in Claude Desktop’s Code tab, then use /fineprint.'

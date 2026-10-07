#!/bin/sh
# A curator through Claude Code: see claude.ts for its environment variables.
exec bun "$(dirname "$0")/claude.ts" "$@"

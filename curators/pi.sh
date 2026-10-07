#!/bin/sh
# A gather curator through Pi: see pi.ts for its environment variables.
exec bun "$(dirname "$0")/pi.ts" "$@"

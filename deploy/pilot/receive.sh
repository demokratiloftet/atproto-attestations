#!/bin/sh
# Root-owned forced command for the dedicated CI SSH account. No shell, forwarding or arbitrary commands.
set -eu
set -f
set -- ${SSH_ORIGINAL_COMMAND:-}
if [ "$#" -ne 3 ] || [ "$1" != deploy ]; then
  echo 'Only an affiliation image deployment is allowed.' >&2
  exit 1
fi
exec sudo -n /usr/local/lib/affiliation-pilot/deploy.py "$2" "$3"

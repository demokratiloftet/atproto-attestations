#!/bin/sh
# One-time VPS operator setup. Never runs in the application or in pull-request CI.
set -eu
if [ "$(id -u)" -ne 0 ] || [ "$#" -ne 1 ]; then
  echo 'Usage (as root): install-ci.sh PUBLIC_KEY_FILE' >&2
  exit 1
fi
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
key=$(cat "$1")
case "$key" in
  'ssh-ed25519 '*) ;;
  *) echo 'Expected an Ed25519 public key' >&2; exit 1 ;;
esac
if ! getent passwd affiliation-deploy >/dev/null; then
  adduser --system --group --home /var/lib/affiliation-deploy --shell /bin/sh --disabled-password affiliation-deploy
fi
[ "$(getent passwd affiliation-deploy | cut -d: -f6)" = /var/lib/affiliation-deploy ]
install -d -o root -g root -m 755 /usr/local/lib/affiliation-pilot
install -o root -g root -m 755 "$script_dir/deploy.py" "$script_dir/receive.sh" /usr/local/lib/affiliation-pilot/
install -d -o root -g root -m 755 /var/lib/affiliation-deploy /var/lib/affiliation-deploy/.ssh
printf 'restrict,command="/usr/local/lib/affiliation-pilot/receive.sh" %s\n' "$key" > /var/lib/affiliation-deploy/.ssh/authorized_keys
chown root:root /var/lib/affiliation-deploy/.ssh/authorized_keys
chmod 644 /var/lib/affiliation-deploy/.ssh/authorized_keys
sudoers=$(mktemp)
trap 'rm -f "$sudoers"' EXIT
printf '%s\n' 'affiliation-deploy ALL=(root) NOPASSWD: /usr/local/lib/affiliation-pilot/deploy.py *' > "$sudoers"
visudo -cf "$sudoers"
install -o root -g root -m 440 "$sudoers" /etc/sudoers.d/affiliation-deploy
printf '%s\n' 'Installed restricted image receiver. The CI account has no Docker group or interactive shell access.'

#!/bin/sh
# Namecheap dynamic DNS: sets DDNS_HOST.DDNS_DOMAIN to this network's public IP when it changes.
# The password is Namecheap's Dynamic DNS password (Advanced DNS → Dynamic DNS), from the systemd credential
# namecheap-ddns. (Namecheap's full API needs a whitelisted client IP, which a dynamic IP breaks; this endpoint does not.)
set -eu
: "${DDNS_HOST:?}" "${DDNS_DOMAIN:?}"
state="${STATE_DIRECTORY:-/var/lib/gd-ddns}/last-ip"
pass=$(cat "$CREDENTIALS_DIRECTORY/namecheap-ddns")
ip=$(curl -fsS --max-time 10 https://api.ipify.org)
case "$ip" in *[!0-9.]* | '') echo "unexpected public IP: $ip" >&2; exit 1 ;; esac
[ "$(cat "$state" 2>/dev/null || true)" = "$ip" ] && exit 0
# The password goes in the query string because that is Namecheap's interface; it is sent over https only.
out=$(curl -fsS --max-time 20 --get https://dynamicdns.park-your-domain.com/update \
  --data-urlencode "host=$DDNS_HOST" --data-urlencode "domain=$DDNS_DOMAIN" \
  --data-urlencode "password=$pass" --data-urlencode "ip=$ip")
case "$out" in
  *"<ErrCount>0</ErrCount>"*) echo "$ip" > "$state"; echo "$DDNS_HOST.$DDNS_DOMAIN → $ip" ;;
  *) echo "Namecheap refused the update: $(echo "$out" | tr -d '\r\n' | sed 's/.*<Err1>\(.*\)<\/Err1>.*/\1/')" >&2; exit 1 ;;
esac

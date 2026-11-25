#!/bin/sh
# EXAMPLE external signer for [audit.attest]: ML-DSA-65 via OpenSSL >= 3.5.
# gnomon writes the 64-hex head digest to stdin; we print the signature as
# base64 on stdout (set signature_encoding = "base64", algorithm = "ml-dsa-65").
#
#   openssl genpkey -algorithm ML-DSA-65 -out mldsa.key
#   openssl pkey -in mldsa.key -pubout -out mldsa.pub
#   [audit.attest]
#   sign = "sh docs/examples/pq-signer-openssl.sh /path/to/mldsa.key"
#   verify = "sh docs/examples/pq-signer-openssl.sh --verify /path/to/mldsa.pub"
#   algorithm = "ml-dsa-65"
#
# Set OPENSSL to an OpenSSL >= 3.5 binary when the login shell's `openssl`
# is older (macOS ships LibreSSL first on PATH).
#
# Not run in CI unless openssl >= 3.5 is present. Keep the key off this machine
# where you can; gnomon never holds it.
set -eu
OPENSSL=${OPENSSL:-openssl}
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/digest"
if [ "${1:-}" = "--verify" ]; then
  # GNOMON_ATTEST_SIGNATURE carries the base64 signature; exit 0 = valid.
  printf %s "$GNOMON_ATTEST_SIGNATURE" | "$OPENSSL" base64 -d -A > "$tmp/sig"
  "$OPENSSL" pkeyutl -verify -pubin -inkey "$2" -rawin -in "$tmp/digest" -sigfile "$tmp/sig" >/dev/null
else
  "$OPENSSL" pkeyutl -sign -inkey "$1" -rawin -in "$tmp/digest" -out "$tmp/sig"
  "$OPENSSL" base64 -A -in "$tmp/sig"
fi

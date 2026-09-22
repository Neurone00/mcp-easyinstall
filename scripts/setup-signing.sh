#!/bin/bash
# Create a self-signed code-signing identity, once, on this machine.
#
# Why: the app was ad-hoc signed, and an ad-hoc signature is keyed to the
# binary's hash. Every rebuild therefore produced a new identity, and macOS
# stopped matching it to the Accessibility permission the user had granted —
# so "Arrange windows" broke after every update even though the toggle was on.
#
# A self-signed certificate gives a stable identity that survives rebuilds, so
# the grant sticks. It is NOT Apple notarisation: Gatekeeper still asks for the
# Privacy & Security step on first open. It costs nothing.
#
# This lives on the BUILD machine only. People who receive the app install
# nothing — the signature travels inside the .app.
set -euo pipefail

NAME="Moskito Easy MCP Signing"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-identity -v -p codesigning 2>/dev/null | grep -q "$NAME"; then
  echo "Signing identity already present: $NAME"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Creating a self-signed code-signing certificate…"
openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" \
  -subj "/CN=$NAME/O=Moskito Design" \
  -addext "basicConstraints=critical,CA:false" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning" 2>/dev/null

# macOS's Security framework cannot read OpenSSL 3's default PKCS#12
# encryption (AES-256 with a SHA-256 MAC) and fails with "MAC verification
# failed". These older algorithms are what it expects.
openssl pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
  -name "$NAME" -out "$TMP/id.p12" -passout pass:temp \
  -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1 2>/dev/null

# -T /usr/bin/codesign lets codesign use the key without prompting every build.
security import "$TMP/id.p12" -k "$KEYCHAIN" -P temp -T /usr/bin/codesign -A
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$TMP/cert.pem" 2>/dev/null || \
  echo "  (could not mark it trusted automatically — signing usually still works)"

if security find-identity -v -p codesigning 2>/dev/null | grep -q "$NAME"; then
  echo "Done. Builds will now sign with: $NAME"
  echo
  echo "The first build after this will ask for your keychain password once per"
  echo "signed binary. Click ALWAYS ALLOW, not Allow — Always Allow records the"
  echo "permission against the key, so it never asks again. Clicking Allow makes"
  echo "it ask on every build, which looks like a loop."
else
  echo "The certificate was imported but is not listed as a codesigning identity."
  echo "Open Keychain Access, find \"$NAME\", and set its trust for Code Signing to Always Trust."
  exit 1
fi

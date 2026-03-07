#!/usr/bin/env bash
set -euo pipefail

required_vars=(
  GITHUB_APP_ID
  GITHUB_INSTALLATION_ID
  GITHUB_APP_PRIVATE_KEY_PATH
)

for var_name in "${required_vars[@]}"; do
  if [[ -z "${!var_name:-}" ]]; then
    echo "Missing required environment variable: ${var_name}" >&2
    exit 1
  fi
done

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required" >&2
  exit 1
fi

if [[ ! -f "${GITHUB_APP_PRIVATE_KEY_PATH}" ]]; then
  echo "Private key file not found: ${GITHUB_APP_PRIVATE_KEY_PATH}" >&2
  exit 1
fi

base64url() {
  openssl base64 -A | tr '+/' '-_' | tr -d '='
}

now_epoch="$(date +%s)"
issued_at="$((now_epoch - 60))"
expires_at="$((now_epoch + 540))"

header='{"alg":"RS256","typ":"JWT"}'
payload="$(printf '{"iat":%s,"exp":%s,"iss":"%s"}' "${issued_at}" "${expires_at}" "${GITHUB_APP_ID}")"

header_b64="$(printf '%s' "${header}" | base64url)"
payload_b64="$(printf '%s' "${payload}" | base64url)"
unsigned_token="${header_b64}.${payload_b64}"

signature_b64="$(
  printf '%s' "${unsigned_token}" \
    | openssl dgst -binary -sha256 -sign "${GITHUB_APP_PRIVATE_KEY_PATH}" \
    | base64url
)"

jwt="${unsigned_token}.${signature_b64}"

response="$(
  curl --silent --show-error --fail \
    -X POST \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer ${jwt}" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/app/installations/${GITHUB_INSTALLATION_ID}/access_tokens"
)"

python3 - <<'PY' "${response}"
import json
import sys

payload = json.loads(sys.argv[1])
token = payload.get("token")
if not token:
    raise SystemExit("GitHub did not return an installation token")
print(token)
PY

#!/usr/bin/env bash
# Decide how publish-npm.yml authenticates to npm, before anything is
# downloaded: trusted publishing (OIDC), the NPM_TOKEN secret, or neither.
#
#   scripts/npm-publish-auth.sh
#
# Writes `mode=oidc` or `mode=token` to $GITHUB_OUTPUT, or exits 1 with the
# exact one-time setup that is missing. CI-only: it needs the GitHub Actions
# OIDC endpoint, which exists only in a job with `id-token: write`.
#
# Environment:
#   HAS_NPM_TOKEN   "true" when the NPM_TOKEN repository secret is set. The
#                   workflow passes `secrets.NPM_TOKEN != ''`, so this script
#                   never receives the token itself.
#   GITHUB_REPOSITORY, ACTIONS_ID_TOKEN_REQUEST_URL, ACTIONS_ID_TOKEN_REQUEST_TOKEN
#                   set by the runner.
#
# HOW IT KNOWS. npm's trusted publishing (GA 2025-07-31, npm CLI >= 11.5.1)
# exchanges the job's GitHub OIDC token for a short-lived token that can
# publish ONE package, at
#
#   POST https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/<name>
#
# and the registry grants it only when that package's trusted publisher on
# npmjs.com names this repository and this workflow file. This script makes the
# request npm itself makes (lib/utils/oidc.js in npm/cli), once per package,
# and keeps the HTTP status only: the response body, which holds the exchanged
# token, goes to /dev/null. It is never stored, printed or used. `npm publish`
# performs its own exchange.
#
# WHY ASK FIRST. Without this, a run with two of four packages configured and no
# token publishes two and fails on the third, and the failure says only
# "ENEEDAUTH". The run is idempotent, so a re-run would finish the job, but the
# message would not have said what to configure. This says it before anything
# is published.
#
# WHY THE TOKEN IS WITHHELD IN OIDC MODE. When every package is configured, the
# workflow does not hand NPM_TOKEN to the publish step at all, even if the
# secret still exists. A green run in OIDC mode is then proof that the token is
# no longer needed and can be deleted, not a run that quietly used it.
set -euo pipefail

PACKAGES="gnomon-core gnomon-natives gnomon-tui gnomon-harness"
WORKFLOW_FILE="publish-npm.yml"
REGISTRY="https://registry.npmjs.org"
NPM_MIN="11.5.1"
REPO="${GITHUB_REPOSITORY:-eljaplacido/gnomonharness}"
OWNER="${REPO%%/*}"
NAME="${REPO#*/}"

out() {
    if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "$1" >> "$GITHUB_OUTPUT"; else echo "$1"; fi
}

setup_steps() {
    cat <<EOF
One-time setup on npmjs.com (docs/RELEASING.md → "Publishing to npm"). For EACH
of these four packages:

    gnomon-core   gnomon-natives   gnomon-tui   gnomon-harness

open https://www.npmjs.com/package/<name>/access (signed in as a maintainer),
find "Trusted Publisher", choose "GitHub Actions", and enter exactly:

    Organization or user:  $OWNER
    Repository:            $NAME
    Workflow filename:     $WORKFLOW_FILE
    Environment name:      (leave empty)

Then re-run this workflow ("Re-run jobs"). It is idempotent: versions already
on the registry are skipped.
EOF
}

# ── can this job do OIDC at all? ─────────────────────────────────────────────
oidc_reason=""
npm_version=$(npm --version 2>/dev/null || echo "0")
if [ "$(printf '%s\n%s\n' "$NPM_MIN" "$npm_version" | sort -V | head -n 1)" != "$NPM_MIN" ]; then
    oidc_reason="npm $npm_version is older than $NPM_MIN, the first with trusted publishing"
elif [ -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ] || [ -z "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ]; then
    oidc_reason="the job has no OIDC token (it needs permissions: id-token: write)"
fi

configured=""; missing=""; unknown=""
if [ -z "$oidc_reason" ]; then
    # GitHub's ID token, with the audience npm asks for. Masked in case anything
    # downstream ever echoes it; nothing here does.
    id_token=$(curl -fsS --retry 2 \
        -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
        -H "Accept: application/json" \
        "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=npm%3Aregistry.npmjs.org" | jq -r '.value // empty') || id_token=""
    if [ -z "$id_token" ]; then
        oidc_reason="GitHub did not issue an OIDC token for audience npm:registry.npmjs.org"
    else
        echo "::add-mask::$id_token"
        for p in $PACKAGES; do
            status=$(curl -sS -o /dev/null -w '%{http_code}' --retry 2 -X POST \
                -H "Authorization: Bearer $id_token" \
                "$REGISTRY/-/npm/v1/oidc/token/exchange/package/$p") || status="000"
            case "$status" in
                2??) configured="$configured $p" ;;
                000|429|5??) unknown="$unknown $p(HTTP $status)" ;;
                *) missing="$missing $p" ;;
            esac
            echo "  trusted publishing for $p: HTTP $status"
        done
        unset id_token
    fi
fi

# ── decide ───────────────────────────────────────────────────────────────────
if [ -z "$oidc_reason" ] && [ -z "$missing" ] && [ -z "$unknown" ]; then
    echo "npm: trusted publishing (OIDC) is configured for all four packages; NPM_TOKEN is not used."
    if [ "${HAS_NPM_TOKEN:-false}" = "true" ]; then
        echo "::notice title=NPM_TOKEN is no longer needed::Trusted publishing covers gnomon-core, gnomon-natives, gnomon-tui and gnomon-harness, and this run does not pass NPM_TOKEN to npm. Delete the repository secret NPM_TOKEN and revoke the token on npmjs.com (docs/RELEASING.md)."
    fi
    out "mode=oidc"
    exit 0
fi

if [ -n "$oidc_reason" ]; then
    why="trusted publishing is unavailable: $oidc_reason"
elif [ -n "$unknown" ]; then
    why="the registry could not be asked about:$unknown"
else
    why="no trusted publisher matches this workflow for:$missing"
fi

if [ "${HAS_NPM_TOKEN:-false}" = "true" ]; then
    echo "::warning title=Publishing with NPM_TOKEN (fallback)::npm $why. Falling back to the NPM_TOKEN secret, which is to be deleted once all four packages trust $REPO/.github/workflows/$WORKFLOW_FILE (docs/RELEASING.md)."
    [ -z "$configured" ] || echo "  already trusted:$configured"
    setup_steps
    out "mode=token"
    exit 0
fi

echo "::error title=npm publishing is not set up::Neither trusted publishing nor the NPM_TOKEN secret is available ($why). Configure a trusted publisher for gnomon-core, gnomon-natives, gnomon-tui and gnomon-harness with workflow file $WORKFLOW_FILE in $REPO; the log has the exact fields."
[ -z "$configured" ] || echo "  already trusted:$configured"
setup_steps
echo
echo "Stopgap only: a granular access token for those four packages, added as the"
echo "repository secret NPM_TOKEN, makes this workflow publish with it instead."
exit 1

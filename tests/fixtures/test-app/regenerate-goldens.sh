#!/usr/bin/env bash
# regenerate-goldens.sh — rebuild the expected/<version>.json maps
# from a fresh sigmatcher pass against newly-built APKs.
#
# Run this AFTER an intentional change to either:
#
#   * tests/fixtures/test-app/signatures/test-app.yaml
#   * tools/adapters/sigmatcher.ts (or its CLI)
#   * src/types/map.ts (the schema)
#   * Java sources / seeds (changes the rotation pattern)
#
# Workflow:
#
#   1. The script builds both APKs (v1.0.0 + v1.1.0).
#   2. Runs sigmatcher against each, capturing the raw JSON output.
#   3. Pipes the raw JSON through the adapter to produce
#      expected/v1.0.0.json + expected/v1.1.0.json.
#   4. Prints `git diff` against the previous goldens.
#   5. Asks you to manually `git add` + commit the new files.
#
# The script does NOT auto-commit — review the diff first.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
APP_DIR="$SCRIPT_DIR/app"
SIGS="$SCRIPT_DIR/signatures/test-app.yaml"
EXPECTED="$SCRIPT_DIR/expected"
ADAPTER_CLI="$REPO_ROOT/tools/adapters/sigmatcher-cli.ts"

# ── Tunables ─────────────────────────────────────────────────────────
VERSIONS=("v1.0.0" "v1.1.0")
# Authoritative version_code per build — must mirror app/build.gradle.kts
# (`versionCode = if (applyMappingVersion == "v1.1.0") 2 else 1`).
version_code_for() {
    case "$1" in
        v1.1.0) echo 2 ;;
        *) echo 1 ;;
    esac
}
APP_PKG="com.example.testapp"
WORK_DIR="${WORK_DIR:-/tmp/rosetta-pipeline}"
CACHE_DIR="${WORK_DIR}/sigmatcher-cache"

# ── methodNameMap: definition → real method name ─────────────────────
# Multi-overload methods are authored as two MethodDefinition entries
# in test-app.yaml. The adapter re-merges them under one real key.
METHOD_NAME_MAP_FILE="${WORK_DIR}/methodNameMap.json"

# ── classKindMap: real FQN → schema `kind` ───────────────────────────
# Sigmatcher cannot infer kind; the adapter takes it from the caller.
CLASS_KIND_MAP_FILE="${WORK_DIR}/classKindMap.json"

mkdir -p "$WORK_DIR" "$CACHE_DIR" "$EXPECTED"

# ── Helpers ──────────────────────────────────────────────────────────
warn() { echo "[regenerate-goldens] $*" >&2; }

require_cmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        warn "missing required command: $1"
        exit 1
    fi
}

require_cmd java
require_cmd sigmatcher
require_cmd npx

warn "WARNING: this script is about to OVERWRITE the following files:"
for v in "${VERSIONS[@]}"; do
    warn "  $EXPECTED/$v.json"
done
warn "Review the resulting git diff before committing."

# ── Write auxiliary maps the adapter needs ───────────────────────────
cat >"$METHOD_NAME_MAP_FILE" <<'EOF'
{
    "put_2arg": "put",
    "put_3arg": "put"
}
EOF

cat >"$CLASS_KIND_MAP_FILE" <<'EOF'
{
    "com.example.testapp.IRemoteService$Stub": "aidl_stub",
    "com.example.testapp.IRemoteService": "interface",
    "com.example.testapp.IServiceCallback$Stub": "aidl_stub",
    "com.example.testapp.IServiceCallback": "aidl_callback",
    "com.example.testapp.Config": "class",
    "com.example.testapp.BlobCache": "class",
    "com.example.testapp.RemoteService": "class",
    "com.example.testapp.RemoteService$1": "anonymous",
    "com.example.testapp.Ticket": "class",
    "com.example.testapp.Ticket$Companion": "synthetic",
    "com.example.testapp.Ticket$Reader": "class",
    "com.example.testapp.ErrorCode": "enum",
    "com.example.testapp.AbstractServiceClient": "class",
    "com.example.testapp.AbstractServiceClient$1": "anonymous",
    "com.example.testapp.RemoteServiceClient": "class",
    "com.example.testapp.PromiseCallback": "interface"
}
EOF

# Note: IRemoteService maps to "interface" but the v1.0.0 / v1.1.0
# golden currently leaves IRemoteService's `kind` undefined. The
# classKindMap is the regeneration source of truth — re-running this
# script will set the kind. If you intentionally want it undefined,
# remove the line from CLASS_KIND_MAP_FILE before regenerating.

# ── Per-version pass ─────────────────────────────────────────────────
for v in "${VERSIONS[@]}"; do
    warn "── building APK for $v ──"
    (
        cd "$SCRIPT_DIR"
        ./gradlew --quiet :app:assembleRelease "-PapplyMapping=$v"
    )
    APK="$WORK_DIR/$v.apk"
    cp "$APP_DIR/build/outputs/apk/release/app-release-unsigned.apk" "$APK"
    warn "APK captured at $APK ($(stat -c%s "$APK") bytes)"

    RAW="$WORK_DIR/$v.raw.json"
    warn "── running sigmatcher against $APK ──"
    sigmatcher analyze "$APK" \
        --signatures "$SIGS" \
        --output-format raw \
        --output-file "$RAW" \
        --no-progress \
        --cache-dir "$CACHE_DIR"

    OUT="$EXPECTED/$v.json"
    warn "── running adapter to produce $OUT ──"
    # Strip the leading "v" to get a clean semver in the `version`
    # field of the emitted map (e.g. "v1.0.0" → "1.0.0"). The
    # authoritative version_code comes from version_code_for().
    npx tsx "$ADAPTER_CLI" "$RAW" \
        --app "$APP_PKG" \
        --version "${v#v}" \
        --version-code "$(version_code_for "$v")" \
        --method-name-map "$METHOD_NAME_MAP_FILE" \
        --class-kind-map "$CLASS_KIND_MAP_FILE" \
        -o "$OUT"
    warn "wrote $OUT"
done

warn ""
warn "── DIFF AGAINST PREVIOUS GOLDENS ──"
git --no-pager diff -- "$EXPECTED" || true
warn ""
warn "Review the diff above. If it matches your intent, run:"
warn "  git add tests/fixtures/test-app/expected/"
warn "  git commit -m 'Regenerate test-app goldens: <why>'"

#!/usr/bin/env bash
set -euo pipefail

# Assert the publish tarball ships the right thing: the `files` allowlist
# in package.json must include `dist/` and `maps/` and must NOT leak
# `src/` or tests. `npm pack --dry-run --json` lists the exact files
# without producing an artifact. Shared by ci.yml (pack-smoke) and
# release.yml (verify-package-contents) so the two can't drift.

files="$(npm pack --dry-run --json | node -e '
    const pkgs = JSON.parse(require("fs").readFileSync(0, "utf8"));
    for (const f of pkgs[0].files) console.log(f.path);
')"
echo "::group::packed files"
echo "$files"
echo "::endgroup::"
echo "$files" | grep -q "^dist/" || { echo "::error::tarball missing dist/"; exit 1; }
echo "$files" | grep -q "^maps/" || { echo "::error::tarball missing maps/"; exit 1; }
if echo "$files" | grep -qE "^src/|(^|/)tests/|\.test\.ts$"; then
    echo "::error::tarball leaks source or tests"; exit 1
fi
echo "package contents OK"

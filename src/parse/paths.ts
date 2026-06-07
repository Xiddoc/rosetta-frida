/**
 * Path & identity hardening for the CLI writers.
 *
 * Two security primitives live here, shared by every command that builds
 * an on-disk path from user input (`init`, `convert`, `extract`, `patch`):
 *
 *   1. `assertValidApp` / `assertValidVersion` — validate the `app` and
 *      `version` tokens *before* they are interpolated into a path. A
 *      malicious `app` like `../../etc` or an absolute `/etc/cron.d` must
 *      never reach `path.join`, so the validators reject `/`, `\`, `..`,
 *      NUL, and absolute-looking tokens outright via strict allowlists.
 *
 *   2. `assertContained` — after a path has been **derived from map content**
 *      (e.g. `init`'s default `maps/<app>/<version>.json`), resolve it and
 *      assert it stays inside the project tree (CWD). This is the backstop
 *      against any remaining traversal escape in the derived path.
 *
 *      NOTE: `assertContained` is intentionally NOT applied to explicit
 *      operator-supplied `-o`/`--output` paths. An operator may legitimately
 *      write outside CWD (e.g. `/tmp/extracted.json`). The security boundary
 *      is on paths *derived from untrusted map content*, not on operator
 *      choices. `assertNoNul` is still called on all path arguments.
 *
 * Both throw `RosettaError` so the CLI surfaces a clean `error: ...` line
 * rather than a stack trace.
 */

import * as path from 'node:path';
import { RosettaError } from '../errors.js';

/**
 * Android package names: a dotted identifier. First segment starts with a
 * letter; every segment is `[A-Za-z0-9_]+`; at least two segments (a real
 * package always has a TLD-like prefix, e.g. `com.example.app`).
 */
const APP_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;

/** Version labels: dotted/dashed alphanumerics, e.g. `3.4.5`, `1.2.3-rc1`. */
const VERSION_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Reject any path token that could be used to climb out of the project
 * tree or smuggle a NUL byte: path separators, `..` segments, NUL, or an
 * absolute path. Shared by the app/version validators (which forbid
 * separators entirely) — kept separate so the error message can name the
 * offending kind.
 */
function hasTraversalChars(value: string): boolean {
    return (
        value.includes('/') || value.includes('\\') || value.includes('\0') || value.includes('..')
    );
}

/**
 * Validate an `app` (package-name) token before it is used to build a
 * path. Must match {@link APP_RE} and contain no traversal characters.
 *
 * @throws RosettaError on any invalid token.
 */
export function assertValidApp(app: string): void {
    if (hasTraversalChars(app) || path.isAbsolute(app) || !APP_RE.test(app)) {
        throw new RosettaError(
            `invalid app name '${app}': expected a dotted package identifier ` +
                `like 'com.example.app' (letters, digits, underscores; no '/', '\\', '..', or NUL)`,
        );
    }
}

/**
 * Validate a `version` token before it is used to build a path. Must
 * match {@link VERSION_RE} and contain no traversal characters.
 *
 * @throws RosettaError on any invalid token.
 */
export function assertValidVersion(version: string): void {
    if (hasTraversalChars(version) || path.isAbsolute(version) || !VERSION_RE.test(version)) {
        throw new RosettaError(
            `invalid version '${version}': expected a label like '3.4.5' ` +
                `(letters, digits, '.', '-', '_'; no '/', '\\', '..', or NUL)`,
        );
    }
}

/**
 * Reject a NUL byte in any raw path argument. NUL terminates strings in
 * the underlying syscalls, so a `foo.json\0.png` can desync the extension
 * check from what the kernel actually opens.
 *
 * @throws RosettaError if `p` contains a NUL.
 */
export function assertNoNul(p: string): void {
    if (p.includes('\0')) {
        throw new RosettaError(`invalid path '${p}': contains a NUL byte`);
    }
}

/**
 * Assert that the output path `out` resolves to a location inside the
 * project tree (the current working directory). Returns the resolved
 * absolute path so callers can use it directly.
 *
 * Use this only for paths **derived from map content** (e.g. `init`'s
 * default `maps/<app>/<version>.json`). Do NOT call this on
 * operator-supplied `-o`/`--output` flags — operators may legitimately
 * write anywhere (e.g. `/tmp/out.json`); use `assertNoNul` for those.
 *
 * The containment rule allows writing to the base directory itself and
 * anything strictly beneath it, but rejects siblings/parents and absolute
 * escapes (`/etc/passwd`, `../../x`, …).
 *
 * SYMLINKS: this check operates purely on the *lexical* resolved path
 * (`path.resolve`, which does not follow symlinks). A pre-existing symlink
 * *inside* the tree that points outside it is therefore NOT caught here —
 * the CLI commands run against a dependency-injected fs that exposes no
 * `realpath`/`lstat`, and the threat model is contributor-supplied path
 * *strings*, not a pre-poisoned working tree. Following symlinks would
 * require expanding the fs seam and is left for a follow-up. Documented as
 * a known limitation per the audit's "refuse or document" guidance.
 *
 * @throws RosettaError if `out` lexically escapes the project tree.
 */
export function assertContained(out: string): string {
    assertNoNul(out);
    const base = path.resolve(process.cwd());
    const resolved = path.resolve(out);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
        throw new RosettaError(
            `refusing to write outside the project tree: '${out}' resolves to '${resolved}' ` +
                `(must stay within '${base}')`,
        );
    }
    return resolved;
}

/**
 * The default on-disk path for a map: `maps/<app>/<version_code>.json`.
 *
 * The basename is the `version_code` (not the versionName) to obey the
 * canonical rosetta-maps invariant: `basename == version_code`. Shared by
 * every command that derives a default map path (`init`, `pull`) so the
 * one filename rule lives in exactly one place.
 */
export function defaultMapPath(app: string, version_code: number): string {
    return path.join('maps', app, `${version_code}.json`);
}

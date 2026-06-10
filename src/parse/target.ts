/**
 * Shared `<app>@<version_code>` target parser.
 *
 * `rosetta pull` accepts the positional target form `com.example.app@30405`,
 * so the `@`-separator / digits-only grammar lives here in exactly one place
 * (alongside the shared {@link defaultMapPath} helper) rather than being
 * inlined into the command. The only per-verb difference is the literal that
 * prefixes the error messages, threaded in as `verb`, so the parser stays
 * reusable should another verb adopt the same target grammar.
 */

import { RosettaError } from '../errors.js';

/**
 * Parse `<app>@<version_code>` from a positional argument.
 *
 * The `@` separator is REQUIRED and must appear exactly once — it makes the
 * version_code unambiguous and keeps the single-positional form terse
 * (`rosetta <verb> com.example.app@30405`). Zero `@` (one part) and multiple
 * `@` (3+ parts) are both rejected. The `version_code` token must be a bare
 * run of decimal digits parsing to a positive integer (so `1e3`, despite
 * `Number('1e3') === 1000`, is rejected).
 *
 * @param raw  The positional target string.
 * @param verb The CLI verb name (e.g. `'pull'`) used only as the
 *             error-message prefix so each verb's diagnostics name itself.
 * @throws RosettaError on any malformed target.
 */
export function parseAppVersionTarget(
    raw: string,
    verb: string,
): { app: string; version_code: number } {
    const parts = raw.split('@');
    // Exactly one `@`: a single split yields two parts. Zero `@` (one part)
    // and multiple `@` (3+ parts) are both ambiguous and rejected.
    if (parts.length !== 2) {
        throw new RosettaError(
            `${verb} target must be <app>@<version_code> with exactly one '@' ` +
                `(e.g. com.example.app@30405); got '${raw}'`,
        );
    }
    const [app, vcRaw] = parts as [string, string];
    if (app === '') {
        throw new RosettaError(
            `${verb} target must be <app>@<version_code> (e.g. com.example.app@30405); ` +
                `the app name before '@' is empty in '${raw}'`,
        );
    }
    // Strict decimal-digits guard: `Number('1e3')` is 1000 but `1e3` is not a
    // valid version_code token. Require a bare run of ASCII digits.
    if (!/^\d+$/.test(vcRaw)) {
        throw new RosettaError(
            `version_code in '${raw}' must be a positive integer (decimal digits only); got '${vcRaw}'`,
        );
    }
    const version_code = Number(vcRaw);
    if (!Number.isInteger(version_code) || version_code <= 0) {
        throw new RosettaError(
            `version_code in '${raw}' must be a positive integer; got '${vcRaw}'`,
        );
    }
    return { app, version_code };
}

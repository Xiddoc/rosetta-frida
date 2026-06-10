/**
 * Pure semantic-verify engine over one loaded {@link RosettaMap}.
 *
 * Runs SEMANTIC checks the schema cannot express — cross-entry relationships
 * within one map — and classifies each finding by {@link VerifySeverity}:
 *
 * **HARD errors** (a real, fail-the-build defect):
 *   - **Duplicate obfuscated class names within a dex.** Two real classes
 *     sharing both the same `obfuscated` short name AND the same `dex` shard
 *     collide at resolution time. Across different dex shards the same short
 *     name is legal (R8 reuses `a`/`b`/... per shard), so the check is scoped
 *     per `dex`.
 *   - **Unparseable signatures.** A method `signature` the descriptor parser
 *     rejects.
 *
 * **WARNINGS** (heuristic cross-references — informative, never fatal):
 *   - **Dangling `extends`.** A class whose `extends` names a REAL app-class
 *     (dotted, app-package-prefixed) that is not itself a key in `classes`.
 *   - **Un-translated arg types.** A method `signature` whose argument
 *     descriptors reference an app-class real name not in `classes`.
 *
 * ## Why the cross-reference checks are warnings, not errors
 *
 * They rest on the `isAppName` heuristic: "a dotted name under the app's
 * package prefix should have a map entry." That is a *guess*. A map is
 * routinely partial (you only map the classes you hook), and legitimate
 * vendor/library packages can sit under the app's own prefix — e.g. an app
 * `com.google.android.apps.foo` legitimately references
 * `com.google.android.gms.*` / `com.google.android.material.*` library
 * classes it never maps. To eliminate those cross-namespace false positives
 * the prefix is matched against the FULL `map.app` (not a 2-segment slice),
 * and the findings are downgraded to warnings so a partial-but-correct map
 * never fails the build on a heuristic guess.
 */

import { parseSignatureArgs } from '../resolver/signature.js';
import type { MethodEntry, RosettaMap } from '../types/map.js';

/** Severity of a semantic finding. HARD fails the build; WARNING informs. */
export type VerifySeverity = 'error' | 'warning';

/** One semantic finding. */
export interface VerifyIssue {
    /** Dotted path into the map (mirrors the validate issue shape). */
    path: string;
    /** Human-readable description of the inconsistency. */
    message: string;
    /** Whether this is a hard error (fails the build) or a heuristic warning. */
    severity: VerifySeverity;
}

/**
 * Whether a name looks like a REAL (unobfuscated) fully-qualified name —
 * heuristically, it contains a dot. Obfuscated short names (`aaaa`, `a$b`)
 * never carry a package dot, so this cleanly separates "we expected a
 * real-name mapping" from "this is an obfuscated framework reference we
 * deliberately left unmapped".
 */
function looksRealName(name: string): boolean {
    return name.includes('.');
}

/**
 * Whether a dotted name shares the app's FULL package prefix — i.e. it is an
 * app-owned class we might expect a map entry for. Matched against the
 * complete `map.app` (e.g. `com.google.android.apps.foo`), NOT a 2-segment
 * slice, so a legitimate cross-namespace library ref under a shared vendor
 * prefix (`com.google.android.gms.Bar`) is correctly NOT treated as app-owned
 * and never flagged. (See module doc: this is why the dependent checks are
 * warnings, not errors.)
 */
function isAppName(name: string, map: RosettaMap): boolean {
    return name.startsWith(`${map.app}.`);
}

/**
 * Check each class's `extends` resolves to a known real class. Only an
 * APP-namespace real-name parent (one we would own a mapping for) is flagged
 * when missing; a framework superclass is a legitimate dotted real name that
 * is never a map key, and an obfuscated parent (no dot) is the deliberate
 * "unmapped framework helper" case — both are skipped. Emitted as a WARNING:
 * a partial map legitimately omits parents it does not hook.
 */
function checkDanglingExtends(map: RosettaMap, issues: VerifyIssue[]): void {
    for (const [name, entry] of Object.entries(map.classes)) {
        const parent = entry.extends;
        if (
            parent !== undefined &&
            looksRealName(parent) &&
            isAppName(parent, map) &&
            !(parent in map.classes)
        ) {
            issues.push({
                path: `classes.${name}.extends`,
                message: `extends app class '${parent}' which is not a key in classes`,
                severity: 'warning',
            });
        }
    }
}

/** Check no two real classes share an obfuscated name within one dex shard. */
function checkDuplicateObfuscated(map: RosettaMap, issues: VerifyIssue[]): void {
    // Key by `${dex} ${obfuscated}`; '(no-dex)' groups dex-less entries.
    const seen = new Map<string, string>();
    for (const [name, entry] of Object.entries(map.classes)) {
        const dex = entry.dex ?? '(no-dex)';
        const key = `${dex} ${entry.obfuscated}`;
        const prior = seen.get(key);
        if (prior !== undefined) {
            issues.push({
                path: `classes.${name}.obfuscated`,
                message:
                    `obfuscated name '${entry.obfuscated}' in dex '${dex}' ` +
                    `collides with class '${prior}'`,
                severity: 'error',
            });
        } else {
            seen.set(key, name);
        }
    }
}

/**
 * Check a method signature's argument descriptors don't reference a dotted
 * (real-name) app class missing from `classes`. An unparseable signature is a
 * HARD error (a genuinely malformed descriptor); an un-translated app
 * real-name ref is a WARNING (the heuristic cross-reference).
 */
function checkSignatureRefs(
    className: string,
    methodName: string,
    entry: MethodEntry,
    map: RosettaMap,
    issues: VerifyIssue[],
): void {
    let descriptors: string[];
    try {
        descriptors = parseSignatureArgs(entry.signature);
    } catch (err) {
        issues.push({
            path: `classes.${className}.methods.${methodName}`,
            message: `unparseable signature '${entry.signature}': ${(err as Error).message}`,
            severity: 'error',
        });
        return;
    }
    for (const desc of descriptors) {
        const ref = objectRefName(desc);
        if (ref === undefined) continue;
        if (looksRealName(ref) && isAppName(ref, map) && !(ref in map.classes)) {
            issues.push({
                path: `classes.${className}.methods.${methodName}.signature`,
                message:
                    `signature references real class '${ref}' which is not a key in classes ` +
                    `(was it left un-translated?)`,
                severity: 'warning',
            });
        }
    }
}

/**
 * Pull the dotted class name out of one already-split object descriptor
 * (`Landroid/os/Bundle;`, `[Lcom/x/Y;`), or undefined for a primitive.
 * Slashes are converted to dots so it can be compared against map keys.
 */
function objectRefName(descriptor: string): string | undefined {
    const body = descriptor.replace(/^\[+/, '');
    if (!body.startsWith('L') || !body.endsWith(';')) return undefined;
    return body.slice(1, -1).replace(/\//g, '.');
}

/**
 * Run every semantic check over a validated map and return the findings
 * (empty array means consistent). Each finding carries a {@link VerifySeverity}:
 * `error` findings are real defects (duplicate obfuscated names, unparseable
 * signatures) and should fail a build; `warning` findings are heuristic
 * cross-references (dangling `extends`, un-translated arg types) that a
 * partial-but-correct map can legitimately trip. Pure — exported for unit
 * tests and programmatic callers.
 */
export function verifyMap(map: RosettaMap): VerifyIssue[] {
    const issues: VerifyIssue[] = [];
    checkDanglingExtends(map, issues);
    checkDuplicateObfuscated(map, issues);
    for (const [className, entry] of Object.entries(map.classes)) {
        for (const [methodName, overloads] of Object.entries(entry.methods ?? {})) {
            for (const overload of overloads) {
                checkSignatureRefs(className, methodName, overload, map, issues);
            }
        }
    }
    return issues;
}

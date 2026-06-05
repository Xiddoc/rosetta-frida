/**
 * Target-namespace guard (RFC 0001 C1, critical security fix).
 *
 * THREAT. A community map maps a real name to an ARBITRARY obfuscated
 * string, and the runtime feeds that string verbatim into `Java.use(...)`
 * (`src/proxy/class-proxy.ts`, `src/api/hook.ts`). A malicious or simply
 * wrong map could therefore redirect a hook at a sensitive framework class
 * — `java.lang.Runtime`, `android.app.*`, a `dagger.internal.Provider`,
 * etc. — and the bridge would happily load it.
 *
 * MITIGATION. A *target* (the FQN passed to `Java.use`:
 * `ResolvedClass.obfName` and `ResolvedMethod`/`ResolvedField.className`,
 * plus the mapped output of `translateType`) is confined to the app's own /
 * package-local namespace, with an explicit escape-hatch allowlist for
 * legitimate framework hooks. Anything else is rejected fail-closed — the
 * resolver THROWS `TargetPolicyError` BEFORE the `Java.use` call. There is
 * no warn-and-proceed mode (strict only).
 *
 * This is the Frida twin of the Kotlin `TargetGuard` in rosetta-xposed;
 * the decision order and {@link DEFAULT_DENY_PREFIXES} are mirrored
 * value-for-value so the two clients accept/reject the same maps.
 */

import { TargetPolicyError } from '../errors.js';
import type { TargetPolicy } from '../types/session.js';

/**
 * Reserved top-level package prefixes a target may NOT resolve into (matched
 * on a dot boundary — `java.` denies `java.lang.Runtime` but not a
 * hypothetical `javafoo.Bar`). These are runtime/framework namespaces a map
 * has no legitimate reason to point an obfuscated app class at.
 *
 * MIRRORS the Kotlin `DEFAULT_DENY_PREFIXES` value-for-value. Keep the two
 * lists in lockstep.
 */
export const DEFAULT_DENY_PREFIXES: readonly string[] = [
    'java.',
    'javax.',
    'jdk.',
    'sun.',
    'com.sun.',
    'dalvik.',
    'android.',
    'androidx.',
    'com.android.',
    'kotlin.',
    'kotlinx.',
    'dagger.',
    'com.google.android.',
    'libcore.',
    'org.apache.harmony.',
];

/** Default number of leading app-package labels that form the app prefix. */
export const DEFAULT_APP_NAMESPACE_LABELS = 2;

/** Source-form primitive / void keywords — never loadable classes. */
const PRIMITIVE_KEYWORDS = new Set([
    'void',
    'boolean',
    'byte',
    'char',
    'short',
    'int',
    'long',
    'float',
    'double',
]);

/** A denial outcome: which rule rejected the target, or `null` when allowed. */
type Denial = { reason: 'reserved-namespace' | 'foreign-namespace'; message: string } | null;

/** Normalization outcome: a loadable element FQN, or "always allow". */
type Normalized = { kind: 'always-allow' } | { kind: 'element'; fqn: string };

/**
 * The effective denylist for a policy after applying `mergeDenylist`
 * (default true → augment the built-in list; false → replace it).
 */
function effectiveDenyPrefixes(policy: TargetPolicy): readonly string[] {
    const supplied = policy.denyPrefixes ?? [];
    const merge = policy.mergeDenylist ?? true;
    return merge ? [...DEFAULT_DENY_PREFIXES, ...supplied] : supplied;
}

/**
 * Derive the app namespace prefix: the first `appNamespaceLabels`
 * dot-separated labels of `app` (default 2). `<= 0` labels → empty prefix
 * (no app-owned namespace is implicitly allowed).
 */
export function appPrefixOf(app: string, policy: TargetPolicy = {}): string {
    const labels = policy.appNamespaceLabels ?? DEFAULT_APP_NAMESPACE_LABELS;
    if (labels <= 0) return '';
    return app.split('.').slice(0, labels).join('.');
}

/**
 * Strip array markers down to the element class FQN. Handles both the
 * reflective form (`[[Lcom.example.Foo;`) and a source-ish form
 * (`com.example.Foo[]`). Primitives / void (single-letter descriptors or
 * the keyword forms) and the empty string are "always allow" — they are
 * never loadable classes a hook could be redirected at.
 */
function normalize(fqn: string): Normalized {
    let s = fqn.trim();
    // `com.example.Foo[]` → `com.example.Foo`
    while (s.endsWith('[]')) {
        s = s.slice(0, -2).trim();
    }
    // Leading `[` array-depth markers (reflective array class names).
    let i = 0;
    while (i < s.length && s[i] === '[') i += 1;
    const body = s.slice(i);
    const hadArray = i > 0;

    if (body.length === 0) return { kind: 'always-allow' };

    // Reflective object-array element: `Lcom.example.Foo;` (or with `/`).
    if (hadArray && body.length >= 2 && body.startsWith('L') && body.endsWith(';')) {
        const inner = body.slice(1, -1).replace(/\//g, '.');
        return inner.length === 0 ? { kind: 'always-allow' } : { kind: 'element', fqn: inner };
    }

    // After stripping array markers, a single-char body is a primitive
    // descriptor (Z B C S I J F D) or void (V) — not a loadable class.
    if (hadArray && body.length === 1) return { kind: 'always-allow' };

    // Bare primitive / void keywords (source form).
    if (PRIMITIVE_KEYWORDS.has(body)) return { kind: 'always-allow' };

    return { kind: 'element', fqn: body.replace(/\//g, '.') };
}

/**
 * True if `namespace` equals `prefix` (sans trailing dot) or sits under it
 * on a dot boundary. `prefix` carries a trailing dot (e.g. `java.`).
 */
function matchesPrefix(namespace: string, prefix: string): boolean {
    if (namespace.startsWith(prefix)) return true;
    // Defensive: let `java.` also match a bare `java` namespace.
    return namespace === prefix.replace(/\.$/, '');
}

/**
 * The single decision point. Returns `null` when the target is allowed, or
 * a typed denial when forbidden. Decision order (fail-closed):
 *
 *  0. primitive / void / empty after normalization → ALLOW (not loadable);
 *  1. exact-FQN allowlist → ALLOW;
 *  2. top-level prefix on the reserved denylist → DENY (even if it also
 *     matches the app prefix);
 *  3. package-local (no `.`) → ALLOW;
 *  4. starts with the app's own prefix (dot boundary) → ALLOW;
 *  5. else → DENY.
 */
function decide(fqn: string, appPrefix: string, policy: TargetPolicy): Denial {
    const norm = normalize(fqn);
    if (norm.kind === 'always-allow') return null;
    const element = norm.fqn;

    // (1) explicit escape hatch — exact, case-sensitive FQN match.
    if (policy.allow?.includes(element)) return null;

    // The namespace is everything before the first nested-class `$`.
    const dollar = element.indexOf('$');
    const namespace = dollar < 0 ? element : element.slice(0, dollar);

    // (2) reserved denylist (dot-boundary), highest priority after allow.
    const denied = effectiveDenyPrefixes(policy).find((p) => matchesPrefix(namespace, p));
    if (denied !== undefined) {
        return {
            reason: 'reserved-namespace',
            message: `namespace '${namespace}' is on the reserved denylist (prefix '${denied}')`,
        };
    }

    // (3) package-local: no dot in the namespace at all.
    if (!namespace.includes('.')) return null;

    // (4) app's own prefix, on a dot boundary.
    if (appPrefix.length > 0 && matchesPrefix(namespace, `${appPrefix}.`)) return null;

    // (5) everything else is foreign — deny.
    return {
        reason: 'foreign-namespace',
        message: `namespace '${namespace}' is neither package-local nor within the app prefix '${appPrefix.length > 0 ? appPrefix : '<none>'}'`,
    };
}

/**
 * Decide whether `fqn` is an allowed resolution target for an app whose
 * namespace prefix is `appPrefix`, under `policy`. Pure; see {@link decide}
 * for the decision order.
 */
export function isTargetAllowed(
    fqn: string,
    appPrefix: string,
    policy: TargetPolicy = {},
): boolean {
    return decide(fqn, appPrefix, policy) === null;
}

/**
 * Assert that `fqn` (produced for real name `realName`) is an allowed
 * target, or throw {@link TargetPolicyError}. The throw happens before any
 * `Java.use` call, so a forbidden target never reaches Frida.
 *
 * `classScope` is the owning class real-name when the target is a
 * method/field/arg-type class (vs. a top-level class lookup).
 */
export function assertTargetAllowed(
    realName: string,
    fqn: string,
    appPrefix: string,
    policy: TargetPolicy = {},
    classScope?: string,
): void {
    const denial = decide(fqn, appPrefix, policy);
    if (denial === null) return;
    const scopeSuffix = classScope === undefined ? '' : ` (on '${classScope}')`;
    throw new TargetPolicyError(
        `rosetta-frida: target '${fqn}' for real name '${realName}'${scopeSuffix} is forbidden by the namespace guard: ${denial.message}.`,
        realName,
        fqn,
        denial.reason,
        classScope,
    );
}

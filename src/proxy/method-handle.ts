/**
 * Method-handle proxy — wraps a Frida-side method (the value of
 * `Java.use(obfClass).<obfMethod>`) with real-name → obf translation
 * on overload selection and ambiguity-aware `.implementation` access.
 *
 * Public contract: `MethodHandle` in `../types/proxy.ts`.
 *
 * Behaviour summary:
 *
 *   - `.overload(...argTypes)` — each `argType` is run through
 *     `resolver.translateType(...)` so users may freely pass real names
 *     ('IServiceCallback'), framework types ('android.os.Bundle'), or
 *     primitives ('int', 'boolean') in any combination. The translated
 *     names are forwarded to the bare Frida method's `.overload(...)`.
 *     The returned overload bundle is shaped like an `OverloadHandle`
 *     (Frida's overloads expose `argumentTypes`, `returnType`, and
 *     `implementation`).
 *
 *   - `.overloads` — bare passthrough of the Frida method's overloads
 *     array. Tier-3 callers can inspect or iterate.
 *
 *   - `.implementation` (get + set) — consults the Resolver: if the
 *     resolver knows this real method name maps to a single overload,
 *     we delegate to the native method's `.implementation` accessor.
 *     Otherwise we throw `AmbiguousOverloadError` — directing the
 *     caller to `.overload(...)`.
 *
 *   - `.$native` — the bare Frida method object (Tier-3 escape hatch).
 */
import type { MethodHandle, OverloadHandle } from '../types/proxy.js';
import type { Resolver } from '../types/resolver.js';

interface NativeMethod {
    overload(...argTypes: readonly string[]): OverloadHandle;
    overloads: readonly OverloadHandle[];
    implementation: ((...args: unknown[]) => unknown) | null;
}

/**
 * Build a `MethodHandle` over `native[obfMethodName]`.
 *
 * `classRealName` and `methodRealName` are carried so we can ask the
 * resolver about overload ambiguity at `.implementation` time without
 * re-deriving them.
 */
export function makeMethodHandle(
    resolver: Resolver,
    classRealName: string,
    methodRealName: string,
    native: unknown,
    obfMethodName: string,
): MethodHandle {
    const lookupNative = (): NativeMethod => {
        const m = (native as Record<string, NativeMethod | undefined>)[obfMethodName];
        if (m === undefined) {
            throw new Error(
                `rosetta-frida: method '${obfMethodName}' (real '${methodRealName}' on '${classRealName}') not present on the underlying Java wrapper. The map and the running app likely disagree.`,
            );
        }
        return m;
    };

    const overload = (...argTypes: readonly string[]): OverloadHandle => {
        const translated = argTypes.map((t) => resolver.translateType(t));
        return lookupNative().overload(...translated);
    };

    return {
        overload,
        get overloads(): readonly OverloadHandle[] {
            return lookupNative().overloads;
        },
        get implementation(): ((...args: unknown[]) => unknown) | null {
            assertUnambiguous(resolver, classRealName, methodRealName);
            return lookupNative().implementation;
        },
        set implementation(impl: ((...args: unknown[]) => unknown) | null) {
            assertUnambiguous(resolver, classRealName, methodRealName);
            lookupNative().implementation = impl;
        },
        get $native(): unknown {
            return lookupNative();
        },
    };
}

/**
 * Throw `AmbiguousOverloadError` if the map says this real-name has
 * multiple overloads. The Resolver already raises an
 * `AmbiguousOverloadError` from `resolveMethod(...)` without argTypes
 * in that case, so a plain call (no argTypes) does the check for us
 * and we just let it propagate. Any other error (e.g. an unexpected
 * ResolveError) propagates too — the proxy layer's diagnostics will
 * surface it.
 */
function assertUnambiguous(
    resolver: Resolver,
    classRealName: string,
    methodRealName: string,
): void {
    // The throw happens inside resolveMethod when there are multiple
    // overloads; success means there's exactly one and we're good.
    resolver.resolveMethod(classRealName, methodRealName);
}

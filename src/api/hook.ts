/**
 * `rosetta.hook(...)` — tier-1 declarative method-hook installation.
 *
 * Per design §4.1, this is the headline API: a user names the method
 * in real (unobfuscated) form and supplies an implementation. Behind
 * the scenes we translate to obfuscated names through the Resolver,
 * pick the matching overload (or throw a clear error), and install
 * the implementation through Frida's `Java.use(obfClass)[obfMethod]
 * .overload(...).implementation = ...` surface.
 *
 * Two call shapes, mirroring the design doc:
 *
 *   hook('IRemoteService$Stub.requestTicket', fn);
 *   hook({ class: 'IRemoteService$Stub', method: 'requestTicket',
 *          args: ['android.os.Bundle', 'IServiceCallback'] }, fn);
 *
 * The string form requires the real method name to be unambiguous —
 * if multiple overloads share that name, we throw
 * `AmbiguousOverloadError` (the design's "disambiguate by passing
 * args" message points the user at the object form). The object form
 * is unconditional: the resolver picks the overload via real-name
 * arg types (and translates them internally).
 *
 * `hook` returns a `HookHandle` whose `.detach()` reverts the
 * implementation to whatever was on the overload before the hook was
 * installed (commonly `null`). Detaching twice is a no-op.
 *
 * Resolver injection
 * ------------------
 *
 * Wave 2F is parallel-independent of Wave 2G (the session layer that
 * holds the ambient resolver). Until that lands, callers pass the
 * resolver explicitly via `HookOptions.resolver`. The ambient form
 * `rosetta.hook(target, impl)` is wired up at integration time
 * (Wave 2G).
 */

import { RosettaError } from '../errors.js';
import { defaultJavaBridge, type JavaBridge } from '../java-bridge.js';
import type { Resolver, ResolvedMethod } from '../types/resolver.js';
import { pushProceedFrame, type ProceedFrame } from './proceed.js';

/** Object form for explicit-overload hook attachment. */
export interface HookTarget {
    /** Real fully-qualified class name (or short real name; whatever your map keys on). */
    readonly class: string;
    /** Real method name. */
    readonly method: string;
    /**
     * Real-name argument types for overload disambiguation. The
     * resolver translates entries that match mapped class names;
     * primitives + framework types (e.g. `int`, `android.os.Bundle`)
     * pass through verbatim.
     */
    readonly args: readonly string[];
}

/** Returned from `hook(...)` — supports `.detach()` to revert. */
export interface HookHandle {
    /** Remove the installed implementation, restoring the pre-hook state. */
    detach(): void;
    /** True after `.detach()` has run. */
    readonly detached: boolean;
}

/** Options for `hook` — for now just the resolver (Wave 2G ambient-session later). */
export interface HookOptions {
    /** Resolver for real→obf translation. Required until session ambient lands. */
    readonly resolver: Resolver;
    /**
     * The seam onto Frida's global `Java`. Defaults to the global-reading
     * {@link defaultJavaBridge}. Tests inject a fake bridge instead of
     * mutating `globalThis`.
     */
    readonly javaBridge?: JavaBridge;
}

/** Shape of the user-supplied implementation. Untyped args by design. */
export type HookImpl = (this: unknown, ...args: unknown[]) => unknown;

/**
 * Install a tier-1 hook. Returns a handle whose `.detach()` reverts
 * the installation.
 *
 * Throws `ResolveError` if the class/method isn't in the map, and
 * `AmbiguousOverloadError` if the string form names a multi-overload
 * method without disambiguating args.
 */
export function hook(
    target: string | HookTarget,
    impl: HookImpl,
    options: HookOptions,
): HookHandle {
    const { resolver } = options;
    const bridge = options.javaBridge ?? defaultJavaBridge;
    const { className, methodName, argTypes } = parseTarget(target);

    // Resolve the method; resolver applies overload selection when
    // argTypes is provided, or picks the sole overload otherwise. The
    // resolver's own errors (ResolveError + AmbiguousOverloadError)
    // already carry good context, so we let them propagate unchanged
    // for callers to pattern-match on.
    const resolved: ResolvedMethod = resolver.resolveMethod(className, methodName, argTypes);

    // Java.use(obfClass) — get the native class wrapper, via the bridge.
    const wrapper = bridge.use(resolved.className) as Record<string, unknown>;

    // Look up the method bundle on the wrapper. For mock + real Frida
    // alike, this returns an object with `.overload(...)` and a
    // settable `.implementation` getter.
    const methodBundle = wrapper[resolved.obfName];
    if (methodBundle === undefined) {
        throw new RosettaError(
            `rosetta.hook: method '${resolved.obfName}' not present on native wrapper '${resolved.className}'.`,
        );
    }

    // Select the right overload via translated arg types.
    const translatedArgs = parseSignatureToTranslatedArgs(resolved.signature);
    const overload = callOverload(methodBundle, translatedArgs);

    // Capture the pre-hook implementation so detach can restore it.
    const previous = overload.implementation;

    // Wrap the user's impl: push a proceed frame, run, pop.
    const wrappedImpl = function (this: unknown, ...args: unknown[]): unknown {
        const frame: ProceedFrame = {
            thisRef: this,
            next: (proceedArgs) => {
                if (previous == null) {
                    return undefined;
                }
                return previous.apply(this, proceedArgs);
            },
        };
        const pop = pushProceedFrame(frame);
        try {
            return impl.apply(this, args);
        } finally {
            pop();
        }
    };

    overload.implementation = wrappedImpl;

    let detached = false;
    return {
        get detached() {
            return detached;
        },
        detach() {
            if (detached) return;
            detached = true;
            overload.implementation = previous;
        },
    };
}

/** Split a string target on the last `.`; pass an object target through. */
function parseTarget(target: string | HookTarget): {
    className: string;
    methodName: string;
    argTypes: readonly string[] | undefined;
} {
    if (typeof target === 'string') {
        const dot = target.lastIndexOf('.');
        if (dot <= 0 || dot >= target.length - 1) {
            throw new RosettaError(
                `rosetta.hook: target string '${target}' must be of the form 'ClassName.methodName'.`,
            );
        }
        return {
            className: target.slice(0, dot),
            methodName: target.slice(dot + 1),
            argTypes: undefined,
        };
    }
    return {
        className: target.class,
        methodName: target.method,
        argTypes: target.args,
    };
}

/**
 * Convert the resolved method signature into the args list expected
 * by Frida's `.overload(...)`. The signature in the resolver result
 * is a JVM descriptor like `(Landroid/os/Bundle;Lbbbb;)V` — Frida
 * `.overload` takes class-name-style strings (e.g. `'android.os.Bundle'`,
 * `'bbbb'`). We parse the descriptor and convert each arg.
 *
 * Pulled out as a separate helper so the inversion is testable and
 * the main hook flow stays readable.
 */
function parseSignatureToTranslatedArgs(signature: string): string[] {
    // Extract the parenthesised arg list.
    const close = signature.indexOf(')');
    if (!signature.startsWith('(') || close < 0) {
        throw new RosettaError(
            `rosetta.hook: malformed signature '${signature}' — expected JVM descriptor.`,
        );
    }
    const inner = signature.slice(1, close);
    return parseDescriptorArgs(inner);
}

/**
 * Parse a JVM descriptor arg list (the part between `(` and `)`) into
 * an array of Frida-compatible class/primitive names.
 *
 * Examples:
 *   `Landroid/os/Bundle;Lbbbb;`   → ['android.os.Bundle', 'bbbb']
 *   `I`                            → ['int']
 *   `[Ljava/lang/String;`          → ['[Ljava.lang.String;']   (array form)
 */
function parseDescriptorArgs(desc: string): string[] {
    const out: string[] = [];
    let i = 0;
    while (i < desc.length) {
        let arrayPrefix = '';
        while (desc[i] === '[') {
            arrayPrefix += '[';
            i += 1;
        }
        const ch = desc[i];
        if (ch === undefined) {
            throw new RosettaError(`rosetta.hook: malformed descriptor '${desc}'.`);
        }
        if (ch === 'L') {
            const end = desc.indexOf(';', i);
            if (end < 0) {
                throw new RosettaError(`rosetta.hook: unterminated class ref in '${desc}'.`);
            }
            const fqn = desc.slice(i + 1, end).replace(/\//g, '.');
            // Frida convention for object arg types in .overload:
            //   non-array:  'android.os.Bundle'
            //   array:      '[Landroid.os.Bundle;'
            out.push(arrayPrefix === '' ? fqn : `${arrayPrefix}L${fqn};`);
            i = end + 1;
        } else {
            const name = PRIMITIVE_NAMES[ch];
            if (name === undefined) {
                throw new RosettaError(
                    `rosetta.hook: unknown primitive descriptor '${ch}' in '${desc}'.`,
                );
            }
            out.push(arrayPrefix === '' ? name : `${arrayPrefix}${ch}`);
            i += 1;
        }
    }
    return out;
}

const PRIMITIVE_NAMES: Record<string, string> = {
    Z: 'boolean',
    B: 'byte',
    C: 'char',
    S: 'short',
    I: 'int',
    J: 'long',
    F: 'float',
    D: 'double',
    V: 'void',
};

/**
 * Invoke `.overload(...args)` on a method bundle. Tiny wrapper that
 * exists purely to make the call site readable; the alternative is
 * a type cast forest at the use site.
 */
function callOverload(
    bundle: unknown,
    args: readonly string[],
): {
    implementation: HookImpl | null;
} {
    const fn = (bundle as { overload?: (...a: string[]) => unknown }).overload;
    if (typeof fn !== 'function') {
        throw new RosettaError(
            'rosetta.hook: method bundle is missing .overload() — not a Frida method handle?',
        );
    }
    return fn.call(bundle, ...args) as { implementation: HookImpl | null };
}

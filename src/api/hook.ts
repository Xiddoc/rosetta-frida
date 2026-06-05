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
import { resolveMethodOrSentinel } from '../resolver/resolver.js';
import { extractArgRegion, parseDescriptorArgs } from '../resolver/signature.js';
import { isSentinel } from '../resolver/sentinel.js';
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
 * Honours the resolver's failure policy: under 'strict' a missing
 * class/method throws `ResolveError` at the call site; under 'warn' the
 * resolver emits a miss event and `hook` becomes a no-op, returning an
 * already-detached handle (a hook is an immediate action, so there is
 * nothing to defer to a sentinel — the warning is the miss event).
 * `AmbiguousOverloadError` always throws regardless of policy (the
 * string form named a multi-overload method without disambiguating args).
 */
export function hook(
    target: string | HookTarget,
    impl: HookImpl,
    options: HookOptions,
): HookHandle {
    const { resolver } = options;
    const bridge = options.javaBridge ?? defaultJavaBridge;
    const { className, methodName, argTypes } = parseTarget(target);

    // Resolve the method, honouring the session failure policy. Under
    // 'warn' a miss yields a sentinel (the resolver already emitted the
    // miss event); installing a hook on an unresolved method is a no-op,
    // so we return an already-detached handle instead of throwing or
    // touching Frida. `AmbiguousOverloadError` is not a ResolveError, so
    // it still propagates from the resolver unchanged.
    const maybe = resolveMethodOrSentinel(resolver, className, methodName, argTypes);
    if (isSentinel(maybe)) {
        return { detached: true, detach() {} };
    }
    const resolved: ResolvedMethod = maybe;

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

    // Select the right overload via Frida-shaped arg types, parsed from the
    // resolved JVM descriptor signature by the shared descriptor parser.
    const translatedArgs = parseDescriptorArgs(extractArgRegion(resolved.signature), 'frida');
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

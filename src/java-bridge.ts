/**
 * `JavaBridge` — the single seam onto Frida's global `Java` namespace.
 *
 * Across the runtime we need three things from the host's `Java` global:
 *
 *   1. **access** — call `Java.use(name)` to get a class wrapper;
 *   2. **presence-check** — know whether a `Java` global exists at all
 *      (we may run outside a Frida script, e.g. in unit tests or a CLI);
 *   3. **a canonical error** — when `Java` is absent and a caller needs
 *      it, throw ONE consistent, actionable message instead of each call
 *      site inventing its own `globalThis as {...}` cast + ad-hoc throw.
 *
 * Before this abstraction those three concerns were smeared across
 * `proxy/class-proxy.ts`, `api/hook.ts`, and the three `session/*` detect
 * modules — each with its own `(globalThis as { Java?: ... }).Java` cast
 * and its own "Java is unavailable" wording. `JavaBridge` collapses them
 * into one injected dependency: the default implementation reads the
 * global; tests pass a fake bridge (or a fake `use`) and never touch
 * `globalThis`.
 *
 * The bridge is intentionally generic over the wrapper shape returned by
 * `use(...)`: each subsystem knows the narrow Frida surface it depends on
 * (an `ActivityThread` walk, a method bundle, an AIDL descriptor probe)
 * and casts the `unknown` result to it. The bridge's job is the seam, not
 * the per-wrapper typing.
 */

/** The narrow Frida-`Java` surface the runtime depends on. */
export interface JavaBridge {
    /**
     * True when a usable `Java.use` is reachable. Lets callers branch
     * (e.g. the health check degrades to "nothing verifiable") instead
     * of throwing.
     */
    readonly available: boolean;

    /**
     * Resolve a class wrapper via `Java.use(name)`. Returns `unknown`;
     * the caller casts to the narrow shape it needs.
     *
     * @throws the canonical "Java is unavailable" error (see
     *   {@link JAVA_UNAVAILABLE_MESSAGE}) when no `Java` global is present.
     */
    use(name: string): unknown;
}

/**
 * The one canonical message used whenever a caller needs `Java` but no
 * global is present. Centralised so every subsystem reports the absence
 * identically.
 */
export const JAVA_UNAVAILABLE_MESSAGE =
    "rosetta-frida: global 'Java' is not available. Are you running inside a Frida script?";

/** The minimal global shape we read the `Java` namespace off of. */
interface JavaGlobal {
    Java?: { use?: (name: string) => unknown };
}

/**
 * The default bridge: reads `Java` off `globalThis` lazily on each
 * access so it stays correct if the global is installed after the bridge
 * is constructed (the common test ordering, and the real Frida ordering
 * where the script body runs after the runtime is up).
 */
class GlobalJavaBridge implements JavaBridge {
    get available(): boolean {
        const J = (globalThis as JavaGlobal).Java;
        return typeof J?.use === 'function';
    }

    use(name: string): unknown {
        const J = (globalThis as JavaGlobal).Java;
        if (typeof J?.use !== 'function') {
            throw new Error(JAVA_UNAVAILABLE_MESSAGE);
        }
        return J.use(name);
    }
}

/**
 * The process-wide default bridge. Subsystems accept an optional
 * `JavaBridge`; when omitted they fall back to this one.
 */
export const defaultJavaBridge: JavaBridge = new GlobalJavaBridge();

/**
 * Build a `JavaBridge` from a bare `use(...)` function. Convenience for
 * call sites (and tests) that already hold a `Java.use`-shaped callable
 * and want to adapt it to the bridge contract without writing a class.
 *
 * `available` reflects whether `use` is a function. A bridge built from a
 * defined `use` always throws that same `use`'s own errors on miss; the
 * canonical absence error only fires when `use` is not callable.
 */
export function javaBridgeFromUse(use: ((name: string) => unknown) | undefined): JavaBridge {
    return {
        get available(): boolean {
            return typeof use === 'function';
        },
        use(name: string): unknown {
            if (typeof use !== 'function') {
                throw new Error(JAVA_UNAVAILABLE_MESSAGE);
            }
            return use(name);
        },
    };
}

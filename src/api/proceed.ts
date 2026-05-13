/**
 * `rosetta.proceed(...args)` — call the next-in-chain implementation
 * from inside a tier-1 hook body.
 *
 * Semantics (per design §12.2 Q4): match Frida's normal
 * `this.foo.apply(this, arguments)` semantics — i.e. invoke whatever
 * implementation was on the overload before this hook layered on top
 * (the "previous" link in the chain). When the user's impl wraps a
 * fresh overload, that previous link is whatever Frida's underlying
 * dispatch would call (the original method body). The mock represents
 * that link as a JS function set by the test via the `impl` field on
 * the registered overload spec.
 *
 * Implementation: a module-level proceed-context stack. The `hook`
 * wrapper pushes a frame on entry and pops it on exit. `proceed(...)`
 * reads the top of the stack and delegates.
 *
 * The stack is module-singleton. Frida runs JS single-threaded, so
 * "thread-local" is just "current execution context"; nested hooks
 * (hook A calls proceed which lands in hook B which calls proceed)
 * naturally push and pop frames in LIFO order.
 */

import { RosettaError } from '../errors.js';

/** One entry on the proceed-context stack. */
export interface ProceedFrame {
    /** The `this` reference at the time the hook's wrapped impl was entered. */
    readonly thisRef: unknown;
    /**
     * Invoker for the next link in the chain. Calling this with an args
     * array runs the previous implementation (or the original method)
     * bound to `thisRef`. Returns whatever it returned.
     *
     * Wrapping this as a function (rather than just storing the previous
     * impl callable) lets `hook.ts` describe "what proceed should do"
     * with full context — e.g. it could log, transform args, fall
     * through to a default value when no underlying impl exists, etc.
     */
    readonly next: (args: unknown[]) => unknown;
}

const stack: ProceedFrame[] = [];

/**
 * Push a frame onto the proceed-context stack. Internal — `hook.ts` uses
 * this to set up the context before invoking the user's implementation.
 *
 * Returns a `pop` function the caller must invoke (in a finally block)
 * once the user's implementation has run.
 */
export function pushProceedFrame(frame: ProceedFrame): () => void {
    stack.push(frame);
    let popped = false;
    return () => {
        if (popped) return;
        popped = true;
        // Pop *this* frame regardless of any leakage from nested hooks:
        // the LIFO discipline of try/finally guarantees we own the top
        // when this pop runs in a non-pathological flow. If something
        // pushed a frame and forgot to pop it, we still own no more than
        // our own slot, so popping exactly one entry is safe.
        const idx = stack.lastIndexOf(frame);
        if (idx >= 0) stack.splice(idx, 1);
    };
}

/**
 * Public tier-1 entry point. Call from inside a hook impl to forward
 * to the next-in-chain (Frida's `this.foo.apply(this, arguments)`
 * semantics). Throws when called outside any hook impl context.
 */
export function proceed(...args: unknown[]): unknown {
    const top = stack[stack.length - 1];
    if (top === undefined) {
        throw new RosettaError(
            'rosetta.proceed called outside a hook implementation. ' +
                'Only call proceed(...) from inside a function passed to rosetta.hook(...).',
        );
    }
    return top.next(args);
}

/**
 * Test-only helper — reset the proceed stack. Useful between tests
 * that don't fully clean up after themselves. Not exported from the
 * package; used directly by co-located tests.
 */
export function _resetProceedStack(): void {
    stack.length = 0;
}

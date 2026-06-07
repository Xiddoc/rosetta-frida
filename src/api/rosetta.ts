/**
 * The `rosetta` ambient namespace — the canonical public entry point.
 *
 *   import { rosetta } from 'rosetta-frida';
 *   rosetta.session({ map });
 *   rosetta.hook('IRemoteService$Stub.requestTicket', (bundle, cb) => { ... });
 *   const Stub = rosetta.use('IRemoteService$Stub');
 *   rosetta.map.resolveClass('IFoo');
 *
 * This module composes the agent-supplied tier-1 / tier-2 / tier-3
 * surfaces (each of which takes an explicit `{ resolver }` option) into
 * a single namespace that auto-pulls from the current session. The
 * session is set by `rosetta.session(...)`; subsequent calls replace
 * the active session.
 *
 * Users who prefer explicit composition can still import the underlying
 * functions (`use`, `hook`, `createMapApi`, ...) directly from
 * `rosetta-frida`; this namespace is a convenience layer above them.
 *
 * ## Re-attach / singleton semantics (L12)
 *
 * The ambient session is a single module-level slot. Its lifecycle
 * contract is deliberately simple and deterministic so repeated
 * `Java.perform` blocks (or a hot-reloaded agent) behave predictably:
 *
 *   - **Replace, never stack.** A second `rosetta.session(...)` call
 *     cleanly SUPERSEDES the previous ambient session — it does not throw
 *     and it does not keep the old one around. The new session becomes the
 *     one every subsequent `rosetta.use/hook/map/events` call routes
 *     through. Before swapping, the previous session's diagnostic bus is
 *     cleared so its subscribers stop firing; no listener leaks across the
 *     swap. (Already-installed hooks are unaffected — `rosetta.hook(...)`
 *     captures its session's resolver at install time, per the docs.)
 *   - **`rosetta.reset()` disposes the ambient session.** After a reset
 *     there is no active session, so any ambient call throws the same
 *     `RosettaError` as before the first `session(...)`. Reset also clears
 *     the disposed session's bus. It is idempotent — resetting when no
 *     session is active is a no-op.
 *
 * The replace-on-re-call policy (rather than throw-on-second-call) is the
 * right default for the Frida runtime: an agent re-injected against the
 * same process, or a script that re-runs its `Java.perform` block, must be
 * able to re-open a session without first tearing the old one down.
 */

import { RosettaError } from '../errors.js';
import { createSession, type RosettaSession } from '../session/index.js';
import type { ClassEntry, RosettaMap } from '../types/map.js';
import type { DiagnosticEvent, EventListener } from '../types/events.js';
import type { ClassProxy } from '../types/proxy.js';
import type { ResolvedClass, ResolvedField, ResolvedMethod } from '../types/resolver.js';
import type { Session, SessionOptions } from '../types/session.js';
import { createEventsApi } from './events.js';
import { field as _field, setField as _setField } from './field.js';
import { hook as _hook, type HookHandle, type HookImpl, type HookTarget } from './hook.js';
import { createMapApi } from './map.js';
import { proceed } from './proceed.js';
import { type as _type } from './type.js';
import { use as _use } from './use.js';

let currentSession: RosettaSession | null = null;

/**
 * Internal — get the current session or throw if none is active.
 * Exported for tier-3 callers that want to bridge to a non-ambient
 * function while still using the ambient session.
 */
export function getCurrentSession(): RosettaSession {
    if (currentSession === null) {
        throw new RosettaError(
            'no active rosetta session — call rosetta.session({ map }) before using rosetta.*',
        );
    }
    return currentSession;
}

/**
 * Dispose the active ambient session, if any, and clear the slot.
 *
 * Clears the disposed session's diagnostic bus so its subscribers stop
 * firing, then drops the reference. Idempotent: a no-op when no session is
 * active. Shared by the public {@link rosetta.reset} and by the swap a
 * second `rosetta.session(...)` performs, so both go through one clean
 * teardown path (L12).
 */
function disposeCurrentSession(): void {
    if (currentSession !== null) {
        // Stop the superseded session's subscribers from firing against a
        // session that is no longer ambient — no listener leaks across a
        // reset or a re-attach.
        currentSession.events.clear();
        currentSession = null;
    }
}

/**
 * Internal — reset the ambient session (test helper alias for the public
 * {@link rosetta.reset}). Kept as a named export the test suite imports;
 * delegates to the same {@link disposeCurrentSession} teardown.
 */
export function _resetCurrentSession(): void {
    disposeCurrentSession();
}

/**
 * The canonical user-facing namespace. All methods either operate on
 * the current session (set by `session(...)`) or have no session
 * dependency (like `proceed`).
 */
export const rosetta = {
    /**
     * Create a session and make it the ambient one for subsequent
     * tier-1 / tier-2 / tier-3 calls. Returns the public Session view.
     */
    session(options: SessionOptions): Session {
        // Replace, never stack: cleanly supersede any prior ambient session
        // (clearing its bus) before installing the new one (L12).
        disposeCurrentSession();
        currentSession = createSession(options);
        return currentSession;
    },

    /**
     * Dispose the active ambient session, if any (L12).
     *
     * After `reset()` there is no active session, so any subsequent ambient
     * call (`rosetta.use/hook/map/events`, …) throws the same `RosettaError`
     * as before the first `session(...)`. Idempotent — calling it with no
     * active session is a no-op. Use it to tear a session down explicitly
     * (e.g. between independent `Java.perform` blocks in a long-lived agent)
     * rather than relying on a later `session(...)` to supersede it.
     */
    reset(): void {
        disposeCurrentSession();
    },

    /** Tier 2: resolve a class real-name to a `ClassProxy`. */
    use(realName: string): ClassProxy {
        return _use(realName, { resolver: getCurrentSession().resolver });
    },

    /** Tier 2: translate a real-name type to its obfuscated form (or passthrough). */
    type(realName: string): string {
        return _type(realName, { resolver: getCurrentSession().resolver });
    },

    /**
     * Tier 1: install a declarative method hook.
     *
     * Two forms:
     *   `rosetta.hook('Class.method', (a, b) => { ... })`
     *   `rosetta.hook({ class: 'Class', method: 'm', args: ['Bundle'] }, impl)`
     */
    hook(target: string | HookTarget, impl: HookImpl): HookHandle {
        return _hook(target, impl, { resolver: getCurrentSession().resolver });
    },

    /**
     * Tier 1: from inside a hook implementation, call the original
     * (next-in-chain) method with the given args.
     */
    proceed,

    /** Tier 1: read a field value off an instance by its real name. */
    field(instance: unknown, realFieldName: string): unknown {
        return _field(instance, realFieldName, { resolver: getCurrentSession().resolver });
    },

    /** Tier 1: write a field value on an instance by its real name. */
    setField(instance: unknown, realFieldName: string, value: unknown): void {
        _setField(instance, realFieldName, value, { resolver: getCurrentSession().resolver });
    },

    /**
     * Tier 3: low-level map queries. Property-getter form so the
     * underlying api object is rebuilt each access against the current
     * session (i.e. switching sessions also switches what this returns).
     */
    get map(): {
        resolveClass: (realName: string) => ResolvedClass;
        resolveMethod: (
            className: string,
            methodName: string,
            argTypes?: readonly string[],
        ) => ResolvedMethod;
        resolveField: (className: string, fieldName: string) => ResolvedField;
        override: (realName: string, entry: ClassEntry) => void;
        extract: () => RosettaMap;
    } {
        return createMapApi(getCurrentSession());
    },

    /** Tier 3: subscribe to diagnostic events from the current session. */
    get events(): {
        on: (listener: EventListener) => () => void;
        onType: <T extends DiagnosticEvent['type']>(
            type: T,
            listener: EventListener<Extract<DiagnosticEvent, { type: T }>>,
        ) => () => void;
    } {
        return createEventsApi(getCurrentSession());
    },
};

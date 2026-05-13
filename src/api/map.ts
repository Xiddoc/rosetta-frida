/**
 * Tier 3 `rosetta.map.*` — low-level escape hatches for direct
 * resolver queries and runtime overrides (design §4.3).
 *
 * The Tier 3 surface is intentionally thin: each function delegates
 * to the bound session's Resolver. Users reach for this when they
 * need raw obfuscated names, bridge to plain `Java.use`, or install
 * temporary overrides for hot-patching.
 */

import type { ClassEntry, RosettaMap } from '../types/map.js';
import type { ResolvedClass, ResolvedField, ResolvedMethod } from '../types/resolver.js';
import type { RosettaSession } from '../session/session.js';

/** The shape of the Tier 3 `rosetta.map` surface. */
export interface MapApi {
    /** Resolve a class by real name. Throws ResolveError on miss in strict mode. */
    resolveClass(realName: string): ResolvedClass;
    /**
     * Resolve a method by real names. If multiple overloads exist,
     * pass `argTypes` (real names + framework types) to disambiguate.
     */
    resolveMethod(
        className: string,
        methodName: string,
        argTypes?: readonly string[],
    ): ResolvedMethod;
    /** Resolve a field by real names. */
    resolveField(className: string, fieldName: string): ResolvedField;
    /**
     * Install a runtime override for a class entry. Future lookups see
     * this instead of the map's value. Caches are invalidated for the
     * overridden name automatically.
     */
    override(realName: string, entry: ClassEntry): void;
    /** Returns the bound `RosettaMap` (after registry resolution if applicable). */
    extract(): RosettaMap;
}

/**
 * Build a Tier 3 `map` surface bound to a session.
 *
 * This is the V1 form — the session is explicit. The ambient-session
 * variant (`rosetta.map.resolveClass(...)` without passing a session)
 * lands at integration time when the top-level `rosetta` object is
 * assembled.
 */
export function createMapApi(session: RosettaSession): MapApi {
    return {
        resolveClass: (realName) => session.resolver.resolveClass(realName),
        resolveMethod: (className, methodName, argTypes) =>
            session.resolver.resolveMethod(className, methodName, argTypes),
        resolveField: (className, fieldName) => session.resolver.resolveField(className, fieldName),
        override: (realName, entry) => session.resolver.override(realName, entry),
        extract: () => session.map,
    };
}

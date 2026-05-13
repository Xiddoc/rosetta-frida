/**
 * `rosetta.field(...)` / `rosetta.setField(...)` — tier-1 field access.
 *
 * Per design §4.1: "Field access is rare at tier 1 (fields aren't
 * 'hooked,' they're read/written). One-shot helpers exist for
 * completeness." This module owns those helpers.
 *
 * Both functions take a Java instance and a real field name, translate
 * to the obfuscated field via the Resolver, and reach through the
 * instance's `.value` accessor (Frida's standard field-access shape).
 *
 * Class detection from an instance
 * --------------------------------
 *
 * The Resolver's field API is keyed by real class name. We don't have
 * that directly — we have a Java instance. The Frida (and mock) shape
 * exposes `$className` on each instance, which holds the *obfuscated*
 * class name. We reverse-lookup that to a real class name via the
 * Resolver (the resolver carries the index).
 *
 * Fallback chain when `$className` is absent:
 *   1. `instance.class.getName()` — the Java-side runtime API.
 *   2. Throw `RosettaError` with a clear message.
 */

import { ResolveError, RosettaError } from '../errors.js';
import type { Resolver } from '../types/resolver.js';

/** Options for the field helpers — resolver injection (Wave 2G ambient later). */
export interface FieldOptions {
    /** Resolver for real→obf translation. */
    readonly resolver: Resolver;
}

/**
 * Read the value of a real-named field on an instance. Returns the
 * field value (Frida unwraps `.value` automatically; we do the same).
 *
 * Throws `ResolveError` if the field isn't mapped on the instance's
 * class. Throws `RosettaError` if the instance's class can't be
 * determined or isn't in the loaded map.
 */
export function field(instance: unknown, realFieldName: string, options: FieldOptions): unknown {
    const realClass = classNameFor(instance, options.resolver);
    const resolved = options.resolver.resolveField(realClass, realFieldName);
    return readFromInstance(instance, resolved.obfName).value;
}

/**
 * Write to a real-named field on an instance.
 *
 * Throws `ResolveError` if the field isn't mapped on the instance's
 * class. Throws `RosettaError` if the instance's class can't be
 * determined.
 */
export function setField(
    instance: unknown,
    realFieldName: string,
    value: unknown,
    options: FieldOptions,
): void {
    const realClass = classNameFor(instance, options.resolver);
    const resolved = options.resolver.resolveField(realClass, realFieldName);
    readFromInstance(instance, resolved.obfName).value = value;
}

/**
 * Determine the real class name of a Java instance.
 *
 * Strategy:
 *   1. Read `$className` (the obfuscated short name Frida + mock
 *      attach to every wrapper). Reverse-lookup via the resolver.
 *   2. Fall back to `instance.class.getName()` — same shape.
 *   3. Throw if neither works or the discovered obfuscated name isn't
 *      in the loaded map.
 *
 * The resolver implementation exposes a `reverseLookup` helper that
 * isn't on the public Resolver interface; we feature-detect it so
 * future swappable resolvers stay compatible.
 */
function classNameFor(instance: unknown, resolver: Resolver): string {
    if (instance === null || typeof instance !== 'object') {
        throw new RosettaError(
            'rosetta.field/setField: instance is not an object — pass a Java instance.',
        );
    }

    const inst = instance as {
        $className?: string;
        class?: { getName?: () => string };
    };

    let obfName: string | undefined;
    if (typeof inst.$className === 'string') {
        obfName = inst.$className;
    } else if (typeof inst.class?.getName === 'function') {
        obfName = inst.class.getName();
    }

    if (obfName === undefined) {
        throw new RosettaError(
            'rosetta.field/setField: cannot determine the instance class — neither $className nor class.getName() is available.',
        );
    }

    const reverse = (resolver as { reverseLookup?: (n: string) => string | undefined })
        .reverseLookup;
    const real = typeof reverse === 'function' ? reverse.call(resolver, obfName) : undefined;
    if (real === undefined) {
        throw new ResolveError(
            `rosetta-frida: cannot reverse-lookup class '${obfName}' — the running instance's class is not in the loaded map.`,
            obfName,
            '<unknown app>',
            '<unknown version>',
            'class',
        );
    }
    return real;
}

/**
 * Fetch the field-accessor object (a `{ value: ... }` shape) for an
 * obfuscated field name off an instance. Tiny helper for the read +
 * write paths to share access.
 */
function readFromInstance(instance: unknown, obfFieldName: string): { value: unknown } {
    const accessor = (instance as Record<string, unknown>)[obfFieldName];
    if (
        accessor === undefined ||
        accessor === null ||
        typeof accessor !== 'object' ||
        !('value' in accessor)
    ) {
        throw new RosettaError(
            `rosetta.field/setField: field '${obfFieldName}' is not present on the instance (or doesn't expose a .value accessor).`,
        );
    }
    return accessor;
}

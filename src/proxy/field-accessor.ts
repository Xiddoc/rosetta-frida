/**
 * Field accessor — thin wrapper around Frida's `wrapper.<field>.value`
 * mechanism. Returned from accessing a field on a ClassProxy (static)
 * or an InstanceProxy (instance).
 *
 * The locked `FieldAccessor<T>` contract is just `{ value: T }`. We
 * implement it as a getter/setter pair that reads and writes through
 * the underlying Frida-side field object so the round-trip mirrors
 * raw `Java.use(...).field.value` semantics exactly.
 *
 * No memoization is done here — the proxy layer above us memoizes the
 * accessor object so repeated lookups return the same wrapper. The
 * wrapper itself is stateless beyond its captured reference to the
 * Frida-side field.
 */
import type { FieldAccessor } from '../types/proxy.js';
import type { Resolver } from '../types/resolver.js';

/**
 * Build a `FieldAccessor<T>` over the named field on the given Frida-
 * side native wrapper or instance.
 *
 * @param resolver — kept for symmetry with method/class factories;
 *                   field-access doesn't need to re-translate at the
 *                   accessor level (the obfuscated name was already
 *                   resolved when the accessor was built), but the
 *                   parameter is reserved so the signature is uniform
 *                   across factories.
 * @param classRealName — debug context for the error message thrown
 *                        if the underlying field disappears (map / app
 *                        disagreement).
 * @param fieldRealName — same.
 * @param native — the Frida-side wrapper or instance object we should
 *                 read/write through.
 * @param obfFieldName — the obfuscated field name already resolved via
 *                       the Resolver. The accessor will read/write
 *                       `native[obfFieldName].value`.
 */
export function makeFieldAccessor<T = unknown>(
    resolver: Resolver,
    classRealName: string,
    fieldRealName: string,
    native: unknown,
    obfFieldName: string,
): FieldAccessor<T> {
    // `resolver` is unused in the body — the obfuscated field name was
    // resolved one level up. We keep it on the signature for symmetry
    // with the other proxy factories and to leave room for future
    // diagnostics hooks (e.g. emitting a read/write event).
    void resolver;

    const lookupField = (): { value: T } => {
        const field = (native as Record<string, { value: T } | undefined>)[obfFieldName];
        if (field === undefined) {
            throw new Error(
                `rosetta-frida: field '${obfFieldName}' (real '${fieldRealName}' on '${classRealName}') not present on the underlying Java wrapper. The map and the running app likely disagree.`,
            );
        }
        return field;
    };

    return {
        get value(): T {
            return lookupField().value;
        },
        set value(v: T) {
            lookupField().value = v;
        },
    };
}

/**
 * Tier-2 API — `rosetta.type(realName)`.
 *
 * Translates a single real class name to its obfuscated short name,
 * for use as a string argument to `.overload(...)` selectors. Thin
 * alias for `Resolver.translateType(...)`.
 *
 * The translation passes through unchanged for Java primitives
 * ('int', 'boolean'), framework types ('android.os.Bundle'), and any
 * other unmapped name — so users can freely mix real names and
 * pass-through types in a single `.overload(...)` call.
 *
 * Like `use(...)`, V1 requires an explicit Resolver. Wave 2G will add
 * the session-driven default.
 */
import type { Resolver } from '../types/resolver.js';

/** Options accepted by `type(...)`. */
export interface TypeOptions {
    /**
     * The Resolver to translate the real name through. Required in V1.
     */
    resolver: Resolver;
}

/**
 * Translate a real class name to its obfuscated form.
 *
 * @example
 *   Stub.requestTicket
 *       .overload('android.os.Bundle', type('IServiceCallback', { resolver }))
 *       .implementation = fn;
 */
export function type(realName: string, options: TypeOptions): string {
    return options.resolver.translateType(realName);
}

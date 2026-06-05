/**
 * Proxy-layer types — what `rosetta.use(...)` returns and how method/field
 * access is exposed at runtime.
 *
 * LOCKED contract. Wave 2E implements; Tier 1 and Tier 3 consume.
 *
 * The proxy is a transparent wrapper around Frida's `Java.use(obfName)`.
 * It translates property accesses through the Resolver.
 */

import type { Resolver } from './resolver.js';

/**
 * Symbol key for the collision-proof metadata accessor on every proxy.
 *
 * The `$realName` / `$obfName` / `$native` / `$resolver` / `$new` string
 * accessors are ergonomic but can be SHADOWED by a (hostile or merely
 * unlucky) community map that names a real method/field `$native` or
 * `$new`: a map member always wins over the string metadata so the user
 * can still reach their member. Reading metadata through this Symbol can
 * never collide with a map key (map keys are strings), so tier-3 code that
 * must be certain it's getting the proxy's own metadata uses
 * `proxy[ROSETTA_META]`.
 */
export const ROSETTA_META: unique symbol = Symbol.for('rosetta-frida.proxy.meta');

/** The collision-proof metadata bag exposed under {@link ROSETTA_META}. */
export interface ProxyMeta {
    /** Real fully-qualified name. */
    readonly realName: string;
    /** Obfuscated short name. */
    readonly obfName: string;
    /** Underlying Java.use(...) / instance result. */
    readonly native: unknown;
    /** The resolver this proxy was built against. */
    readonly resolver: Resolver;
}

/**
 * Method-handle proxy. Returned from accessing a method on a ClassProxy.
 *
 * Mirrors Frida's method-on-wrapper shape, but with translation:
 *   - .overload(...) translates real-name args to obf before passing to Frida.
 *   - .overloads returns the underlying Frida overloads array unchanged.
 *   - .implementation = fn / .implementation = null operates on the
 *     auto-picked overload (when unambiguous in the map).
 */
export interface MethodHandle {
    /**
     * Select a specific overload. String args may be real names (translated)
     * or framework types (passed through verbatim).
     */
    overload(...argTypes: readonly string[]): OverloadHandle;
    /** Direct access to the underlying Frida method's overloads array. */
    readonly overloads: readonly OverloadHandle[];
    /**
     * Implementation accessor for the auto-picked overload.
     * Throws if multiple overloads exist with no auto-pick possible.
     */
    implementation: ((...args: unknown[]) => unknown) | null;
    /** Underlying Frida method wrapper (for tier-3 escape). */
    readonly $native: unknown;
}

/** A specific overload selection. */
export interface OverloadHandle {
    /** Argument types (in obfuscated form, as Frida sees them). */
    readonly argumentTypes: readonly { className: string }[];
    /** Return type. */
    readonly returnType: { className: string };
    /** Install / clear an implementation hook on this overload. */
    implementation: ((...args: unknown[]) => unknown) | null;
}

/**
 * Field-accessor proxy. Returned from accessing a field on a ClassProxy
 * (for static fields) or on an instance wrapper (for instance fields).
 */
export interface FieldAccessor<T = unknown> {
    /** Read / write the field value. Mirrors Frida's wrapper.field.value shape. */
    value: T;
}

/**
 * Class proxy. Returned from `rosetta.use(realFQN)`.
 *
 * The proxy exposes:
 *   - Method access by real method name → MethodHandle
 *   - Field access by real field name → FieldAccessor (static fields)
 *   - Internal $-prefixed metadata properties for tier-3 introspection
 *
 * The proxy is typed as `any`-shaped on member access since real-name
 * keys are not known to the type system without map-generated types.
 * Users can install map-typed declarations via `rosetta types` (V1.5+).
 */
export interface ClassProxy {
    /** Real fully-qualified name. */
    readonly $realName: string;
    /** Obfuscated short name. */
    readonly $obfName: string;
    /** Underlying Java.use(...) result. */
    readonly $native: unknown;
    /** The resolver this proxy was built against (tier-3 escape). */
    readonly $resolver: Resolver;
    /** Construct an instance (mirrors Frida's wrapper.$new(...)). */
    $new(...args: unknown[]): unknown;
    /** Dynamic member access — methods and static fields. */
    [member: string]: unknown;
}

/** An instance proxy wraps an instance Java reference for field access. */
export interface InstanceProxy {
    readonly $realName: string;
    readonly $obfName: string;
    readonly $native: unknown;
    [member: string]: unknown;
}

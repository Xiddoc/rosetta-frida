/**
 * Method-signature utilities.
 *
 * Two related conversions:
 *   - A JVM method descriptor "(Landroid/os/Bundle;Lbbbb;)V" splits into
 *     an array of argument descriptors.
 *   - A user-supplied argType (real-name or framework type) → JVM
 *     descriptor, via a translator hook that maps real → obf.
 *
 * Used by the Resolver to pick the right overload when the user
 * passes `argTypes` to `resolveMethod(...)`.
 */

/**
 * Map of well-known Java primitive type names → their single-letter
 * JVM descriptors. The 'void' return type is included for completeness
 * even though it never appears as an arg type.
 */
const PRIMITIVE_DESCRIPTORS: Readonly<Record<string, string>> = {
    void: 'V',
    boolean: 'Z',
    byte: 'B',
    char: 'C',
    short: 'S',
    int: 'I',
    long: 'J',
    float: 'F',
    double: 'D',
};

/**
 * Convert a user-facing type name to its JVM descriptor.
 *
 * Rules:
 *   - Primitive (`int`, `boolean`, ...) → `I`, `Z`, ...
 *   - Array (`int[]`, `java.lang.String[][]`) → `[` + recursion.
 *   - Already a descriptor (starts with `L`/`[` or is a primitive
 *     letter alone) → return as-is. This lets callers pass through
 *     pre-built descriptors when convenient.
 *   - Class (`android.os.Bundle`, `IFoo`) → `Lpath/to/cls;` after
 *     running the name through `translate` (which the Resolver
 *     uses to translate real → obf).
 *
 * The translator only ever sees the bare class name (no `L`/`;`
 * wrappers, no array prefix); it returns the bare class name (real
 * or obfuscated) and we add the descriptor wrappers here.
 */
export function toJvmDescriptor(typeName: string, translate: (name: string) => string): string {
    if (typeName.length === 0) {
        throw new Error('empty type name');
    }

    // Already-descriptor passthrough: keep robust for tier-3 escape
    // hatches that may pass a descriptor in directly.
    if (typeName.startsWith('L') && typeName.endsWith(';')) {
        return typeName;
    }
    if (typeName.startsWith('[')) {
        return typeName;
    }

    // Primitive single-letter descriptors (`V`, `Z`, `I`, ...).
    if (typeName.length === 1 && /^[VZBCSIJFD]$/.test(typeName)) {
        return typeName;
    }

    // Array form: peel off trailing `[]` pairs.
    if (typeName.endsWith('[]')) {
        const element = typeName.slice(0, -2);
        return '[' + toJvmDescriptor(element, translate);
    }

    // Primitive by name.
    const prim = PRIMITIVE_DESCRIPTORS[typeName];
    if (prim !== undefined) {
        return prim;
    }

    // Class name → translate, then wrap.
    const translated = translate(typeName);
    return 'L' + translated.replace(/\./g, '/') + ';';
}

/** Well-known JVM primitive descriptor letters → their Java type names. */
const PRIMITIVE_NAMES: Readonly<Record<string, string>> = {
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
 * Output form for {@link parseDescriptorArgs}.
 *
 * - `'descriptor'` — raw JVM descriptor slices (slashes kept):
 *   `Landroid/os/Bundle;`, `[Ljava/lang/String;`, `I`, `[I`.
 *   Used by the resolver for overload matching (compared against the map's
 *   stored signatures).
 * - `'frida'` — the shapes Frida's `.overload(...)` expects: object types
 *   dotted (`android.os.Bundle`), object-array types as `[Lpkg.Cls;`,
 *   primitives by name (`int`), primitive-array types kept as `[I`.
 */
export type DescriptorArgForm = 'descriptor' | 'frida';

/**
 * Parse a JVM descriptor ARGUMENT REGION (the text between `(` and `)`)
 * into per-arg strings rendered in the requested {@link DescriptorArgForm}.
 *
 * This is the single descriptor-arg tokenizer — both the resolver's
 * overload matcher ({@link parseSignatureArgs}) and the hook layer's
 * Frida-overload converter delegate here, parameterized only by output
 * form, so the two never drift.
 *
 * Throws on a malformed region — that's a map-authoring (or caller) bug we
 * want surfaced loudly rather than silently producing a no-match.
 */
export function parseDescriptorArgs(region: string, form: DescriptorArgForm): string[] {
    const out: string[] = [];
    let i = 0;
    while (i < region.length) {
        // Consume any array prefixes.
        let arrayDepth = 0;
        while (region[i] === '[') {
            arrayDepth += 1;
            i += 1;
        }
        const ch = region[i];
        if (ch === undefined) {
            throw new Error(`descriptor: array prefix without element: ${region}`);
        }
        const arrayPrefix = '['.repeat(arrayDepth);
        const primitive = PRIMITIVE_NAMES[ch];
        if (ch === 'L') {
            const semi = region.indexOf(';', i);
            if (semi < 0) {
                throw new Error(`descriptor: unterminated 'L' descriptor: ${region}`);
            }
            const slashName = region.slice(i + 1, semi); // e.g. android/os/Bundle
            if (form === 'descriptor') {
                out.push(`${arrayPrefix}L${slashName};`);
            } else {
                const dotted = slashName.replace(/\//g, '.');
                // Frida convention: non-array object → dotted; array → '[Lpkg.Cls;'.
                out.push(arrayDepth === 0 ? dotted : `${arrayPrefix}L${dotted};`);
            }
            i = semi + 1;
        } else if (primitive !== undefined) {
            if (form === 'descriptor') {
                out.push(`${arrayPrefix}${ch}`);
            } else {
                // Frida: bare primitive → name; primitive array → keep '[I'.
                out.push(arrayDepth === 0 ? primitive : `${arrayPrefix}${ch}`);
            }
            i += 1;
        } else {
            throw new Error(`descriptor: unknown descriptor char '${ch}' in ${region}`);
        }
    }
    return out;
}

/**
 * Split a JVM method signature's argument list into descriptors.
 *
 * `"(Landroid/os/Bundle;Lbbbb;I)V"` → `["Landroid/os/Bundle;", "Lbbbb;", "I"]`.
 *
 * Throws on a malformed signature — that's a map-authoring bug, and we
 * want it surfaced loudly rather than silently producing a no-match.
 */
export function parseSignatureArgs(signature: string): string[] {
    return parseDescriptorArgs(extractArgRegion(signature), 'descriptor');
}

/**
 * Extract the parenthesised argument region from a full method signature.
 * Throws if the signature isn't `(...)<ret>` shaped.
 */
export function extractArgRegion(signature: string): string {
    if (!signature.startsWith('(')) {
        throw new Error(`signature must start with '(': ${signature}`);
    }
    const close = signature.indexOf(')');
    if (close < 0) {
        throw new Error(`signature missing ')': ${signature}`);
    }
    return signature.slice(1, close);
}

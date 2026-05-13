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

/**
 * Split a JVM method signature's argument list into descriptors.
 *
 * `"(Landroid/os/Bundle;Lbbbb;I)V"` → `["Landroid/os/Bundle;", "Lbbbb;", "I"]`.
 *
 * Throws on a malformed signature — that's a map-authoring bug, and we
 * want it surfaced loudly rather than silently producing a no-match.
 */
export function parseSignatureArgs(signature: string): string[] {
    if (!signature.startsWith('(')) {
        throw new Error(`signature must start with '(': ${signature}`);
    }
    const close = signature.indexOf(')');
    if (close < 0) {
        throw new Error(`signature missing ')': ${signature}`);
    }
    const argsRegion = signature.slice(1, close);
    const out: string[] = [];
    let i = 0;
    while (i < argsRegion.length) {
        // noUncheckedIndexedAccess types ch as string|undefined, but the
        // while condition guarantees i < length so ch is always defined.
        const ch = argsRegion[i] as string;
        if (ch === '[') {
            // Consume array prefixes recursively.
            let j = i;
            while (j < argsRegion.length && argsRegion[j] === '[') {
                j += 1;
            }
            // j now points at the element type marker.
            const elementStart = j;
            if (elementStart >= argsRegion.length) {
                throw new Error(`signature: array prefix without element: ${signature}`);
            }
            // Bounds-checked above.
            const elementCh = argsRegion[elementStart] as string;
            if (elementCh === 'L') {
                const semi = argsRegion.indexOf(';', elementStart);
                if (semi < 0) {
                    throw new Error(`signature: unterminated 'L' descriptor: ${signature}`);
                }
                out.push(argsRegion.slice(i, semi + 1));
                i = semi + 1;
            } else {
                out.push(argsRegion.slice(i, elementStart + 1));
                i = elementStart + 1;
            }
        } else if (ch === 'L') {
            const semi = argsRegion.indexOf(';', i);
            if (semi < 0) {
                throw new Error(`signature: unterminated 'L' descriptor: ${signature}`);
            }
            out.push(argsRegion.slice(i, semi + 1));
            i = semi + 1;
        } else if (/^[VZBCSIJFD]$/.test(ch)) {
            out.push(ch);
            i += 1;
        } else {
            throw new Error(`signature: unknown descriptor char '${ch}' in ${signature}`);
        }
    }
    return out;
}

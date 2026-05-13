/**
 * Frida mock infrastructure.
 *
 * Tests can construct a controllable in-memory "Java runtime" — register
 * fake classes by their obfuscated names with method overloads and fields,
 * then exercise rosetta-frida code that calls Java.use / .overload /
 * .implementation against this fake.
 *
 * The mock targets *just enough* of Frida's Java API to support the
 * rosetta-frida runtime. It is intentionally NOT a complete Frida emulator.
 *
 * Usage:
 *
 *   import { MockFrida, installFridaMock, resetFridaMock } from 'tests/mocks/frida';
 *
 *   beforeEach(() => {
 *       installFridaMock();
 *       MockFrida.registerClass('aaaa', {
 *           methods: {
 *               c: [{
 *                   argumentTypes: [{ className: 'android.os.Bundle' }, { className: 'bbbb' }],
 *                   returnType: { className: 'void' },
 *               }],
 *           },
 *           fields: { a: { type: 'java.lang.String', static: false } },
 *       });
 *   });
 *   afterEach(resetFridaMock);
 */

import { vi } from 'vitest';

// ===========================================================================
// Type definitions matching enough of Frida's surface for rosetta-frida.
// ===========================================================================

interface MockTypeRef {
    className: string;
}

export interface MockOverloadSpec {
    argumentTypes: MockTypeRef[];
    returnType: MockTypeRef;
    /** Optional canned implementation; tests can intercept calls. */
    impl?: ((...args: unknown[]) => unknown) | null;
}

export interface MockFieldSpec {
    /** Frida-style field type — primitive name or 'L...;' or 'java.lang.X'. */
    type: string;
    /** True for static fields. */
    static?: boolean;
    /** Initial value (for static fields and for instances). */
    initial?: unknown;
}

export interface MockClassSpec {
    /** Methods keyed by obfuscated method name. Each list = overloads. */
    methods?: Record<string, MockOverloadSpec[]>;
    /** Fields keyed by obfuscated field name. */
    fields?: Record<string, MockFieldSpec>;
    /** Parent class (obfuscated name). */
    superclass?: string;
    /** Interfaces this class implements (obfuscated names). */
    interfaces?: string[];
    /** AIDL descriptor for aidl_stub / aidl_callback classes. */
    aidlDescriptor?: string;
    /** Arbitrary string contents searchable by string-anchor strategies. */
    anchorStrings?: string[];
}

// ===========================================================================
// Runtime overload + field representations.
// ===========================================================================

class MockOverload {
    public implementation: ((...args: unknown[]) => unknown) | null;
    constructor(
        public readonly argumentTypes: MockTypeRef[],
        public readonly returnType: MockTypeRef,
        impl: ((...args: unknown[]) => unknown) | null,
    ) {
        this.implementation = impl;
    }
}

class MockMethod {
    public readonly overloads: MockOverload[];
    constructor(overloadSpecs: MockOverloadSpec[]) {
        this.overloads = overloadSpecs.map(
            (s) => new MockOverload(s.argumentTypes, s.returnType, s.impl ?? null),
        );
    }

    /**
     * Frida-style overload selector. The varargs are argument type names
     * (strings) or class wrappers (with a $className field).
     */
    overload(...argTypeNames: (string | { $className: string })[]): MockOverload {
        const normalized = argTypeNames.map((t) => (typeof t === 'string' ? t : t.$className));
        const match = this.overloads.find((ol) => {
            if (ol.argumentTypes.length !== normalized.length) return false;
            return ol.argumentTypes.every((a, i) => a.className === normalized[i]);
        });
        if (!match) {
            const have = this.overloads
                .map((o) => `(${o.argumentTypes.map((a) => a.className).join(',')})`)
                .join(', ');
            throw new Error(
                `no overload found for (${normalized.join(',')}); have: ${have || '(none)'}`,
            );
        }
        return match;
    }

    /**
     * Frida exposes `.implementation = fn` on the bare method when there's
     * exactly one overload. With multiple overloads, the setter is ambiguous
     * and Frida throws. Mirror that behavior.
     */
    get implementation(): ((...args: unknown[]) => unknown) | null {
        if (this.overloads.length === 1 && this.overloads[0])
            return this.overloads[0].implementation;
        throw new Error('method has multiple overloads; use .overload(...) to disambiguate');
    }
    set implementation(impl: ((...args: unknown[]) => unknown) | null) {
        if (this.overloads.length !== 1 || !this.overloads[0]) {
            throw new Error('method has multiple overloads; use .overload(...) to disambiguate');
        }
        this.overloads[0].implementation = impl;
    }
}

class MockField {
    public value: unknown;
    constructor(
        public readonly type: string,
        public readonly isStatic: boolean,
        initial: unknown,
    ) {
        this.value = initial;
    }
}

// ===========================================================================
// The class wrapper that Java.use(name) returns.
// ===========================================================================

/**
 * Frida's Java.use returns a "wrapper" with methods and (static) fields
 * directly on it. The mock implements that shape via a JS Proxy.
 */
function makeClassWrapper(obfName: string, spec: MockClassSpec): JavaWrapper {
    const methods = new Map<string, MockMethod>();
    if (spec.methods) {
        for (const [name, overloads] of Object.entries(spec.methods)) {
            methods.set(name, new MockMethod(overloads));
        }
    }
    const staticFields = new Map<string, MockField>();
    const instanceFieldSpecs = new Map<string, MockFieldSpec>();
    if (spec.fields) {
        for (const [name, fs] of Object.entries(spec.fields)) {
            if (fs.static) {
                staticFields.set(name, new MockField(fs.type, true, fs.initial));
            } else {
                instanceFieldSpecs.set(name, fs);
            }
        }
    }

    const internal = {
        $className: obfName,
        $isWrapper: true,
        $super: spec.superclass ?? null,
        $superHierarchy: collectSuperHierarchy(spec.superclass),
        $aidlDescriptor: spec.aidlDescriptor ?? null,
        $anchorStrings: spec.anchorStrings ?? [],
        $new(...args: unknown[]): JavaInstance {
            return makeInstance(obfName, instanceFieldSpecs, methods, args);
        },
        class: {
            getName: () => obfName,
            getSuperclass: () =>
                spec.superclass
                    ? makeClassWrapper(spec.superclass, MockFrida.specOf(spec.superclass) ?? {})
                    : null,
            getInterfaces: () =>
                (spec.interfaces ?? []).map((i) => makeClassWrapper(i, MockFrida.specOf(i) ?? {})),
        },
    } as const;

    return new Proxy(internal, {
        get(target, prop, receiver) {
            if (typeof prop === 'string') {
                if (methods.has(prop)) return methods.get(prop);
                if (staticFields.has(prop)) return staticFields.get(prop);
            }
            return Reflect.get(target, prop, receiver) as unknown;
        },
        has(target, prop) {
            if (typeof prop === 'string' && (methods.has(prop) || staticFields.has(prop))) {
                return true;
            }
            return Reflect.has(target, prop);
        },
    });
}

function makeInstance(
    obfName: string,
    fieldSpecs: Map<string, MockFieldSpec>,
    methods: Map<string, MockMethod>,
    _constructorArgs: unknown[],
): JavaInstance {
    const fields = new Map<string, MockField>();
    for (const [name, fs] of fieldSpecs) {
        fields.set(name, new MockField(fs.type, false, fs.initial));
    }

    const internal = {
        $className: obfName,
        $isInstance: true,
    } as const;

    return new Proxy(internal, {
        get(target, prop, receiver) {
            if (typeof prop === 'string') {
                if (fields.has(prop)) return fields.get(prop);
                if (methods.has(prop)) return methods.get(prop);
            }
            return Reflect.get(target, prop, receiver) as unknown;
        },
    });
}

function collectSuperHierarchy(superclass: string | undefined): string[] {
    const result: string[] = [];
    let cur = superclass;
    while (cur) {
        result.push(cur);
        cur = MockFrida.specOf(cur)?.superclass;
    }
    return result;
}

// ===========================================================================
// Public mock control surface.
// ===========================================================================

/** Type used by rosetta-frida code that gets back from Java.use. */
export interface JavaWrapper {
    readonly $className: string;
    readonly $isWrapper: true;
    readonly $super: string | null;
    readonly $superHierarchy: readonly string[];
    readonly $aidlDescriptor: string | null;
    readonly $anchorStrings: readonly string[];
    $new(...args: unknown[]): JavaInstance;
    readonly class: {
        getName(): string;
        getSuperclass(): JavaWrapper | null;
        getInterfaces(): readonly JavaWrapper[];
    };
    [member: string]: unknown;
}

/** Type used by rosetta-frida code that gets an instance. */
export interface JavaInstance {
    readonly $className: string;
    readonly $isInstance: true;
    [member: string]: unknown;
}

class MockFridaRegistry {
    private readonly classes = new Map<string, MockClassSpec>();

    registerClass(obfName: string, spec: MockClassSpec): void {
        this.classes.set(obfName, spec);
    }

    /** Internal — lookup the spec for a name (for hierarchy traversal). */
    specOf(obfName: string): MockClassSpec | undefined {
        return this.classes.get(obfName);
    }

    has(obfName: string): boolean {
        return this.classes.has(obfName);
    }

    /** Frida's Java.use(name). Throws if the class isn't registered. */
    use(obfName: string): JavaWrapper {
        const spec = this.classes.get(obfName);
        if (!spec) {
            throw new Error(`Frida mock: class '${obfName}' not registered`);
        }
        return makeClassWrapper(obfName, spec);
    }

    /** Reset all registered classes. */
    reset(): void {
        this.classes.clear();
    }

    /** Enumerate all registered class names — supports discovery strategies. */
    classNames(): readonly string[] {
        return [...this.classes.keys()];
    }
}

export const MockFrida = new MockFridaRegistry();

// ===========================================================================
// Global Java + Frida API surface.
// ===========================================================================

interface GlobalShape {
    Java?: typeof Java;
    Frida?: typeof Frida;
    Process?: typeof Process;
    send?: (...args: unknown[]) => void;
    recv?: (...args: unknown[]) => void;
}

const globalAny: GlobalShape = globalThis as unknown as GlobalShape;

let saved: GlobalShape | null = null;

/**
 * Install the Frida mock onto globalThis. Call in beforeEach (or in setup.ts).
 * Restores via resetFridaMock().
 */
export function installFridaMock(): void {
    if (saved) {
        throw new Error('Frida mock already installed — call resetFridaMock first');
    }
    saved = {
        Java: globalAny.Java,
        Frida: globalAny.Frida,
        Process: globalAny.Process,
        send: globalAny.send,
        recv: globalAny.recv,
    };

    // Construct a synthetic Java namespace that proxies to MockFrida.
    const javaMock = {
        available: true,
        androidVersion: '14',
        perform(fn: () => void): void {
            fn();
        },
        use: vi.fn((obfName: string) => MockFrida.use(obfName)),
        enumerateLoadedClasses(callbacks: {
            onMatch: (name: string) => void;
            onComplete?: () => void;
        }): void {
            for (const name of MockFrida.classNames()) {
                callbacks.onMatch(name);
            }
            callbacks.onComplete?.();
        },
        cast<T>(obj: T, _klass: unknown): T {
            return obj;
        },
        // Just enough for our auto-detect helpers; tests that exercise
        // auto-detect register the relevant classes themselves.
    };

    const fridaMock = {
        version: '17.0.0-mock',
        heapSize: 0,
    };

    const processMock = {
        platform: 'linux',
        arch: 'arm64',
        id: 12345,
    };

    globalAny.Java = javaMock as unknown as typeof Java;
    globalAny.Frida = fridaMock;
    globalAny.Process = processMock as unknown as typeof Process;
    globalAny.send = vi.fn();
    globalAny.recv = vi.fn();
}

/** Restore globalThis to its pre-mock state and clear all registered classes. */
export function resetFridaMock(): void {
    MockFrida.reset();
    if (!saved) return;
    globalAny.Java = saved.Java;
    globalAny.Frida = saved.Frida;
    globalAny.Process = saved.Process;
    globalAny.send = saved.send;
    globalAny.recv = saved.recv;
    saved = null;
}

/**
 * Convenience: install + reset around each test in a Vitest file.
 * Tests that need cross-test setup can call install/reset manually.
 */
export function useFridaMock(): void {
    beforeEach(() => {
        installFridaMock();
    });
    afterEach(() => {
        resetFridaMock();
    });
}

/**
 * Tests for the pure target-namespace guard predicate (RFC 0001 C1).
 *
 * These exercise the decision core in isolation — no resolver, no Java.
 * The resolver-level enforcement + end-to-end "Java.use never called"
 * assertions live in resolver.test.ts and the api/* suites.
 *
 * Examples use only generic placeholder names.
 */

import { describe, it, expect } from 'vitest';
import { TargetPolicyError } from '../errors.js';
import type { TargetPolicy } from '../types/session.js';
import {
    DEFAULT_DENY_PREFIXES,
    DEFAULT_APP_NAMESPACE_LABELS,
    appPrefixOf,
    isTargetAllowed,
    assertTargetAllowed,
} from './target-policy.js';

const APP = 'com.example.app';
const APP_PREFIX = 'com.example';

describe('DEFAULT_DENY_PREFIXES', () => {
    it('matches the Kotlin twin value-for-value', () => {
        // This is the SHARED list; both clients must reject the same maps.
        expect([...DEFAULT_DENY_PREFIXES]).toEqual([
            'java.',
            'javax.',
            'jdk.',
            'sun.',
            'com.sun.',
            'dalvik.',
            'android.',
            'androidx.',
            'com.android.',
            'kotlin.',
            'kotlinx.',
            'dagger.',
            'com.google.android.',
            'libcore.',
            'org.apache.harmony.',
        ]);
    });

    it('defaults to 2 app-namespace labels', () => {
        expect(DEFAULT_APP_NAMESPACE_LABELS).toBe(2);
    });
});

describe('appPrefixOf', () => {
    it('takes the first 2 labels by default', () => {
        expect(appPrefixOf(APP)).toBe('com.example');
        expect(appPrefixOf('a.b.c.d.e')).toBe('a.b');
    });

    it('honours a custom label count', () => {
        expect(appPrefixOf(APP, { appNamespaceLabels: 3 })).toBe('com.example.app');
        expect(appPrefixOf(APP, { appNamespaceLabels: 1 })).toBe('com');
    });

    it('returns empty prefix for <= 0 labels', () => {
        expect(appPrefixOf(APP, { appNamespaceLabels: 0 })).toBe('');
        expect(appPrefixOf(APP, { appNamespaceLabels: -1 })).toBe('');
    });

    it('takes all labels when the count exceeds them', () => {
        expect(appPrefixOf('com', { appNamespaceLabels: 5 })).toBe('com');
    });
});

describe('isTargetAllowed — reserved denylist (DENY)', () => {
    const denied = [
        'java.lang.Runtime',
        'javax.crypto.Cipher',
        'jdk.internal.misc.Unsafe',
        'sun.misc.Unsafe',
        'com.sun.proxy.$Proxy0',
        'dalvik.system.DexClassLoader',
        'android.app.ActivityThread',
        'androidx.core.app.NotificationCompat',
        'com.android.internal.os.Zygote',
        'kotlin.jvm.internal.Intrinsics',
        'kotlinx.coroutines.BuildersKt',
        'dagger.internal.Provider',
        'com.google.android.gms.common.GoogleApiAvailability',
        'libcore.io.Memory',
        'org.apache.harmony.xml.ExpatParser',
    ];
    for (const fqn of denied) {
        it(`rejects ${fqn}`, () => {
            expect(isTargetAllowed(fqn, APP_PREFIX)).toBe(false);
        });
    }
});

describe('isTargetAllowed — ALLOW cases', () => {
    it('allows package-local (no dot) obfuscated names', () => {
        expect(isTargetAllowed('aaaa', APP_PREFIX)).toBe(true);
        expect(isTargetAllowed('a', APP_PREFIX)).toBe(true);
    });

    it('allows the app-owned namespace', () => {
        expect(isTargetAllowed('com.example.app.Foo', APP_PREFIX)).toBe(true);
        expect(isTargetAllowed('com.example.other.Bar', APP_PREFIX)).toBe(true);
    });

    it('denies a foreign (non-app, non-reserved) namespace', () => {
        expect(isTargetAllowed('org.somelib.Thing', APP_PREFIX)).toBe(false);
        expect(isTargetAllowed('net.evil.Backdoor', APP_PREFIX)).toBe(false);
    });

    it('does not match a deny prefix that is only a string-prefix, not a dot-boundary', () => {
        // `javafoo` is NOT under `java.`
        expect(isTargetAllowed('javafoo.Bar', APP_PREFIX)).toBe(false); // foreign, still denied
        expect(isTargetAllowed('javafoo', APP_PREFIX)).toBe(true); // package-local
    });

    it('treats a wrong-prefix app namespace as foreign', () => {
        // `com.examplexyz` must not be accepted as `com.example`.
        expect(isTargetAllowed('com.examplexyz.Foo', APP_PREFIX)).toBe(false);
    });
});

describe('isTargetAllowed — nested classes', () => {
    it('splits the namespace on `.` only ($ is part of the class name)', () => {
        expect(isTargetAllowed('com.example.app.Foo$Bar', APP_PREFIX)).toBe(true);
        expect(isTargetAllowed('android.os.Foo$Bar', APP_PREFIX)).toBe(false);
    });
});

describe('isTargetAllowed — array / primitive normalization', () => {
    it('strips reflective array markers down to the element', () => {
        expect(isTargetAllowed('[Ljava.lang.String;', APP_PREFIX)).toBe(false);
        expect(isTargetAllowed('[[Lcom.example.app.Foo;', APP_PREFIX)).toBe(true);
        expect(isTargetAllowed('[Lcom.example.app.Foo;', APP_PREFIX)).toBe(true);
    });

    it('strips source-form array markers', () => {
        expect(isTargetAllowed('java.lang.String[]', APP_PREFIX)).toBe(false);
        expect(isTargetAllowed('com.example.app.Foo[][]', APP_PREFIX)).toBe(true);
    });

    it('treats internal-slash form like dotted', () => {
        expect(isTargetAllowed('java/lang/Runtime', APP_PREFIX)).toBe(false);
        expect(isTargetAllowed('[Lcom/example/app/Foo;', APP_PREFIX)).toBe(true);
    });

    it('always allows primitives and void (not loadable classes)', () => {
        for (const p of [
            'void',
            'int',
            'boolean',
            'byte',
            'char',
            'short',
            'long',
            'float',
            'double',
        ]) {
            expect(isTargetAllowed(p, APP_PREFIX)).toBe(true);
        }
        // Array of primitive descriptor + bare array depth.
        expect(isTargetAllowed('[I', APP_PREFIX)).toBe(true);
        expect(isTargetAllowed('[Z', APP_PREFIX)).toBe(true);
    });

    it('treats the empty / whitespace string as always-allow', () => {
        expect(isTargetAllowed('', APP_PREFIX)).toBe(true);
        expect(isTargetAllowed('   ', APP_PREFIX)).toBe(true);
        // Array markers reducing to nothing.
        expect(isTargetAllowed('[]', APP_PREFIX)).toBe(true);
        expect(isTargetAllowed('[L;', APP_PREFIX)).toBe(true);
    });

    it('is case-sensitive', () => {
        // `Java.` is NOT `java.` — foreign, but still denied (not app).
        expect(isTargetAllowed('Java.lang.Runtime', APP_PREFIX)).toBe(false);
        // The denylist matched it as foreign, not reserved; confirm the
        // reason via assert.
        try {
            assertTargetAllowed('x', 'Java.lang.Runtime', APP_PREFIX);
        } catch (e) {
            expect((e as TargetPolicyError).reason).toBe('foreign-namespace');
        }
    });
});

describe('isTargetAllowed — escape hatch (allow)', () => {
    const policy: TargetPolicy = { allow: ['java.lang.Runtime'] };

    it('permits an exact-FQN framework target', () => {
        expect(isTargetAllowed('java.lang.Runtime', APP_PREFIX, policy)).toBe(true);
    });

    it('only permits the exact FQN, not siblings', () => {
        expect(isTargetAllowed('java.lang.Process', APP_PREFIX, policy)).toBe(false);
    });

    it('matches the allowlist against the normalized element FQN (array form)', () => {
        expect(isTargetAllowed('[Ljava.lang.Runtime;', APP_PREFIX, policy)).toBe(true);
    });
});

describe('isTargetAllowed — denylist merge/replace', () => {
    it('augments the default denylist when mergeDenylist is true (default)', () => {
        const policy: TargetPolicy = { denyPrefixes: ['org.somelib.'] };
        expect(isTargetAllowed('org.somelib.Thing', APP_PREFIX, policy)).toBe(false);
        // Defaults still apply.
        expect(isTargetAllowed('java.lang.Runtime', APP_PREFIX, policy)).toBe(false);
    });

    it('replaces the default denylist when mergeDenylist is false', () => {
        const policy: TargetPolicy = { denyPrefixes: ['org.somelib.'], mergeDenylist: false };
        // java. is no longer reserved → but it is still foreign (not app).
        expect(isTargetAllowed('java.lang.Runtime', APP_PREFIX, policy)).toBe(false);
        // Confirm it's now FOREIGN, not RESERVED.
        try {
            assertTargetAllowed('x', 'java.lang.Runtime', APP_PREFIX, policy);
        } catch (e) {
            expect((e as TargetPolicyError).reason).toBe('foreign-namespace');
        }
        // The custom prefix is still reserved.
        try {
            assertTargetAllowed('x', 'org.somelib.Thing', APP_PREFIX, policy);
        } catch (e) {
            expect((e as TargetPolicyError).reason).toBe('reserved-namespace');
        }
    });

    it('treats an empty replacement denylist as no reserved prefixes', () => {
        const policy: TargetPolicy = { mergeDenylist: false };
        // With no deny prefixes, java. is merely foreign.
        expect(isTargetAllowed('com.example.app.Foo', APP_PREFIX, policy)).toBe(true);
        expect(isTargetAllowed('java.lang.Runtime', APP_PREFIX, policy)).toBe(false);
    });
});

describe('isTargetAllowed — empty app prefix', () => {
    it('denies any dotted foreign namespace when appNamespaceLabels is 0', () => {
        const policy: TargetPolicy = { appNamespaceLabels: 0 };
        const prefix = appPrefixOf(APP, policy); // ''
        expect(isTargetAllowed('com.example.app.Foo', prefix, policy)).toBe(false);
        // package-local still allowed.
        expect(isTargetAllowed('aaaa', prefix, policy)).toBe(true);
    });
});

describe('assertTargetAllowed', () => {
    it('does not throw for an allowed target', () => {
        expect(() => assertTargetAllowed('Foo', 'aaaa', APP_PREFIX)).not.toThrow();
    });

    it('throws TargetPolicyError with reserved-namespace reason + fields', () => {
        try {
            assertTargetAllowed('com.example.app.Foo', 'java.lang.Runtime', APP_PREFIX);
            expect.unreachable('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(TargetPolicyError);
            const err = e as TargetPolicyError;
            expect(err.realName).toBe('com.example.app.Foo');
            expect(err.target).toBe('java.lang.Runtime');
            expect(err.reason).toBe('reserved-namespace');
            expect(err.classScope).toBeUndefined();
            expect(err.message).toContain('reserved denylist');
        }
    });

    it('throws with foreign-namespace reason for a non-app, non-reserved target', () => {
        try {
            assertTargetAllowed('Foo', 'org.somelib.Thing', APP_PREFIX);
            expect.unreachable('should have thrown');
        } catch (e) {
            const err = e as TargetPolicyError;
            expect(err.reason).toBe('foreign-namespace');
            expect(err.message).toContain("app prefix 'com.example'");
        }
    });

    it('reports <none> as the app prefix when it is empty', () => {
        try {
            assertTargetAllowed('Foo', 'org.somelib.Thing', '', { appNamespaceLabels: 0 });
            expect.unreachable('should have thrown');
        } catch (e) {
            expect((e as TargetPolicyError).message).toContain('<none>');
        }
    });

    it('carries the classScope when supplied', () => {
        try {
            assertTargetAllowed(
                'someMethod',
                'java.lang.Runtime',
                APP_PREFIX,
                {},
                'com.example.app.Foo',
            );
            expect.unreachable('should have thrown');
        } catch (e) {
            const err = e as TargetPolicyError;
            expect(err.classScope).toBe('com.example.app.Foo');
            expect(err.message).toContain("on 'com.example.app.Foo'");
        }
    });
});

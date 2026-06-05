/**
 * Tests for `rosetta.use(realName, options)` — Tier-2 entry point.
 *
 * The function is a thin shim over `makeClassProxy`. Coverage focuses
 * on the end-to-end path:
 *   - Real-name input → ClassProxy with $realName/$obfName/$native.
 *   - Method access through the proxy returned by `use(...)`.
 *   - Field access through the proxy returned by `use(...)`.
 */
import { describe, expect, it } from 'vitest';

import { MockFrida, useFridaMock } from '../../tests/mocks/index.js';
import { createResolver } from '../resolver/index.js';
import type { RosettaMap } from '../types/map.js';
import { validateMap } from '../validate/schema.js';
import { use } from './use.js';

const map: RosettaMap = validateMap({
    schema_version: 2,
    version_code: 1,
    app: 'com.example.app',
    version: '1.0.0',
    classes: {
        'com.example.app.Stub': {
            obfuscated: 'aaaa',
            methods: {
                doIt: {
                    obfuscated: 'c',
                    signature: '(Landroid/os/Bundle;)V',
                },
            },
            fields: {
                FLAG: { obfuscated: 'f', type: 'I', static: true },
            },
        },
    },
});

function registerStub(): void {
    MockFrida.registerClass('aaaa', {
        methods: {
            c: [
                {
                    argumentTypes: [{ className: 'android.os.Bundle' }],
                    returnType: { className: 'void' },
                },
            ],
        },
        fields: { f: { type: 'I', static: true, initial: 7 } },
    });
}

describe('use', () => {
    useFridaMock();

    it('returns a ClassProxy that translates real → obf names end-to-end', () => {
        registerStub();
        const resolver = createResolver(map);
        const Stub = use('com.example.app.Stub', { resolver });
        expect(Stub.$realName).toBe('com.example.app.Stub');
        expect(Stub.$obfName).toBe('aaaa');

        const method = Stub.doIt as { overload: (...a: string[]) => unknown };
        const picked = method.overload('android.os.Bundle') as {
            argumentTypes: { className: string }[];
        };
        expect(picked.argumentTypes[0]?.className).toBe('android.os.Bundle');

        const field = Stub.FLAG as { value: number };
        expect(field.value).toBe(7);
    });
});

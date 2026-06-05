/**
 * Tests for the TS/JS-module refusal recognizer.
 *
 * The old dynamic-`import()` ingestion path was removed (build-time RCE).
 * What remains is a pure recognizer + a refusal helper that NEVER imports.
 */

import { describe, it, expect } from 'vitest';
import { isModuleExtension, refuseModuleInput, MODULE_UNSUPPORTED_MESSAGE } from './ts-module.js';
import { RosettaError } from '../errors.js';

describe('isModuleExtension', () => {
    it.each(['map.ts', 'map.js', 'map.mjs', 'map.cjs', '/abs/path.TS', 'a.MJS'])(
        'recognizes module extension: %s',
        (p) => {
            expect(isModuleExtension(p)).toBe(true);
        },
    );

    it.each(['map.json', 'map.yaml', 'map.yml', 'map.txt', 'noext', 'map.tsx'])(
        'does not recognize non-module extension: %s',
        (p) => {
            expect(isModuleExtension(p)).toBe(false);
        },
    );
});

describe('refuseModuleInput', () => {
    it('throws RosettaError with the shared message and the path', () => {
        expect(() => refuseModuleInput('/abs/map.ts')).toThrow(RosettaError);
        expect(() => refuseModuleInput('/abs/map.ts')).toThrow(MODULE_UNSUPPORTED_MESSAGE);
        expect(() => refuseModuleInput('/abs/map.ts')).toThrow(/path: \/abs\/map\.ts/);
    });

    it('never returns (no import, no execution)', () => {
        // The whole point: there is no code path that loads the module.
        expect(() => refuseModuleInput('rm-rf.mjs')).toThrow();
    });
});

/**
 * Exhaustiveness guard for the `DiagnosticEvent` discriminated union.
 *
 * If a new event variant is added to `DiagnosticEvent` without updating
 * the enumeration here, this file fails to TYPECHECK (the
 * `Record<DiagnosticEvent['type'], true>` map becomes incomplete). The
 * runtime assertions then keep the list honest at test time too. This is
 * the single place that must change in lockstep with the union, so every
 * variant — including `signer-check`, which was previously unexported —
 * stays accounted for.
 */

import { describe, expect, it } from 'vitest';
import type { DiagnosticEvent, SignerCheckEvent } from './events.js';

/**
 * One entry per `DiagnosticEvent['type']`. Typed as a total record so a
 * missing key is a compile error and a stray key is a compile error.
 */
const ALL_EVENT_TYPES = {
    resolve: true,
    'health-check': true,
    detect: true,
    'map-load': true,
    'signer-check': true,
} satisfies Record<DiagnosticEvent['type'], true>;

describe('DiagnosticEvent exhaustiveness', () => {
    it('enumerates exactly the known event types', () => {
        expect(Object.keys(ALL_EVENT_TYPES).sort()).toEqual(
            ['detect', 'health-check', 'map-load', 'resolve', 'signer-check'].sort(),
        );
    });

    it('routes each event type through an exhaustive switch with no default', () => {
        // A compile-time exhaustiveness check: the `never` assignment fails
        // to typecheck if a variant is unhandled.
        function describeType(type: DiagnosticEvent['type']): string {
            switch (type) {
                case 'resolve':
                    return 'resolve';
                case 'health-check':
                    return 'health-check';
                case 'detect':
                    return 'detect';
                case 'map-load':
                    return 'map-load';
                case 'signer-check':
                    return 'signer-check';
                default: {
                    const unreachable: never = type;
                    return unreachable;
                }
            }
        }
        for (const type of Object.keys(ALL_EVENT_TYPES) as DiagnosticEvent['type'][]) {
            expect(describeType(type)).toBe(type);
        }
    });

    it('exports SignerCheckEvent as a usable public type', () => {
        const event: SignerCheckEvent = {
            type: 'signer-check',
            passed: true,
            app: 'com.example.app',
            expected: 'a'.repeat(64),
            actual: ['a'.repeat(64)],
            source: 'signingInfo',
        };
        // A SignerCheckEvent is assignable to the union.
        const asUnion: DiagnosticEvent = event;
        expect(asUnion.type).toBe('signer-check');
    });
});

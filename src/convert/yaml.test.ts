/**
 * Tests for the YAML → RosettaMap converter.
 */

import { describe, it, expect } from 'vitest';
import { yamlToMap } from './yaml.js';
import { MapValidationError, RosettaError } from '../errors.js';

const GOOD_YAML = `
schema_version: 2
app: com.example.app
version: "3.4.5"
version_code: 30405
captured_at: 2026-05-13
sources:
  - tool: hand-authored
    classes: 1
    notes: "smoke test"
classes:
  com.example.app.IRemoteService$Stub:
    obfuscated: aaaa
    kind: aidl_stub
    aidl_descriptor: com.example.app.IRemoteService
    methods:
      requestTicket:
        obfuscated: c
        signature: "(Landroid/os/Bundle;Lbbbb;)V"
        aidl_txn: 2
    fields:
      sessionId:
        obfuscated: a
        type: "Ljava/lang/String;"
`;

describe('yamlToMap', () => {
    it('parses well-formed YAML into a RosettaMap', () => {
        const map = yamlToMap(GOOD_YAML);
        expect(map.schema_version).toBe(2);
        expect(map.version_code).toBe(30405);
        expect(map.app).toBe('com.example.app');
        expect(map.version).toBe('3.4.5');
        const klass = map.classes['com.example.app.IRemoteService$Stub'];
        expect(klass?.obfuscated).toBe('aaaa');
        expect(klass?.kind).toBe('aidl_stub');
        const method = klass?.methods?.requestTicket;
        expect(method).toBeDefined();
        if (Array.isArray(method)) throw new Error('expected single-overload form');
        expect(method?.obfuscated).toBe('c');
        expect(method?.aidl_txn).toBe(2);
    });

    it('parses overload-array form for methods', () => {
        const yaml = `
schema_version: 2
app: com.example.app
version: "1.0.0"
version_code: 100
classes:
  IFoo:
    obfuscated: aaaa
    methods:
      bar:
        - obfuscated: c
          signature: "()V"
        - obfuscated: d
          signature: "(I)V"
`;
        const map = yamlToMap(yaml);
        const bar = map.classes.IFoo?.methods?.bar;
        expect(Array.isArray(bar)).toBe(true);
        expect((bar as { obfuscated: string }[]).length).toBe(2);
    });

    it('throws RosettaError on malformed YAML', () => {
        // Tab-indentation inside a block-mapping context — invalid YAML.
        const bad = 'schema_version: 1\napp: x\n\tinvalid: indent';
        expect(() => yamlToMap(bad)).toThrow(RosettaError);
    });

    it('throws MapValidationError on empty/null document', () => {
        expect(() => yamlToMap('')).toThrow(MapValidationError);
        expect(() => yamlToMap('---\nnull')).toThrow(MapValidationError);
    });

    it('throws MapValidationError when schema_version is wrong', () => {
        const bad = `
schema_version: 1
app: com.example.app
version: "1.0.0"
version_code: 100
classes: {}
`;
        expect(() => yamlToMap(bad)).toThrow(MapValidationError);
    });

    it('throws MapValidationError when required fields are missing', () => {
        const bad = `
schema_version: 2
app: com.example.app
classes: {}
`;
        expect(() => yamlToMap(bad)).toThrow(MapValidationError);
    });

    it('throws MapValidationError when a class entry is malformed', () => {
        const bad = `
schema_version: 2
app: com.example.app
version: "1.0.0"
version_code: 100
classes:
  IFoo:
    kind: aidl_stub
`;
        // Missing `obfuscated` on the class.
        expect(() => yamlToMap(bad)).toThrow(MapValidationError);
    });

    it('issues array contains paths for nested errors', () => {
        const bad = `
schema_version: 2
app: com.example.app
version: "1.0.0"
version_code: 100
classes:
  IFoo:
    obfuscated: ""
    methods:
      bar:
        obfuscated: ""
        signature: "()V"
`;
        try {
            yamlToMap(bad);
            throw new Error('expected throw');
        } catch (e) {
            expect(e).toBeInstanceOf(MapValidationError);
            const err = e as MapValidationError;
            expect(err.issues.length).toBeGreaterThan(0);
            // At least one issue should reference a `classes.` path.
            expect(err.issues.some((i) => i.path.startsWith('classes'))).toBe(true);
        }
    });
});

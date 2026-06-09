/**
 * Tests for the YAML → RosettaMap converter.
 */

import { describe, it, expect } from 'vitest';
import { yamlToMap } from './yaml.js';
import { MapValidationError, RosettaError } from '../errors.js';

const GOOD_YAML = `
schema_version: 3
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
        expect(map.schema_version).toBe(3);
        expect(map.version_code).toBe(30405);
        expect(map.app).toBe('com.example.app');
        expect(map.version).toBe('3.4.5');
        const klass = map.classes['com.example.app.IRemoteService$Stub'];
        expect(klass?.obfuscated).toBe('aaaa');
        expect(klass?.kind).toBe('aidl_stub');
        // Methods are normalised to arrays by validation (single-overload
        // authoring form becomes a one-element array).
        const method = klass?.methods?.requestTicket;
        expect(method).toBeDefined();
        if (!Array.isArray(method)) throw new Error('expected normalised array form');
        expect(method[0]?.obfuscated).toBe('c');
        expect(method[0]?.aidl_txn).toBe(2);
    });

    it('parses overload-array form for methods', () => {
        const yaml = `
schema_version: 3
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
schema_version: 3
app: com.example.app
classes: {}
`;
        expect(() => yamlToMap(bad)).toThrow(MapValidationError);
    });

    it('throws MapValidationError when a class entry is malformed', () => {
        const bad = `
schema_version: 3
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

    it('does not choke on a non-object top-level document (array)', () => {
        // The signer-canonicalization step early-returns on a non-object
        // document; the subsequent structural validation rejects it. This
        // pins the early-return branch (maps#11 canonicalize guard).
        expect(() => yamlToMap('- a\n- b')).toThrow(MapValidationError);
    });

    it('does not choke on a scalar top-level document', () => {
        expect(() => yamlToMap('42')).toThrow(MapValidationError);
    });

    it('canonicalizes a colon-separated, uppercase signer_sha256 at the emit boundary (maps#11)', () => {
        // apksigner / keytool emit `AB:CD:…` uppercase digests. The canonical
        // on-disk form is lowercase, no colons — the strict schema enforces
        // `^[0-9a-f]{64}$`, so the converter must canonicalize before emit.
        const upperColon = Array.from({ length: 32 }, () => 'AB').join(':'); // 32 * "AB"
        const yaml = `
schema_version: 3
app: com.example.app
version: "1.0.0"
version_code: 100
signer_sha256: "${upperColon}"
classes: {}
`;
        const map = yamlToMap(yaml);
        expect(map.signer_sha256).toBe('ab'.repeat(32));
        // The emitted value passes the canonical schema's lowercase-hex shape.
        expect(map.signer_sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it('canonicalizes a mixed-case, no-colon signer_sha256', () => {
        const mixed = 'AbCdEf0123456789'.repeat(4); // 64 mixed-case hex chars
        const yaml = `
schema_version: 3
app: com.example.app
version: "1.0.0"
version_code: 100
signer_sha256: "${mixed}"
classes: {}
`;
        const map = yamlToMap(yaml);
        expect(map.signer_sha256).toBe(mixed.toLowerCase());
        expect(map.signer_sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it('canonicalizes an ARRAY of non-canonical signer_sha256 hashes (#38)', () => {
        // The schema-3 match-any array form: each element may be authored in
        // apksigner colon/uppercase form. The converter must normalize every
        // entry, not just the scalar case.
        const upperColon = Array.from({ length: 32 }, () => 'AB').join(':'); // -> ab*32
        const mixed = 'AbCdEf0123456789'.repeat(4); // 64 mixed-case hex
        const yaml = `
schema_version: 3
app: com.example.app
version: "1.0.0"
version_code: 100
signer_sha256:
    - "${upperColon}"
    - "${mixed}"
classes: {}
`;
        const map = yamlToMap(yaml);
        expect(map.signer_sha256).toEqual(['ab'.repeat(32), mixed.toLowerCase()]);
        for (const h of map.signer_sha256 as string[]) {
            expect(h).toMatch(/^[0-9a-f]{64}$/);
        }
    });

    it('leaves a non-string array entry untouched (schema still rejects it, #38)', () => {
        // A non-string element (e.g. a YAML number) is NOT normalized — the
        // canonicalizer only touches string entries — so the strict schema
        // still rejects the array as malformed rather than the converter
        // laundering it.
        const good = 'a'.repeat(64);
        const yaml = `
schema_version: 3
app: com.example.app
version: "1.0.0"
version_code: 100
signer_sha256:
    - "${good}"
    - 12345
classes: {}
`;
        expect(() => yamlToMap(yaml)).toThrow(MapValidationError);
    });

    it('still rejects a signer_sha256 that is malformed after canonicalization', () => {
        // Wrong length even after stripping colons / lowercasing — canonicalize
        // does not launder garbage; the strict schema still rejects it.
        const yaml = `
schema_version: 3
app: com.example.app
version: "1.0.0"
version_code: 100
signer_sha256: "AB:CD:EF"
classes: {}
`;
        expect(() => yamlToMap(yaml)).toThrow(MapValidationError);
    });

    it('issues array contains paths for nested errors', () => {
        const bad = `
schema_version: 3
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

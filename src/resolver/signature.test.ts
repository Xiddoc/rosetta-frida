/**
 * Tests for the JVM-descriptor helpers used by the Resolver to
 * pick the right method overload from user-supplied argTypes.
 */

import { describe, it, expect } from 'vitest';
import { parseSignatureArgs, toJvmDescriptor } from './signature.js';

const identity = (s: string): string => s;

describe('toJvmDescriptor', () => {
    it('returns primitive descriptors for primitive names', () => {
        expect(toJvmDescriptor('void', identity)).toBe('V');
        expect(toJvmDescriptor('boolean', identity)).toBe('Z');
        expect(toJvmDescriptor('byte', identity)).toBe('B');
        expect(toJvmDescriptor('char', identity)).toBe('C');
        expect(toJvmDescriptor('short', identity)).toBe('S');
        expect(toJvmDescriptor('int', identity)).toBe('I');
        expect(toJvmDescriptor('long', identity)).toBe('J');
        expect(toJvmDescriptor('float', identity)).toBe('F');
        expect(toJvmDescriptor('double', identity)).toBe('D');
    });

    it('passes through already-built descriptor forms', () => {
        expect(toJvmDescriptor('Landroid/os/Bundle;', identity)).toBe('Landroid/os/Bundle;');
        expect(toJvmDescriptor('[I', identity)).toBe('[I');
        expect(toJvmDescriptor('[Ljava/lang/String;', identity)).toBe('[Ljava/lang/String;');
        expect(toJvmDescriptor('I', identity)).toBe('I');
        expect(toJvmDescriptor('V', identity)).toBe('V');
    });

    it('builds class descriptors and dots become slashes', () => {
        expect(toJvmDescriptor('android.os.Bundle', identity)).toBe('Landroid/os/Bundle;');
        expect(toJvmDescriptor('IFoo', identity)).toBe('LIFoo;');
    });

    it('routes class names through the translator', () => {
        const translate = (n: string): string => (n === 'IServiceCallback' ? 'bbbb' : n);
        expect(toJvmDescriptor('IServiceCallback', translate)).toBe('Lbbbb;');
        // Unrelated names still pass through.
        expect(toJvmDescriptor('android.os.Bundle', translate)).toBe('Landroid/os/Bundle;');
    });

    it('handles single-dimension arrays', () => {
        expect(toJvmDescriptor('int[]', identity)).toBe('[I');
        expect(toJvmDescriptor('java.lang.String[]', identity)).toBe('[Ljava/lang/String;');
    });

    it('handles multi-dimensional arrays', () => {
        expect(toJvmDescriptor('int[][]', identity)).toBe('[[I');
        expect(toJvmDescriptor('java.lang.String[][][]', identity)).toBe('[[[Ljava/lang/String;');
    });

    it('throws on empty input', () => {
        expect(() => toJvmDescriptor('', identity)).toThrow(/empty type name/);
    });
});

describe('parseSignatureArgs', () => {
    it('splits a no-arg signature into an empty array', () => {
        expect(parseSignatureArgs('()V')).toEqual([]);
    });

    it('splits primitive args', () => {
        expect(parseSignatureArgs('(IJF)V')).toEqual(['I', 'J', 'F']);
        expect(parseSignatureArgs('(ZBCSIJFD)V')).toEqual(['Z', 'B', 'C', 'S', 'I', 'J', 'F', 'D']);
    });

    it('splits class-ref args', () => {
        expect(parseSignatureArgs('(Landroid/os/Bundle;Lbbbb;)V')).toEqual([
            'Landroid/os/Bundle;',
            'Lbbbb;',
        ]);
    });

    it('splits mixed primitive and class args', () => {
        expect(parseSignatureArgs('(Landroid/os/Bundle;ILjava/lang/String;)V')).toEqual([
            'Landroid/os/Bundle;',
            'I',
            'Ljava/lang/String;',
        ]);
    });

    it('splits array args (primitive and object element)', () => {
        expect(parseSignatureArgs('([I[[Ljava/lang/String;)V')).toEqual([
            '[I',
            '[[Ljava/lang/String;',
        ]);
    });

    it('throws when signature does not start with (', () => {
        expect(() => parseSignatureArgs('I)V')).toThrow(/must start with '\('/);
    });

    it("throws when signature is missing ')'", () => {
        expect(() => parseSignatureArgs('(I')).toThrow(/missing '\)'/);
    });

    it("throws when an L descriptor isn't terminated", () => {
        expect(() => parseSignatureArgs('(Lfoo)V')).toThrow(/unterminated 'L'/);
    });

    it("throws when an L descriptor inside an array isn't terminated", () => {
        expect(() => parseSignatureArgs('([Lfoo)V')).toThrow(/unterminated 'L'/);
    });

    it('throws when an array prefix has no element', () => {
        expect(() => parseSignatureArgs('([)V')).toThrow(/array prefix without element/);
    });

    it('throws on an unknown descriptor character', () => {
        expect(() => parseSignatureArgs('(X)V')).toThrow(/unknown descriptor char 'X'/);
    });
});

/**
 * Structural validator for the converter module.
 *
 * Delegates to the canonical validator in `src/validate/schema.ts`
 * (authored by Wave 1A). Originally this file carried a stand-alone
 * Zod schema as a Wave-1-parallel-work placeholder; the duplicate
 * schema was removed at integration time so there is one source of
 * truth for what "structurally valid" means.
 */

export { validateMap as validateStructure } from '../validate/schema.js';

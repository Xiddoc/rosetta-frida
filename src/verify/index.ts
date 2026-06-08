/**
 * Map semantic-verify core — the framework-neutral, pure-function engine
 * behind `rosetta validate --deep`.
 *
 * `validate` proves a map is structurally well-formed (the canonical
 * schema). The semantic checks here run cross-entry relationships the schema
 * cannot express. Library-first: re-exported from the package root and
 * folded into the `validate --deep` verb (the standalone `verify` verb was
 * removed — it was `validate` differing only by check depth).
 */

export { verifyMap, type VerifyIssue, type VerifySeverity } from './verify.js';

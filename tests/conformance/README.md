# Resolver conformance suite (frida side)

This directory is the **TypeScript half** of the cross-client resolver
conformance suite mandated by RFC 0001 Decision 2 — _"two resolver
implementations (TS + Kotlin), one conformance suite."_ The same golden
fixtures drive both the Kotlin resolver (`rosetta-xposed` `:core`
`ConformanceTest.kt`) and the TypeScript resolver here so the two
implementations stay behaviour-identical.

## What lives here

- **`fixtures/*.json`** — **VENDORED** copies of the canonical,
  provider-neutral golden fixtures. They are the parity oracle.
- **`fixtures/README.md`** — the canonical fixture-schema spec (also
  vendored verbatim). Read it to understand the `kind` values,
  `expect*` fields, and the `Resolve` / `AmbiguousOverload` /
  `IllegalArgument` error taxonomy.
- **`conformance.test.ts`** — the frida runner. Loads every fixture from
  the manifest below and drives the real frida resolver / signature
  utilities against each case.

## These fixtures are VENDORED — keep them in sync

The fixtures are **not authored here.** Their canonical home is the
`rosetta-xposed` integration branch (and, ultimately, the `rosetta-maps`
community repo). They were copied verbatim from:

    rosetta-xposed: core/src/test/resources/conformance/
    source commit:  12b9ca1cedc3fac3680f8399de3b2d50689513d0

**When the canonical fixtures change, re-copy them here and update the
source commit above.** Do not edit the vendored JSON in place — that
would silently fork the parity oracle. If a case here reveals a genuine
TS-vs-Kotlin resolver behaviour divergence, that is a parity bug to
escalate, not a fixture to "fix" locally.

### Automated sync guard

A CI-enforced guard makes the byte-identity obligation un-skippable:
`scripts/check-conformance-fixtures.sh` (run via
`npm run conformance:fixtures:check`, wired into `npm run verify` and the
CI workflow) recomputes a SHA-256 manifest over `fixtures/` and diffs it
against `scripts/conformance-fixtures.sha256`. The **same manifest file**
is carried byte-identical in rosetta-xposed, whose CI runs the same check
against its own copy — so if either repo's fixtures drift from the shared
baseline, that repo's CI fails. **rosetta-xposed owns the authoritative
copy** (`core/src/test/resources/conformance/`); rosetta-frida vendors
from it. An intentional fixture change must re-vendor BOTH repos
byte-identical AND regenerate the manifest in BOTH (see the script header).

## Explicit manifest

`conformance.test.ts` enumerates fixtures from an **explicit manifest**
(`FIXTURES`), mirroring the Kotlin side's `ConformanceTest.fixtures`
list. Classpath/glob directory enumeration is brittle across build
layouts, so the manifest is hand-maintained: an unregistered fixture
file in `fixtures/` fails the suite loudly (a guard test asserts the
manifest covers every `*.json` on disk) rather than being silently
skipped. Add a new fixture's filename to `FIXTURES` when you vendor one.

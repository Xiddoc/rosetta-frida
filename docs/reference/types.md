# Types

Every type alias and interface exported from `rosetta-frida`. All
are re-exported from the package root and also from
`rosetta-frida/types` for callers that want to type-only-import.

```typescript
import type {
    RosettaMap,
    Session,
    Resolver,
    ClassProxy,
    DiagnosticEvent,
    // ...
} from 'rosetta-frida';
```

## Map types

Defined in `src/types/map.ts`.

### `RosettaMap`

```typescript
interface RosettaMap {
    schema_version: 2;
    app: string;
    version: string; // versionName label — fuzzy fallback only
    version_code: number; // authoritative selection key (RFC 0001)
    captured_at?: string;
    signer_sha256?: string; // signing-cert hash authenticity guard
    frida_min_version?: string;
    frida_max_version?: string;
    sources?: MapSource[];
    classes: ClassMap;
}
```

The top-level mapping file. See
[Map format reference](../maps/format.md) for field semantics.

### `RosettaMapRegistry`

```typescript
type RosettaMapRegistry = Record<string, RosettaMap>;
```

Multi-version registry — a record keyed by version string. Used in
multi-version bundles ([recipe](../recipes/multi-version-bundle.md)).

### `MapSource`

```typescript
interface MapSource {
    tool: string;
    config?: string;
    classes?: number;
    notes?: string;
    confidence?: Confidence;
}
```

Provenance entry. One per upstream tool / authoring pass.

### `Confidence`

```typescript
type Confidence = 'high' | 'medium' | 'low';
```

Per-entry or per-source confidence rating. Reserved for V2+ trust
workflows (e.g. a fuzzy-mode picker preferring high-confidence
entries).

### `ClassKind`

```typescript
type ClassKind =
    | 'class'
    | 'interface'
    | 'enum'
    | 'aidl_stub'
    | 'aidl_callback'
    | 'synthetic'
    | 'anonymous';
```

What kind of class an entry describes. Drives V2+ runtime discovery
strategies (e.g. `synthetic` and `anonymous` classes are skipped).

### `ClassEntry`

```typescript
interface ClassEntry {
    obfuscated: string;
    extends?: string;
    kind?: ClassKind;
    dex?: string;
    aidl_descriptor?: string;
    anchors?: string[];
    methods?: MethodMap;
    fields?: FieldMap;
    source?: string;
    confidence?: Confidence;
}
```

### `ClassMap`

```typescript
type ClassMap = Record<string, ClassEntry>;
```

Keyed by real fully-qualified class name.

### `MethodEntry`

```typescript
interface MethodEntry {
    obfuscated: string;
    signature: string;
    aidl_txn?: number;
    static?: boolean;
    synthetic?: boolean;
    is_constructor?: boolean;
}
```

### `MethodMap`

```typescript
type MethodMap = Record<string, MethodEntry | MethodEntry[]>;
```

Methods keyed by real name. Single-overload form uses
`MethodEntry`; multi-overload form uses `MethodEntry[]`.

### `FieldEntry`

```typescript
interface FieldEntry {
    obfuscated: string;
    type: string;
    static?: boolean;
}
```

### `FieldMap`

```typescript
type FieldMap = Record<string, FieldEntry>;
```

Keyed by real field name.

## Session types

Defined in `src/types/session.ts`.

### `Session`

```typescript
interface Session {
    readonly map: RosettaMap;
    readonly app: string;
    readonly version: string;
    readonly failurePolicy: FailurePolicy;
    readonly healthy: boolean;
}
```

The handle returned from `rosetta.session(...)`. Read-only — switch
sessions by calling `rosetta.session(...)` again rather than mutating
this.

### `SessionOptions`

```typescript
interface SessionOptions {
    map: RosettaMap | RosettaMapRegistry;
    app?: string;
    version?: string;
    versionCode?: number; // authoritative selection key; auto-detected if omitted
    failurePolicy?: FailurePolicy;
    versionMatch?: VersionMatch;
    trace?: boolean;
    healthCheckThreshold?: number;
    skipHealthCheck?: boolean;
}
```

The options bag for `rosetta.session(...)` / `createSession(...)`.
See [Session API](../api/session.md) for field semantics.

### `FailurePolicy`

```typescript
type FailurePolicy = 'strict' | 'warn';
```

How the Resolver responds to a missed lookup. See
[Concepts — failure policy](../getting-started/concepts.md#failure-policy).

### `VersionMatch`

```typescript
type VersionMatch = 'exact' | 'fuzzy';
```

How strictly registry version matching behaves. See
[Multi-version bundles](../recipes/multi-version-bundle.md).

## Resolver types

Defined in `src/types/resolver.ts`.

### `Resolver`

```typescript
interface Resolver {
    resolveClass(realName: string): ResolvedClass;
    resolveMethod(
        className: string,
        methodName: string,
        argTypes?: readonly string[],
    ): ResolvedMethod;
    resolveField(className: string, fieldName: string): ResolvedField;
    translateType(typeName: string): string;
    invalidate(realName: string): void;
    override(realName: string, entry: ClassEntry): void;
    lookupField(className: string, fieldName: string): FieldEntry | undefined;
}
```

The core abstraction. Implementations cache per-session, look up via
the map, and throw `ResolveError` on miss in `strict` mode.

The concrete implementation is `ResolverImpl`; build one via
`createResolver(map, { events, failurePolicy })`. Most users go
through `rosetta.session(...)` and don't construct a Resolver
directly.

### `ResolvedClass`

```typescript
interface ResolvedClass {
    realName: string;
    obfName: string;
    entry: ClassEntry;
}
```

### `ResolvedMethod`

```typescript
interface ResolvedMethod {
    realName: string;
    obfName: string;
    className: string;       // obfuscated short class name
    signature: string;
    aidlTxn?: number;
    static: boolean;
    allOverloads: MethodEntry[];
}
```

### `ResolvedField`

```typescript
interface ResolvedField {
    realName: string;
    obfName: string;
    className: string;       // obfuscated short class name
    type: string;
    static: boolean;
}
```

## Proxy types { #proxy-types }

Defined in `src/types/proxy.ts`. The contract for what
`rosetta.use(...)` returns.

### `ClassProxy`

```typescript
interface ClassProxy {
    readonly $realName: string;
    readonly $obfName: string;
    readonly $native: unknown;
    readonly $resolver: Resolver;
    $new(...args: unknown[]): unknown;
    [member: string]: unknown;
}
```

### `MethodHandle`

```typescript
interface MethodHandle {
    overload(...argTypes: readonly string[]): OverloadHandle;
    readonly overloads: readonly OverloadHandle[];
    implementation: ((...args: unknown[]) => unknown) | null;
    readonly $native: unknown;
}
```

### `OverloadHandle`

```typescript
interface OverloadHandle {
    readonly argumentTypes: readonly { className: string }[];
    readonly returnType: { className: string };
    implementation: ((...args: unknown[]) => unknown) | null;
}
```

### `FieldAccessor`

```typescript
interface FieldAccessor<T = unknown> {
    value: T;
}
```

### `InstanceProxy`

```typescript
interface InstanceProxy {
    readonly $realName: string;
    readonly $obfName: string;
    readonly $native: unknown;
    [member: string]: unknown;
}
```

Returned from `ClassProxy.$new(...)` and from internal paths that
wrap an instance for field translation.

## Tier-1 API types

Defined in `src/api/`.

### `HookHandle`

```typescript
interface HookHandle {
    detach(): void;
    readonly detached: boolean;
}
```

### `HookTarget`

```typescript
interface HookTarget {
    readonly class: string;
    readonly method: string;
    readonly args: readonly string[];
}
```

### `HookImpl`

```typescript
type HookImpl = (this: unknown, ...args: unknown[]) => unknown;
```

### `HookOptions`

```typescript
interface HookOptions {
    readonly resolver: Resolver;
}
```

For the explicit-resolver form `hook(target, impl, { resolver })`.
The ambient form `rosetta.hook(target, impl)` doesn't take options
— it reads from the current session.

### `FieldOptions`

```typescript
interface FieldOptions {
    readonly resolver: Resolver;
}
```

## Tier-2 API types

### `UseOptions`

```typescript
interface UseOptions extends ClassProxyOptions {
    resolver: Resolver;
}
```

### `TypeOptions`

```typescript
interface TypeOptions {
    resolver: Resolver;
}
```

## Tier-3 API types

### `MapApi`

```typescript
interface MapApi {
    resolveClass(realName: string): ResolvedClass;
    resolveMethod(
        className: string,
        methodName: string,
        argTypes?: readonly string[],
    ): ResolvedMethod;
    resolveField(className: string, fieldName: string): ResolvedField;
    override(realName: string, entry: ClassEntry): void;
    extract(): RosettaMap;
}
```

The Tier 3 `rosetta.map` surface — see
[Tier 3 — `rosetta.map`](../api/tier-3.md#rosettamap).

### `EventsApi`

```typescript
interface EventsApi {
    on(listener: EventListener): () => void;
    onType<T extends DiagnosticEvent['type']>(
        type: T,
        listener: EventListener<Extract<DiagnosticEvent, { type: T }>>,
    ): () => void;
}
```

The Tier 3 `rosetta.events` surface — see
[Tier 3 — `rosetta.events`](../api/tier-3.md#rosettaevents).

## Diagnostic event types

Defined in `src/types/events.ts`. See
[Events reference](events.md) for each event's semantics.

### `DiagnosticEvent`

```typescript
type DiagnosticEvent = ResolveEvent | HealthCheckEvent | DetectEvent | MapLoadEvent;
```

Tagged union over the four event kinds.

### `ResolveEvent`

```typescript
interface ResolveEvent {
    type: 'resolve';
    name: string;
    obfName?: string;
    source: 'cache' | 'map' | 'override';
    miss?: boolean;
    classScope?: string;
    overloadSignature?: string;
}
```

### `HealthCheckEvent`

```typescript
interface HealthCheckEvent {
    type: 'health-check';
    passed: boolean;
    rate: number;
    failedEntries: readonly string[];
    threshold: number;
}
```

### `DetectEvent`

```typescript
interface DetectEvent {
    type: 'detect';
    app: string;
    version: string;
    source: 'auto' | 'override';
}
```

### `MapLoadEvent`

```typescript
interface MapLoadEvent {
    type: 'map-load';
    app: string;
    version: string;
    classCount: number;
    schemaVersion: number;
}
```

### `EventListener`

```typescript
type EventListener<E extends DiagnosticEvent = DiagnosticEvent> = (event: E) => void;
```

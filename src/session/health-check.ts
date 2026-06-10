/**
 * Attach-time health check.
 *
 * Before user hooks run, verify the loaded map matches the running app:
 *
 *   0. For every mapped class, run the target-namespace guard
 *      ({@link isTargetAllowed}) on the raw `obfName` BEFORE it reaches
 *      `Java.use`. A denied entry is counted as a failure and the
 *      forbidden name never reaches Frida (mirrors the resolver's
 *      fail-closed invariant and the Kotlin client, which funnels every
 *      load through the guard).
 *   1. For every allowed mapped class, attempt `Java.use(obfName)`.
 *      Failed lookups mark the class as a failure.
 *
 * The map is a pure real→obfuscated mapping (schema_version 4), so there
 * is nothing further to assert against a loaded class — the
 * finding-evidence (AIDL descriptors, anchor string literals) that earlier
 * schema versions carried lived only in the signatures authoring source and
 * was never emitted into the map.
 *
 * The success rate (passing classes / total) is compared against a
 * configurable threshold (default 0.8). On failure, the session
 * decides what to do: `strict` failurePolicy → throw; `warn` → emit
 * a failure event but proceed.
 *
 * The Java runtime is injected so the check is unit-testable without
 * touching global state.
 */

import { defaultJavaBridge, type JavaBridge } from '../java-bridge.js';
import { isTargetAllowed } from '../resolver/index.js';
import type { RosettaMap } from '../types/map.js';
import type { TargetPolicy } from '../types/session.js';

/** Minimal Frida-shaped Java API used by the health check. */
export interface HealthCheckJavaApi {
    use(obfName: string): unknown;
}

/** Health-check input. */
export interface RunHealthCheckOptions {
    /** The map being checked. */
    map: RosettaMap;
    /**
     * Fraction of classes that must pass for the check itself to pass.
     * Defaults to 0.8.
     */
    threshold?: number;
    /** Injectable Java runtime. Defaults to deriving one from {@link bridge}. */
    javaApi?: HealthCheckJavaApi;
    /**
     * The seam onto Frida's global `Java`, used when `javaApi` is omitted.
     * Defaults to {@link defaultJavaBridge}. Lets tests drive the
     * global-fallback path without mutating `globalThis`.
     */
    bridge?: JavaBridge;
    /**
     * Target-namespace guard policy (RFC 0001 C1). The same policy the
     * Session threads into the resolver. Each class's raw `obfuscated`
     * name is checked against it BEFORE `Java.use`, so a map-controlled
     * framework FQN never gets loaded by the health check. Omitted →
     * built-in fail-closed defaults.
     */
    targetPolicy?: TargetPolicy;
    /**
     * App namespace prefix used by the guard (derived from the resolved
     * app package, the same source the resolver uses). Defaults to the
     * empty string (no app-owned namespace is implicitly allowed).
     */
    appPrefix?: string;
}

/** Health-check result. */
export interface HealthCheckResult {
    /** True iff `rate >= threshold`. */
    passed: boolean;
    /** Fraction of mapped classes that passed. */
    rate: number;
    /** Configured threshold. */
    threshold: number;
    /** Real names that failed (target-namespace guard denial or Java.use error). */
    failedEntries: readonly string[];
    /** Total mapped classes considered. */
    total: number;
}

/** Default acceptance threshold. */
export const DEFAULT_HEALTH_CHECK_THRESHOLD = 0.8;

/**
 * Run the attach-time health check.
 *
 * The function never throws — it returns a structured result. The
 * caller (the Session) is responsible for deciding whether to emit an
 * event, log a warning, or throw `HealthCheckFailedError` based on
 * the failure policy.
 */
export function runHealthCheck(options: RunHealthCheckOptions): HealthCheckResult {
    const { map } = options;
    const threshold = options.threshold ?? DEFAULT_HEALTH_CHECK_THRESHOLD;
    const bridge = options.bridge ?? defaultJavaBridge;
    const javaApi: HealthCheckJavaApi | null =
        options.javaApi ?? (bridge.available ? { use: (obfName) => bridge.use(obfName) } : null);
    const targetPolicy = options.targetPolicy ?? {};
    const appPrefix = options.appPrefix ?? '';

    if (!javaApi) {
        // Without a Java runtime, no entries can be verified.
        const entries = Object.keys(map.classes);
        return {
            passed: entries.length === 0,
            rate: entries.length === 0 ? 1 : 0,
            threshold,
            failedEntries: entries,
            total: entries.length,
        };
    }

    const failedEntries: string[] = [];
    const entries = Object.entries(map.classes);
    let passing = 0;

    for (const [realName, entry] of entries) {
        // (0) Guard the raw, map-controlled obfuscated name BEFORE it can
        //     reach `Java.use`. A denied entry is a failed health-check
        //     entry — it must never be loaded / `<clinit>`-initialized.
        if (!isTargetAllowed(entry.obfuscated, appPrefix, targetPolicy)) {
            failedEntries.push(realName);
            continue;
        }
        let ok: boolean;
        try {
            javaApi.use(entry.obfuscated);
            ok = true;
        } catch {
            ok = false;
        }
        if (ok) {
            passing += 1;
        } else {
            failedEntries.push(realName);
        }
    }

    if (entries.length === 0) {
        // Empty map: nothing to check; treat as trivially passing.
        return {
            passed: true,
            rate: 1,
            threshold,
            failedEntries: [],
            total: 0,
        };
    }

    const rate = passing / entries.length;
    return {
        passed: rate >= threshold,
        rate,
        threshold,
        failedEntries,
        total: entries.length,
    };
}

package com.example.testapp;

/**
 * Process-wide configuration constants.
 *
 * Exercises:
 *   <ul>
 *     <li>{@code kind: class} — fields-only Java class</li>
 *     <li>Static {@code final} primitive fields ({@code int}, {@code long},
 *         {@code boolean})</li>
 *     <li>Static {@code final} reference field — {@code ENDPOINT_URL}</li>
 *     <li>Mutable static field — {@code currentDebugLevel}</li>
 *     <li>Stable string anchor — "rosetta-test-anchor-Config" survives
 *         R8 because it's a {@code final static String} initializer</li>
 *   </ul>
 *
 * The whole class is intentionally simple so the R8-rotated dex bytes
 * are dominated by field-name rotation, not method-name rotation.
 */
public final class Config {

    /** Stable anchor — referenced by sigmatcher discovery. */
    public static final String ROSETTA_ANCHOR = "rosetta-test-anchor-Config";

    public static final boolean ENABLE_TRACING = false;
    public static final int MAX_RETRIES = 3;
    public static final long TIMEOUT_MILLIS = 30_000L;
    public static final String ENDPOINT_URL = "https://invalid.example/api";

    /** Mutable static — verifies non-final statics rotate independently. */
    public static int currentDebugLevel = 0;

    private Config() {
        // No instances; this class is a constant holder.
    }
}

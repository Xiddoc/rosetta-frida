package com.example.testapp;

import java.util.HashMap;

/**
 * Trivial in-memory cache for the synthetic test app.
 *
 * Exercises:
 *   <ul>
 *     <li>{@code kind: class} — plain Java class</li>
 *     <li>Multi-overload methods — two {@code put} overloads
 *         (one with TTL, one without)</li>
 *     <li>Instance fields — private {@code buffer}, public
 *         {@code lastEvictedKey}</li>
 *     <li>Static field — {@code MAX_SIZE}</li>
 *     <li>Stable anchor — "rosetta-test-anchor-BlobCache" survives R8</li>
 *   </ul>
 */
public class BlobCache {

    /** Stable cross-version anchor. */
    static final String ROSETTA_ANCHOR = "rosetta-test-anchor-BlobCache";

    /** Static field — exercised by rosetta-frida static-field reads. */
    public static final int MAX_SIZE = 1024;

    /** Mutable static — verifies non-final static fields rotate too. */
    public static int instanceCount = 0;

    private static BlobCache singleton;

    /** Private instance field. */
    private final HashMap<String, Object> buffer = new HashMap<>();

    /** Public instance field. */
    public String lastEvictedKey = null;

    public BlobCache() {
        instanceCount++;
    }

    public static synchronized BlobCache getInstance() {
        if (singleton == null) {
            singleton = new BlobCache();
        }
        return singleton;
    }

    /** Lookup — single overload. */
    public Object get(String key) {
        return buffer.get(key);
    }

    /** Insert without TTL — overload 1. */
    public void put(String key, Object value) {
        if (buffer.size() >= MAX_SIZE) {
            evict(key);
        }
        buffer.put(key, value);
    }

    /** Insert with TTL — overload 2.  Different signature, same real name. */
    public void put(String key, Object value, long ttlMillis) {
        if (buffer.size() >= MAX_SIZE) {
            evict(key);
        }
        buffer.put(key, value);
        // TTL itself is not exercised — what matters is the OVERLOAD.
        // The unused parameter is anchored so R8 keeps both overloads.
        if (ttlMillis < 0) {
            throw new IllegalArgumentException(ROSETTA_ANCHOR + ": negative TTL");
        }
    }

    public void evict(String key) {
        buffer.remove(key);
        lastEvictedKey = key;
    }

    public void clear() {
        buffer.clear();
    }
}

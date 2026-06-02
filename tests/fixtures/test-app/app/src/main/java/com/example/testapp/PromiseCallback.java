package com.example.testapp;

/**
 * Single-abstract-method functional interface.
 *
 * Exercises:
 *   <ul>
 *     <li>{@code kind: interface} — distinct from class / aidl_callback</li>
 *     <li>A real-name method ({@code apply}) reachable through a class
 *         that implements this interface ({@link RemoteServiceClient})</li>
 *   </ul>
 */
public interface PromiseCallback {

    /**
     * Stable cross-version anchor. Interface fields are implicitly
     * {@code public static final}; R8 keeps the literal in the field
     * table so sigmatcher can anchor the (rotated) interface on it.
     */
    String ROSETTA_ANCHOR = "rosetta-anchor-PromiseCallback";

    /** SAM method. */
    Object apply(Object input);
}

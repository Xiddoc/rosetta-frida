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
     *
     * Deliberately named {@code PROMISE_ANCHOR}, not {@code ROSETTA_ANCHOR}:
     * {@link RemoteServiceClient} implements this interface AND declares its
     * own {@code ROSETTA_ANCHOR} field. A same-named static field in the
     * implementor would <em>hide</em> this constant, and R8 then collapses
     * the implementor's own field onto this one's obfuscated slot
     * non-deterministically (it honoured the seed's {@code -> h} in v1.0.0
     * but reused this field's {@code e} in v1.1.0). A distinct name removes
     * the hide so each field rotates on its own pinned slot.
     */
    String PROMISE_ANCHOR = "rosetta-anchor-PromiseCallback";

    /** SAM method. */
    Object apply(Object input);
}

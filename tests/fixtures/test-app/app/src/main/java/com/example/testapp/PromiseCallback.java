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

    /** SAM method. */
    Object apply(Object input);
}

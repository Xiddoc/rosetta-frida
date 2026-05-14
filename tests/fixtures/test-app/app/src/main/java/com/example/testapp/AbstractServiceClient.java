package com.example.testapp;

import android.content.Context;

/**
 * Abstract base for service-client wrappers.
 *
 * Exercises:
 *   <ul>
 *     <li>{@code kind: class} (abstract) — for "{@code extends} chain"
 *         schema coverage, a concrete subclass ({@link RemoteServiceClient})
 *         extends this; this class extends {@link Object}</li>
 *     <li>Abstract method — subclasses implement {@code connect()}</li>
 *     <li>Static field — {@code INSTANCE_COUNT}</li>
 *     <li>Instance field — {@code context}</li>
 *     <li>Anonymous Runnable — exercises {@code kind: anonymous}
 *         alongside the one in {@link RemoteService}</li>
 *   </ul>
 */
public abstract class AbstractServiceClient {

    /** Static field — exercises rosetta-frida static-field rotation. */
    public static int INSTANCE_COUNT = 0;

    /** Instance field — typed reference, exercises Lcom/...; descriptor. */
    protected Context context;

    protected AbstractServiceClient(Context context) {
        this.context = context;
        INSTANCE_COUNT++;
    }

    /** Lifecycle hook — implementations connect to their backend. */
    public abstract void connect();

    /** Default disconnect — releases context reference. */
    public void disconnect() {
        this.context = null;
    }

    /**
     * Demonstration of an anonymous inner class living off an abstract
     * base.  R8 typically names this {@code AbstractServiceClient$1}.
     */
    protected Runnable retryHandle() {
        return new Runnable() {
            @Override
            public void run() {
                connect();
            }
        };
    }
}

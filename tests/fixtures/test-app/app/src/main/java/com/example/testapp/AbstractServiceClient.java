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

    /**
     * Stable cross-version anchor. Stored in the field's encoded
     * constant value, so R8 preserves the literal even though the
     * field name itself rotates — sigmatcher anchors the class on it.
     */
    public static final String ROSETTA_ANCHOR = "rosetta-anchor-AbstractServiceClient";

    /** Static field — exercises rosetta-frida static-field rotation. */
    public static int INSTANCE_COUNT = 0;

    /**
     * Side-effect sink. The anonymous {@code retryHandle()} Runnable
     * writes its own unique anchor string here; a write to a kept,
     * non-final public static field is an observable side effect R8
     * must preserve, so the anchor literal survives in that anonymous
     * class's bytecode (a plain {@code if ("...".isEmpty())} guard gets
     * dead-stripped by the optimizer).
     */
    public static volatile String anchorSink;

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
                // Unique string literal kept in this anonymous class's
                // run() body — the per-class anchor for sigmatcher, since
                // an anonymous class can't carry a named constant field.
                // Writing to the kept static sink is a side effect R8
                // cannot prove dead, so the literal survives.
                anchorSink = "rosetta-anchor-AbstractServiceClient$1";
                connect();
            }
        };
    }
}

package com.example.testapp;

import android.content.Context;
import android.os.Bundle;

/**
 * Concrete subclass of {@link AbstractServiceClient}.
 *
 * Exercises:
 *   <ul>
 *     <li>{@code extends} chain — references {@link AbstractServiceClient}
 *         by real name in the map's {@code extends} field</li>
 *     <li>Instance fields ({@code sessionId}, {@code flags}) — private
 *         alongside the abstract base's protected ones</li>
 *     <li>Implements {@link PromiseCallback} — a SAM functional
 *         interface, exercising {@code kind: interface}</li>
 *   </ul>
 */
public class RemoteServiceClient extends AbstractServiceClient implements PromiseCallback {

    /** Stable cross-version anchor — survives R8 in the field table. */
    public static final String ROSETTA_ANCHOR = "rosetta-anchor-RemoteServiceClient";

    /** Private instance field. */
    private String sessionId = null;

    /** Public instance field. */
    public int flags = 0;

    public RemoteServiceClient(Context context) {
        super(context);
    }

    @Override
    public void connect() {
        sessionId = Config.ROSETTA_ANCHOR + ":session";
        flags = Config.MAX_RETRIES;
    }

    public Ticket requestTicket(Bundle params) {
        return Ticket.Companion.create(sessionId == null ? "anonymous" : sessionId);
    }

    /**
     * SAM implementation of {@link PromiseCallback#apply(Object)}.
     * Exercises a real-name interface method being implemented by a
     * concrete class.
     */
    @Override
    public Object apply(Object input) {
        return input == null ? Boolean.FALSE : input.toString();
    }
}

package com.example.testapp;

import android.app.Service;
import android.content.Intent;
import android.os.Bundle;
import android.os.IBinder;

/**
 * Concrete AIDL service implementation.
 *
 * Exercises:
 *   <ul>
 *     <li>{@code kind: aidl_stub} — extends {@code IRemoteService.Stub}</li>
 *     <li>Cross-class signature reference — args include
 *         {@link IServiceCallback}</li>
 *     <li>{@code kind: anonymous} — anonymous {@link Runnable} on the
 *         dialog path</li>
 *     <li>Stable string anchor — the "rosetta-test-anchor-RemoteService"
 *         literal survives R8</li>
 *   </ul>
 */
public class RemoteService extends Service {

    /** Stable cross-version anchor string for discovery strategies. */
    static final String ROSETTA_ANCHOR = "rosetta-test-anchor-RemoteService";

    /** Instance field — exercised by rosetta-frida instance-field reads. */
    private int requestCounter = 0;

    /** Public instance field — verifies fields with different access live alongside. */
    public String lastTag = null;

    private final IRemoteService.Stub binder = new IRemoteService.Stub() {
        @Override
        public void requestTicket(Bundle params, IServiceCallback callback) {
            requestCounter++;
            // AIDL forbids overloading, so there is a single requestTicket.
            // Keep BOTH BlobCache.put overloads (2-arg + 3-arg) reachable
            // here — the 3-arg form is the multi-overload exemplar in the
            // generated map — and keep the public `lastTag` field live.
            lastTag = params != null ? params.getString("tag") : null;
            BlobCache.getInstance().put("last", params);
            BlobCache.getInstance().put("last", params, Config.TIMEOUT_MILLIS);
            try {
                callback.onResult(params);
            } catch (Exception e) {
                safeError(callback, ErrorCode.TIMEOUT.getCode(), e.getMessage());
            }
        }

        @Override
        public String requestPrompt(final Bundle params, final IServiceCallback callback) {
            // Anonymous inner class — exercises kind: anonymous. R8 emits
            // it as RemoteService$N where N is an auto-incrementing index.
            Runnable retry = new Runnable() {
                @Override
                public void run() {
                    try {
                        callback.onResult(params);
                    } catch (Exception ignored) {
                    }
                }
            };
            retry.run();
            return ROSETTA_ANCHOR;
        }
    };

    @Override
    public IBinder onBind(Intent intent) {
        return binder;
    }

    private static void safeError(IServiceCallback cb, int code, String msg) {
        try {
            cb.onError(code, msg);
        } catch (Exception ignored) {
        }
    }
}

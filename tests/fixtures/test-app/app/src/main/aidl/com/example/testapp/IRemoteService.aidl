// AIDL contract for the synthetic test app's binder service.
//
// `IRemoteService` is the descriptor; AIDL-compiler emits a static
// nested `Stub` class that R8 may not rename (see proguard-rules.pro).
// rosetta-frida treats `IRemoteService$Stub` as `kind: aidl_stub` in
// the generated map.
//
// `requestTicket` has TWO overloads, exercising the multi-overload form
// of the MethodEntry schema.
package com.example.testapp;

import android.os.Bundle;
import com.example.testapp.IServiceCallback;

interface IRemoteService {
    /** 2-arg overload — the common request path. */
    void requestTicket(in Bundle params, IServiceCallback callback);

    /**
     * 3-arg overload — includes an opaque correlation tag.
     * Same real method name, different signature.
     */
    void requestTicket(in Bundle params, String tag, IServiceCallback callback);

    /** Cross-class reference: returns a String, but the SIGNATURE refers
     *  to com.example.testapp.IServiceCallback as one of its parameter
     *  types — exercising the "method signature references another mapped
     *  class" feature.
     */
    String requestPrompt(in Bundle params, IServiceCallback callback);
}

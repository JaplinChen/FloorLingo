package io.github.japlinchen.floorlingo.errors;

/** 401 Unauthorized — missing or invalid API key. */
public class FloorLingoAuthError extends FloorLingoApiError {
    public FloorLingoAuthError(String message, int status, Object body, String errorKind) {
        super(message, status, body, errorKind);
    }
}

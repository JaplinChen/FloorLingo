package io.github.japlinchen.floorlingo.errors;

/** 409 Conflict — typically an engine-not-ready condition from the backend. */
public class FloorLingoConflictError extends FloorLingoApiError {
    public FloorLingoConflictError(String message, int status, Object body, String errorKind) {
        super(message, status, body, errorKind);
    }
}

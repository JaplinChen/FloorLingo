package io.github.japlinchen.floorlingo.errors;

/** 501 Not Implemented — the active engine does not support this operation. */
public class FloorLingoNotImplementedError extends FloorLingoApiError {
    public FloorLingoNotImplementedError(String message, int status, Object body, String errorKind) {
        super(message, status, body, errorKind);
    }
}

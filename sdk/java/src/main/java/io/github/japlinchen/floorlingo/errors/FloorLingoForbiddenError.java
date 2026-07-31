package io.github.japlinchen.floorlingo.errors;

/** 403 Forbidden — the API key's role is insufficient for this endpoint. */
public class FloorLingoForbiddenError extends FloorLingoApiError {
    public FloorLingoForbiddenError(String message, int status, Object body, String errorKind) {
        super(message, status, body, errorKind);
    }
}

package io.github.japlinchen.floorlingo.errors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class ErrorsTest {
    @Test
    void mapsStatusToSubclassAndParsesNestEnvelope() {
        String body = "{\"statusCode\":404,\"message\":\"Session not found\",\"error\":\"Not Found\"}";
        FloorLingoApiError e = FloorLingoApiError.fromResponse(404, "Not Found", body, "GET /api/sessions/x");
        assertTrue(e instanceof FloorLingoNotFoundError);
        assertEquals(404, e.status());
        assertEquals("Not Found", e.errorKind());
        assertTrue(e.getMessage().contains("Session not found"));
    }

    @Test
    void joinsArrayMessages() {
        String body = "{\"statusCode\":400,\"message\":[\"a must be set\",\"b invalid\"],\"error\":\"Bad Request\"}";
        FloorLingoApiError e = FloorLingoApiError.fromResponse(400, "Bad Request", body, "POST /x");
        assertTrue(e.getMessage().contains("a must be set, b invalid"));
    }

    @Test
    void unmappedStatusFallsBackToBase() {
        FloorLingoApiError e = FloorLingoApiError.fromResponse(418, "I'm a teapot", "", "GET /x");
        assertEquals(FloorLingoApiError.class, e.getClass());
        assertEquals(418, e.status());
    }

    @Test
    void redirectStatusGetsClearMessage() {
        FloorLingoApiError e = FloorLingoApiError.fromResponse(302, "Found", "", "GET /x");
        assertFalse(e instanceof FloorLingoNotFoundError);
        assertTrue(e.getMessage().toLowerCase().contains("redirect"));
    }

    @Test
    void timeoutErrorMessage() {
        FloorLingoTimeoutError t = new FloorLingoTimeoutError(30000);
        assertTrue(t.getMessage().contains("30000"));
        assertTrue(t instanceof FloorLingoError);
    }

    @Test
    void blankStatusTextProducesNoDoubleSpace() {
        // The default transport exposes no HTTP reason phrase, so the client passes "" as statusText.
        String body = "{\"statusCode\":404,\"message\":\"Session x not found\",\"error\":\"Not Found\"}";
        FloorLingoApiError e = FloorLingoApiError.fromResponse(404, "", body, "GET /api/sessions/x");
        assertTrue(e.getMessage().contains("Session x not found"));
        assertFalse(e.getMessage().contains("404  "), "must not emit a double space when statusText is blank");
        assertTrue(e.getMessage().startsWith("FloorLingo API 404 — GET /api/sessions/x"));
    }

    @Test
    void partialEnvelopeWithoutErrorFieldStillKeepsMessage() {
        // NestJS default 500 carries {statusCode, message} but no `error` field — the message must survive.
        String body = "{\"statusCode\":500,\"message\":\"Internal server error\"}";
        FloorLingoApiError e = FloorLingoApiError.fromResponse(500, "", body, "GET /api/x");
        assertEquals(FloorLingoApiError.class, e.getClass());
        assertTrue(e.getMessage().contains("Internal server error"), "message text must not be dropped");
    }

    @Test
    void bodylessErrorHasCleanMessage() {
        FloorLingoApiError e = FloorLingoApiError.fromResponse(502, "", "", "GET /api/x");
        assertEquals("FloorLingo API 502 — GET /api/x", e.getMessage());
    }
}

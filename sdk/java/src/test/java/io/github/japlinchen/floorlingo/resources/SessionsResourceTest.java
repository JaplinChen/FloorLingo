package io.github.japlinchen.floorlingo.resources;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.japlinchen.floorlingo.ClientConfig;
import io.github.japlinchen.floorlingo.FloorLingoClient;
import io.github.japlinchen.floorlingo.http.HttpMethod;
import io.github.japlinchen.floorlingo.model.RequestPairingCodeRequest;
import io.github.japlinchen.floorlingo.support.MockTransport;
import org.junit.jupiter.api.Test;

class SessionsResourceTest {
    final MockTransport tx = new MockTransport();
    final FloorLingoClient client = new FloorLingoClient(
        ClientConfig.builder().baseUrl("http://h").apiKey("k").transport(tx).build());

    @Test
    void listHitsSessionsRoot() {
        tx.respond(200, "[]");
        client.sessions.list();
        assertEquals("http://h/api/sessions", tx.lastRequest().url());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
    }

    @Test
    void getEncodesId() {
        tx.respond(200, "{\"id\":\"a/b\",\"name\":\"n\",\"status\":\"ready\"}");
        client.sessions.get("a/b");
        assertEquals("http://h/api/sessions/a%2Fb", tx.lastRequest().url());
    }

    @Test
    void startHitsStartPath() {
        tx.respond(200, "{\"id\":\"s\",\"name\":\"n\",\"status\":\"initializing\"}");
        client.sessions.start("s");
        assertEquals("http://h/api/sessions/s/start", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
    }

    @Test
    void requestPairingCodeSendsBody() {
        tx.respond(200, "{\"pairingCode\":\"ABCD1234\",\"status\":\"qr_ready\"}");
        client.sessions.requestPairingCode("s", RequestPairingCodeRequest.builder().phoneNumber("628123").build());
        assertEquals("http://h/api/sessions/s/pairing-code", tx.lastRequest().url());
        assertTrue(tx.lastRequest().body().contains("628123"));
    }

    @Test
    void statsHitsOverview() {
        tx.respond(200, "{\"total\":0,\"active\":0,\"ready\":0,\"disconnected\":0}");
        client.sessions.stats();
        assertEquals("http://h/api/sessions/stats/overview", tx.lastRequest().url());
    }
}

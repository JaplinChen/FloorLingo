package io.github.japlinchen.floorlingo.resources;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.japlinchen.floorlingo.ClientConfig;
import io.github.japlinchen.floorlingo.FloorLingoClient;
import io.github.japlinchen.floorlingo.http.HttpMethod;
import io.github.japlinchen.floorlingo.model.AddLabelRequest;
import io.github.japlinchen.floorlingo.support.MockTransport;
import org.junit.jupiter.api.Test;

class LabelsResourceTest {
    final MockTransport tx = new MockTransport();
    final FloorLingoClient client = new FloorLingoClient(
        ClientConfig.builder().baseUrl("http://h").apiKey("k").transport(tx).build());

    @Test
    void listHitsLabelsPath() {
        tx.respond(200, "[]");
        client.labels.list("s");
        assertEquals("http://h/api/sessions/s/labels", tx.lastRequest().url());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
    }

    @Test
    void getEncodesIds() {
        tx.respond(200, "{\"id\":\"a/b\",\"name\":\"VIP\"}");
        client.labels.get("s", "a/b");
        assertEquals("http://h/api/sessions/s/labels/a%2Fb", tx.lastRequest().url());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
    }

    @Test
    void forChatHitsChatPath() {
        tx.respond(200, "[]");
        client.labels.forChat("s", "628123@c.us");
        assertEquals("http://h/api/sessions/s/labels/chat/628123@c.us", tx.lastRequest().url());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
    }

    @Test
    void addToChatSendsBody() {
        tx.respond(200, "{\"success\":true}");
        client.labels.addToChat("s", "628123@c.us", AddLabelRequest.builder().labelId("lbl-42").build());
        assertEquals("http://h/api/sessions/s/labels/chat/628123@c.us", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
        assertTrue(tx.lastRequest().body().contains("lbl-42"));
    }

    @Test
    void removeFromChatEncodesLabelId() {
        tx.respond(200, "{\"success\":true}");
        client.labels.removeFromChat("s", "628123@c.us", "lbl/42");
        assertEquals(
            "http://h/api/sessions/s/labels/chat/628123@c.us/lbl%2F42", tx.lastRequest().url());
        assertEquals(HttpMethod.DELETE, tx.lastRequest().method());
    }
}

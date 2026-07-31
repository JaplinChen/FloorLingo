package io.github.japlinchen.floorlingo.resources;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.japlinchen.floorlingo.ClientConfig;
import io.github.japlinchen.floorlingo.FloorLingoClient;
import io.github.japlinchen.floorlingo.http.HttpMethod;
import io.github.japlinchen.floorlingo.model.SendImageStatusRequest;
import io.github.japlinchen.floorlingo.model.SendTextStatusRequest;
import io.github.japlinchen.floorlingo.model.SendVideoStatusRequest;
import io.github.japlinchen.floorlingo.model.StatusMediaInput;
import io.github.japlinchen.floorlingo.support.MockTransport;
import java.util.List;
import org.junit.jupiter.api.Test;

class StatusResourceTest {
    final MockTransport tx = new MockTransport();
    final FloorLingoClient client = new FloorLingoClient(
        ClientConfig.builder().baseUrl("http://h").apiKey("k").transport(tx).build());
    // The client's `status` field is wired separately; drive the resource directly here.
    final StatusResource status = new StatusResource(client);

    @Test
    void listHitsStatusPath() {
        tx.respond(200, "{\"statuses\":[]}");
        status.list("s");
        assertEquals("http://h/api/sessions/s/status", tx.lastRequest().url());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
    }

    @Test
    void listEncodesSessionId() {
        tx.respond(200, "{\"statuses\":[{\"id\":\"x\",\"type\":\"text\",\"timestamp\":\"2026-01-01\"}]}");
        status.list("a/b");
        assertEquals("http://h/api/sessions/a%2Fb/status", tx.lastRequest().url());
    }

    @Test
    void fromContactEncodesBothSegments() {
        tx.respond(200, "{\"statuses\":[]}");
        status.fromContact("s", "628123@c.us");
        assertEquals("http://h/api/sessions/s/status/628123@c.us", tx.lastRequest().url());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
    }

    @Test
    void sendTextPostsBody() {
        tx.respond(200, "{\"statusId\":\"st1\",\"timestamp\":\"2026-01-01T00:00:00Z\",\"expiresAt\":\"2026-01-02T00:00:00Z\"}");
        status.sendText(
            "s",
            SendTextStatusRequest.builder()
                .text("hello world")
                .recipients(List.of("628@c.us"))
                .backgroundColor("#25D366")
                .font(2)
                .build());
        assertEquals("http://h/api/sessions/s/status/send-text", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
        assertTrue(tx.lastRequest().body().contains("hello world"));
        assertTrue(tx.lastRequest().body().contains("#25D366"));
    }

    @Test
    void sendImagePostsNestedMediaBody() {
        tx.respond(200, "{\"statusId\":\"st2\",\"timestamp\":\"2026-01-01T00:00:00Z\",\"expiresAt\":\"2026-01-02T00:00:00Z\"}");
        status.sendImage(
            "s",
            SendImageStatusRequest.builder()
                .image(StatusMediaInput.builder().url("https://ex.com/a.jpg").build())
                .recipients(List.of("628@c.us"))
                .caption("cap")
                .build());
        assertEquals("http://h/api/sessions/s/status/send-image", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
        assertTrue(tx.lastRequest().body().contains("\"image\""));
        assertTrue(tx.lastRequest().body().contains("https://ex.com/a.jpg"));
    }

    @Test
    void sendVideoPostsNestedMediaBody() {
        tx.respond(200, "{\"statusId\":\"st3\",\"timestamp\":\"2026-01-01T00:00:00Z\",\"expiresAt\":\"2026-01-02T00:00:00Z\"}");
        status.sendVideo(
            "s",
            SendVideoStatusRequest.builder()
                .video(StatusMediaInput.builder().base64("AAAA").build())
                .recipients(List.of("628@c.us"))
                .build());
        assertEquals("http://h/api/sessions/s/status/send-video", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
        assertTrue(tx.lastRequest().body().contains("\"video\""));
        assertTrue(tx.lastRequest().body().contains("AAAA"));
    }

    @Test
    void deleteEncodesStatusId() {
        tx.respond(204, "");
        status.delete("s", "status/1");
        assertEquals("http://h/api/sessions/s/status/status%2F1", tx.lastRequest().url());
        assertEquals(HttpMethod.DELETE, tx.lastRequest().method());
    }
}

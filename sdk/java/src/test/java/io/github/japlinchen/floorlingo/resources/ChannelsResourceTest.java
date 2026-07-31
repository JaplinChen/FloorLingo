package io.github.japlinchen.floorlingo.resources;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.japlinchen.floorlingo.ClientConfig;
import io.github.japlinchen.floorlingo.FloorLingoClient;
import io.github.japlinchen.floorlingo.http.HttpMethod;
import io.github.japlinchen.floorlingo.model.ChannelMessageQuery;
import io.github.japlinchen.floorlingo.model.SubscribeChannelRequest;
import io.github.japlinchen.floorlingo.support.MockTransport;
import org.junit.jupiter.api.Test;

class ChannelsResourceTest {
    final MockTransport tx = new MockTransport();
    final FloorLingoClient client = new FloorLingoClient(
        ClientConfig.builder().baseUrl("http://h").apiKey("k").transport(tx).build());

    @Test
    void listHitsChannelsRoot() {
        tx.respond(200, "[]");
        client.channels.list("s");
        assertEquals("http://h/api/sessions/s/channels", tx.lastRequest().url());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
    }

    @Test
    void getEncodesSessionIdKeepsAtInChannelId() {
        tx.respond(200, "{\"id\":\"123@newsletter\"}");
        client.channels.get("a/b", "123@newsletter");
        assertEquals("http://h/api/sessions/a%2Fb/channels/123@newsletter", tx.lastRequest().url());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
    }

    @Test
    void messagesSerializesQueryIntoUrl() {
        tx.respond(200, "[]");
        client.channels.messages("s", "123@newsletter", ChannelMessageQuery.builder().limit(10).build());
        assertEquals(
            "http://h/api/sessions/s/channels/123@newsletter/messages?limit=10", tx.lastRequest().url());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
    }

    @Test
    void messagesOmitsQueryWhenNull() {
        tx.respond(200, "[]");
        client.channels.messages("s", "c", null);
        assertEquals("http://h/api/sessions/s/channels/c/messages", tx.lastRequest().url());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
    }

    @Test
    void subscribeSendsInviteCodeBody() {
        tx.respond(200, "{\"id\":\"123@newsletter\"}");
        client.channels.subscribe("s", SubscribeChannelRequest.builder().inviteCode("abc123").build());
        assertEquals("http://h/api/sessions/s/channels/subscribe", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
        assertTrue(tx.lastRequest().body().contains("abc123"));
    }

    @Test
    void unsubscribeHitsDelete() {
        tx.respond(200, "{\"success\":true,\"message\":\"ok\"}");
        client.channels.unsubscribe("s", "123@newsletter");
        assertEquals("http://h/api/sessions/s/channels/123@newsletter", tx.lastRequest().url());
        assertEquals(HttpMethod.DELETE, tx.lastRequest().method());
    }
}

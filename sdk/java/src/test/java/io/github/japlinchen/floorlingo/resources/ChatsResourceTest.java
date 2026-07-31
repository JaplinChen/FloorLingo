package io.github.japlinchen.floorlingo.resources;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.japlinchen.floorlingo.ClientConfig;
import io.github.japlinchen.floorlingo.FloorLingoClient;
import io.github.japlinchen.floorlingo.http.HttpMethod;
import io.github.japlinchen.floorlingo.model.ChatState;
import io.github.japlinchen.floorlingo.model.DeleteChatRequest;
import io.github.japlinchen.floorlingo.model.ListChatsQuery;
import io.github.japlinchen.floorlingo.model.MarkChatRequest;
import io.github.japlinchen.floorlingo.model.SendChatStateRequest;
import io.github.japlinchen.floorlingo.support.MockTransport;
import org.junit.jupiter.api.Test;

class ChatsResourceTest {
    final MockTransport tx = new MockTransport();
    final FloorLingoClient client = new FloorLingoClient(
        ClientConfig.builder().baseUrl("http://h").apiKey("k").transport(tx).build());

    @Test
    void listHitsChatsPath() {
        tx.respond(200, "[]");
        client.chats.list("s");
        assertEquals("http://h/api/sessions/s/chats", tx.lastRequest().url());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
    }

    @Test
    void listEncodesSessionId() {
        tx.respond(200, "[]");
        client.chats.list("a/b");
        assertEquals("http://h/api/sessions/a%2Fb/chats", tx.lastRequest().url());
    }

    @Test
    void listSerializesQuery() {
        tx.respond(200, "[]");
        client.chats.list("s", ListChatsQuery.builder().limit(10).offset(20).build());
        assertEquals("http://h/api/sessions/s/chats?limit=10&offset=20", tx.lastRequest().url());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
    }

    @Test
    void markReadSendsBody() {
        tx.respond(200, "{\"success\":true}");
        client.chats.markRead("s", MarkChatRequest.builder().chatId("628123@c.us").build());
        assertEquals("http://h/api/sessions/s/chats/read", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
        assertTrue(tx.lastRequest().body().contains("628123@c.us"));
    }

    @Test
    void markUnreadSendsBody() {
        tx.respond(200, "{\"success\":true}");
        client.chats.markUnread("s", MarkChatRequest.builder().chatId("628999@c.us").build());
        assertEquals("http://h/api/sessions/s/chats/unread", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
        assertTrue(tx.lastRequest().body().contains("628999@c.us"));
    }

    @Test
    void deleteSendsBody() {
        tx.respond(200, "{\"success\":true}");
        client.chats.delete("s", DeleteChatRequest.builder().chatId("628321@c.us").build());
        assertEquals("http://h/api/sessions/s/chats/delete", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
        assertTrue(tx.lastRequest().body().contains("628321@c.us"));
    }

    @Test
    void sendStateSerializesEnumAndBody() {
        tx.respond(200, "{\"success\":true}");
        client.chats.sendState(
            "s", SendChatStateRequest.builder().chatId("628555@c.us").state(ChatState.TYPING).build());
        assertEquals("http://h/api/sessions/s/chats/typing", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
        assertTrue(tx.lastRequest().body().contains("628555@c.us"));
        assertTrue(tx.lastRequest().body().contains("typing"));
    }
}

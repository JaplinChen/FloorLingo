package io.github.japlinchen.floorlingo.resources;

import static io.github.japlinchen.floorlingo.http.Http.encodeSegment;

import io.github.japlinchen.floorlingo.FloorLingoClient;
import io.github.japlinchen.floorlingo.http.HttpMethod;
import io.github.japlinchen.floorlingo.model.CreateWebhookRequest;
import io.github.japlinchen.floorlingo.model.UpdateWebhookRequest;
import io.github.japlinchen.floorlingo.model.WebhookResponse;
import io.github.japlinchen.floorlingo.model.WebhookTestResult;
import java.util.List;

/** Webhooks resource — configure event delivery to external HTTP endpoints. */
public final class WebhooksResource {
    private final FloorLingoClient client;

    public WebhooksResource(FloorLingoClient client) {
        this.client = client;
    }

    /** List all webhooks for a session. */
    public List<WebhookResponse> list(String sessionId) {
        return client.requestList(
            HttpMethod.GET, "/api/sessions/" + encodeSegment(sessionId) + "/webhooks", null, null, WebhookResponse.class);
    }

    /** Get a single webhook by id. */
    public WebhookResponse get(String sessionId, String id) {
        return client.request(
            HttpMethod.GET,
            "/api/sessions/" + encodeSegment(sessionId) + "/webhooks/" + encodeSegment(id),
            null,
            null,
            WebhookResponse.class);
    }

    /** Create a new webhook. */
    public WebhookResponse create(String sessionId, CreateWebhookRequest body) {
        return client.request(
            HttpMethod.POST, "/api/sessions/" + encodeSegment(sessionId) + "/webhooks", null, body, WebhookResponse.class);
    }

    /** Update a webhook. */
    public WebhookResponse update(String sessionId, String id, UpdateWebhookRequest body) {
        return client.request(
            HttpMethod.PUT,
            "/api/sessions/" + encodeSegment(sessionId) + "/webhooks/" + encodeSegment(id),
            null,
            body,
            WebhookResponse.class);
    }

    /** Delete a webhook. */
    public void delete(String sessionId, String id) {
        client.requestVoid(
            HttpMethod.DELETE, "/api/sessions/" + encodeSegment(sessionId) + "/webhooks/" + encodeSegment(id), null, null);
    }

    /** Trigger a test dispatch to the webhook URL and report the result. */
    public WebhookTestResult test(String sessionId, String id) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/webhooks/" + encodeSegment(id) + "/test",
            null,
            null,
            WebhookTestResult.class);
    }
}

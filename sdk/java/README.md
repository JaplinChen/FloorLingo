# FloorLingo Java SDK

Official Java client for the [FloorLingo](https://github.com/JaplinChen/FloorLingo)
WhatsApp API Gateway.

Hand-written against the exact API surface (paths, DTOs, response shapes) and
unit-tested with a mock HTTP transport that asserts on the precise request URL,
method, and body — so contract drift is caught at test time. Synchronous,
Java 17+, one runtime dependency ([Gson](https://github.com/google/gson)).

## Install

**Maven**

```xml
<dependency>
  <groupId>io.github.japlinchen</groupId>
  <artifactId>floorlingo</artifactId>
  <version>0.1.1</version>
</dependency>
```

**Gradle**

```groovy
implementation 'io.github.japlinchen:floorlingo:0.1.1'
```

## Quickstart

```java
import io.github.japlinchen.floorlingo.FloorLingoClient;
import io.github.japlinchen.floorlingo.model.MessageResponse;
import io.github.japlinchen.floorlingo.model.SendTextRequest;

FloorLingoClient client = new FloorLingoClient("http://localhost:2785", "owa_k1_…");

client.sessions.start("my-session");

MessageResponse result = client.messages.sendText("my-session",
    SendTextRequest.builder()
        .chatId("628123456789@c.us")
        .text("Hello from the FloorLingo Java SDK!")
        .build());

System.out.println(result.messageId());
```

For full control over configuration (timeout, default headers, a custom
transport), build a `ClientConfig`:

```java
import io.github.japlinchen.floorlingo.ClientConfig;
import java.time.Duration;

FloorLingoClient client = new FloorLingoClient(ClientConfig.builder()
    .baseUrl("https://wa.example.com")
    .apiKey("owa_k1_…")
    .timeout(Duration.ofSeconds(15))
    .build());
```

## Resources

The client exposes the same fluent resource surface as the JavaScript, Python,
and PHP SDKs:

`sessions` · `messages` · `contacts` · `groups` · `webhooks` · `chats` ·
`labels` · `channels` · `catalog` · `status` · `templates` · `health` · `search`,
plus `client.auth()`.

Operator-only modules (`docker`, `metrics`, `infra`, `plugins`, `mcp`) are
intentionally not exposed; all user-facing resources are.

## Error handling

Errors are a typed, unchecked hierarchy — branch with `instanceof` or on
`.status()`:

```java
import io.github.japlinchen.floorlingo.errors.FloorLingoConflictError;
import io.github.japlinchen.floorlingo.errors.FloorLingoNotFoundError;

try {
    client.messages.sendText("my-session", body);
} catch (FloorLingoConflictError e) {
    // 409 — engine not ready
} catch (FloorLingoNotFoundError e) {
    // 404 — session or chat not found
}
```

| Class                        | HTTP | Meaning                                  |
| ---------------------------- | ---- | ---------------------------------------- |
| `FloorLingoAuthError`            | 401  | Missing or invalid API key               |
| `FloorLingoForbiddenError`       | 403  | API key role insufficient                |
| `FloorLingoNotFoundError`        | 404  | Resource not found                       |
| `FloorLingoConflictError`        | 409  | Engine not ready                         |
| `FloorLingoRateLimitError`       | 429  | Rate limited                             |
| `FloorLingoNotImplementedError`  | 501  | Active engine does not support the call  |
| `FloorLingoApiError`             | —    | Any other non-2xx (carries `.status()`)  |
| `FloorLingoTimeoutError`         | —    | Request exceeded the configured timeout  |

All extend `FloorLingoError` (a `RuntimeException`).

## Reliability & security

- **Use HTTPS in production.** The API key is sent as `X-API-Key` on every
  request and is bearer-equivalent — never send it over plaintext `http://`
  outside local development.
- **No automatic retries.** A failed request throws immediately; wrap calls in
  your own backoff if you need retries (especially for `429`). Inject a custom
  `HttpTransport` for retry or observability middleware.
- **Redirects are never followed.** A `3xx` surfaces as an `FloorLingoApiError`
  rather than being followed, so the API key is never re-sent to a redirect
  target.
- **Default per-request timeout** is 30 s (configurable). Path segments (chat /
  message ids) are percent-encoded; a base-URL path prefix (e.g. behind a proxy
  at `/v1`) is preserved.

## Development

```bash
cd sdk/java
mvn -B verify        # compile + run the full test suite
```

Tests inject a recording `HttpTransport` and assert on the exact path — so the
regression that would ship a broken `messages/text` path (the real path is
`messages/send-text`) can never recur silently.

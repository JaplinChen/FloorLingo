# japlinchen/floorlingo

Official PHP SDK for the [FloorLingo](https://github.com/JaplinChen/FloorLingo) WhatsApp API Gateway.

A synchronous client built on [Guzzle](https://docs.guzzlephp.org/), PSR-4 autoloaded.

## Install

```bash
composer require japlinchen/floorlingo
```

Requires PHP 8.1+ and Guzzle 7. The namespace is `FloorLingo\`.

## Usage

```php
<?php
require 'vendor/autoload.php';

use FloorLingo\Client;

$client = new Client([
    'baseUrl' => 'https://your-gateway.example.com',
    'apiKey'  => 'owa_k1_…',
]);

$client->sessions->start('my-session');

$result = $client->messages->sendText('my-session', [
    'chatId' => '628123456789@c.us',
    'text'   => 'Hello from the FloorLingo PHP SDK!',
]);
echo $result['messageId'];
```

For tests, inject a Guzzle client whose handler is a `MockHandler` — no network, no global state:

```php
$client = new Client([
    'baseUrl'    => 'http://x',
    'apiKey'     => 'k',
    'httpClient' => $mockGuzzleClient,
]);
```

## Messaging

> Voice notes: pass `'ptt' => true` to `sendAudio` to send a real WhatsApp voice note (PTT). Supply `audio/ogg; codecs=opus` audio for reliable playback; the server defaults the mimetype to that when `ptt` is set without one.

## Errors

A non-2xx response throws a typed `FloorLingo\Exceptions\FloorLingoApiException` subclass —
`FloorLingoAuthException` (401), `FloorLingoForbiddenException` (403), `FloorLingoNotFoundException` (404),
`FloorLingoConflictException` (409), `FloorLingoRateLimitException` (429),
`FloorLingoNotImplementedException` (501) — each exposing `getStatus()` and the parsed `getBody()`.
A timeout throws `FloorLingoTimeoutException`.

```php
use FloorLingo\Exceptions\FloorLingoNotFoundException;

try {
    $client->sessions->get('missing');
} catch (FloorLingoNotFoundException $e) {
    echo $e->getStatus();  // 404
}
```

## Notes

- **Use HTTPS in production** — the API key is sent as `X-API-Key` and is bearer-equivalent.
- The SDK does **not** retry, and **never follows redirects** (so the key is never re-sent to
  a redirect target). Path segments are percent-encoded; a base-URL path prefix (e.g. behind a
  reverse proxy) is preserved.
- Escape hatch for endpoints the SDK does not wrap:
  `$client->request($method, $path, $query, $body)`.

## License

MIT

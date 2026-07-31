# floorlingo-sdk

Official JavaScript/TypeScript SDK for the [FloorLingo](https://github.com/JaplinChen/FloorLingo) WhatsApp API Gateway.

Ships dual CJS + ESM builds with bundled type declarations.

## Install

```bash
npm install floorlingo-sdk
```

Requires Node.js >= 18 (relies on the global `fetch`).

## Usage

```typescript
import { FloorLingoClient } from 'floorlingo-sdk';

const client = new FloorLingoClient({
  baseUrl: 'https://your-gateway.example.com',
  apiKey: 'owa_k1_…',
});

await client.sessions.start('my-session');

const result = await client.messages.sendText('my-session', {
  chatId: '628123456789@c.us',
  text: 'Hello from the FloorLingo SDK!',
});
console.log(result.messageId);
```

CommonJS consumers use `require('floorlingo-sdk')` identically.

## Messaging

> Voice notes: pass `ptt: true` to `sendAudio` to send a real WhatsApp voice note (PTT). Supply `audio/ogg; codecs=opus` audio for reliable playback; the server defaults the mimetype to that when `ptt` is set without one.

## Errors

Non-2xx responses throw a typed `FloorLingoApiError` subclass
(`FloorLingoAuthError`, `FloorLingoForbiddenError`, `FloorLingoNotFoundError`,
`FloorLingoConflictError`, `FloorLingoRateLimitError`, `FloorLingoNotImplementedError`),
each carrying `.status` and the parsed `.body`. Timeouts throw
`FloorLingoTimeoutError`. The SDK does **not** retry — wrap calls with your own
backoff if needed.

## License

MIT

# Lucy

Lucy is a DM-only OpenClaw channel plugin that uses NATS subjects scoped by
`apiKey` and a persisted machine `deviceId`.

It supports both:

- raw NATS listeners such as `nats://host:4222` or `tls://host:4443`
- NATS over WebSocket listeners such as `ws://host/nats-ws` or `wss://host/nats-ws`

## Local Docker Flow

1. Build the local image with the Lucy extension dependencies included:

```bash
OPENCLAW_EXTENSIONS=lucy docker build -t openclaw:local -f Dockerfile .
```

2. Start OpenClaw and NATS from the repo root:

```bash
docker compose -f docker-compose.yml -f extensions/lucy/docker-compose.nats.yml up -d
```

3. Enable the plugin and configure Lucy:

```bash
docker compose -f docker-compose.yml -f extensions/lucy/docker-compose.nats.yml run --rm openclaw-cli plugins enable lucy
docker compose -f docker-compose.yml -f extensions/lucy/docker-compose.nats.yml run --rm openclaw-cli config set channels.lucy.enabled true
docker compose -f docker-compose.yml -f extensions/lucy/docker-compose.nats.yml run --rm openclaw-cli config set channels.lucy.apiKey demo_user
docker compose -f docker-compose.yml -f extensions/lucy/docker-compose.nats.yml run --rm openclaw-cli config set channels.lucy.servers '["nats://nats:4222"]' --strict-json
```

4. Read the generated `deviceId` from status output:

```bash
docker compose -f docker-compose.yml -f extensions/lucy/docker-compose.nats.yml run --rm openclaw-cli channels status --probe
```

5. Use the demo client from the repo root:

```bash
bun extensions/lucy/scripts/demo-chat.ts --api-key demo_user --device-id <deviceId>
```

Without `--text`, the demo enters interactive mode. Use `/quit` to exit.

For authenticated WebSocket deployments:

```bash
node_modules/.bin/tsx extensions/lucy/scripts/demo-chat.ts \
  --api-key demo_user \
  --device-id <deviceId> \
  --server wss://example.com/nats-ws \
  --token nats-token-placeholder
```

For one-shot probes, `--text` keeps the client open for `15000ms` by default so
`assistant.final` has time to arrive. Override with `--wait-ms`.

## Remote WSS Flow

For hosted deployments that only expose NATS over WebSocket, configure Lucy
with a `ws://` or `wss://` server and a token-compatible auth method:

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "openai-local/gpt-5.4",
      },
    },
  },
  models: {
    providers: {
      "openai-local": {
        baseUrl: "http://127.0.0.1:8080/v1",
        apiKey: "sk-example-local-openai",
        api: "openai-responses",
        models: [
          {
            id: "gpt-5.4",
            name: "GPT-5.4 (Local OpenAI)",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1000000,
            maxTokens: 32768,
          },
        ],
      },
    },
  },
  plugins: {
    entries: {
      lucy: {
        enabled: true,
      },
    },
  },
  channels: {
    lucy: {
      enabled: true,
      apiKey: "demo_user",
      dmPolicy: "open",
      allowFrom: ["*"],
      servers: ["wss://example.com/nats-ws"],
      token: "nats-token-placeholder",
    },
  },
}
```

Notes:

- If a deployment only exposes `wss://.../nats-ws`, simply changing the URL to
  `nats://...` will not work unless the server also exposes a real raw NATS or
  TLS listener.
- The Lucy plugin runtime now handles NATS-over-WebSocket in Node. This is what
  the gateway uses.
- `scripts/demo-chat.ts` now supports `--token` and `ws://` / `wss://`
  listeners.
- An end-to-end Docker run has been validated with a remote `wss://.../nats-ws`
  listener plus an OpenAI-compatible `openai-responses` provider.

## Notes

- `apiKey` must match `^[A-Za-z0-9_-]+$` because it is used as a NATS subject token.
- v1 logs and status output expose the generated `deviceId`.
- TODO: add optional upstream registration so `apiKey` and `deviceId` can be reported to a dedicated service.

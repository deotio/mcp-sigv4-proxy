# @deotio/mcp-sigv4-proxy

> **Note:** AWS publishes an official proxy for this use case: [`mcp-proxy-for-aws`](https://github.com/aws/mcp-proxy-for-aws). It is mature, feature-rich, and AWS-supported. **Use it unless you specifically need a Node.js solution.** This package exists for teams that don't have (or want) a Python runtime — it provides the same core functionality as a single `npx` command with zero Python dependencies.

A stdio MCP proxy that signs requests with AWS SigV4 using the standard credential chain. Drop it into your `.mcp.json` as a `command` entry to connect Claude Code (or any MCP client) to IAM-authenticated MCP servers — Lambda Function URLs, Bedrock AgentCore, or any SigV4-protected HTTP endpoint — with per-profile auth via `AWS_PROFILE`.

## Quick start

### Lambda Function URL

```json
"my-server": {
  "command": "npx",
  "args": ["-y", "@deotio/mcp-sigv4-proxy"],
  "env": {
    "AWS_PROFILE": "my-profile",
    "AWS_REGION": "us-east-1",
    "AWS_SERVICE": "lambda",
    "MCP_SERVER_URL": "https://<id>.lambda-url.us-east-1.on.aws/mcp"
  }
}
```

### Bedrock AgentCore

```json
"my-server": {
  "command": "npx",
  "args": ["-y", "@deotio/mcp-sigv4-proxy"],
  "env": {
    "AWS_PROFILE": "my-profile",
    "AWS_REGION": "us-east-1",
    "MCP_SERVER_URL": "https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/.../invocations?qualifier=DEFAULT"
  }
}
```

Always set `AWS_REGION` explicitly — the proxy can infer it from standard AWS hostnames, but `AWS_REGION` from your shell environment takes precedence and may point to a different region.

**Important:** `AWS_SERVICE` must be set to `lambda` for Lambda Function URLs. For AgentCore endpoints, it is inferred automatically from the hostname.

## How it works

```
stdin (JSON-RPC) -> validate -> SigV4 sign -> HTTPS POST -> response relay -> stdout
```

1. Reads JSON-RPC messages from stdin (one per line)
2. Validates each message is well-formed JSON-RPC 2.0
3. Signs the request with AWS SigV4 using the configured credentials
4. Forwards to the target MCP endpoint via HTTPS (with configurable timeout and retries)
5. Retries on HTTP 5xx and 424 (AgentCore cold-start timeout) with exponential backoff
6. Relays the response (JSON or SSE stream) back to stdout

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `MCP_SERVER_URL` | yes | — | Full HTTPS URL of the target MCP HTTP endpoint |
| `AWS_PROFILE` | no | SDK default chain | AWS named profile for signing |
| `AWS_REGION` | no | inferred from URL, then `us-east-1` | AWS region for SigV4 signing |
| `AWS_SERVICE` | no | inferred from URL, then `bedrock-agentcore` | SigV4 service name — **set to `lambda` for Lambda Function URLs** |
| `MCP_TIMEOUT` | no | `180` | Request timeout in seconds |
| `MCP_RETRIES` | no | `2` | Retry count for 5xx/424 errors and network failures (0-10) |
| `MCP_LOG_LEVEL` | no | `ERROR` | Log verbosity: `DEBUG`, `INFO`, `WARNING`, `ERROR`, `SILENT` |
| `MCP_WARM` | no | `0` | Set to `1` to enable [warm mode](doc/configuration.md#warm-mode) for slow-starting backends |

## Prerequisites

Your AWS profile needs the appropriate IAM permissions for the target service:

- **Lambda Function URL**: `lambda:InvokeFunctionUrl`
- **Bedrock AgentCore**: `bedrock-agentcore:InvokeAgentRuntime`

## Security

- **HTTPS-only** — `MCP_SERVER_URL` must use `https://`. The only exception is `http://localhost` / `http://127.0.0.1` for local development.
- **TLS enforcement** — the proxy refuses to start if `NODE_TLS_REJECT_UNAUTHORIZED=0` is set, since it sends signed AWS credentials.
- **Input validation** — only well-formed JSON-RPC 2.0 messages are signed and forwarded.
- **Informative errors** — HTTP error responses include the upstream error message (e.g. `HTTP 403: User is not authorized`) in the JSON-RPC error for easier debugging. Full response bodies are logged to stderr.
- **Buffer limits** — SSE streams are capped at 1 MB to prevent unbounded memory growth.

## Documentation

- [Why this package exists](doc/why.md) — the problem, the solution, and comparison with `mcp-proxy-for-aws`
- [Getting started](doc/getting-started.md) — step-by-step setup guide
- [Configuration](doc/configuration.md) — environment variables, credential methods, IAM permissions
- [Troubleshooting](doc/troubleshooting.md) — common errors and debugging tips

## License

Apache-2.0

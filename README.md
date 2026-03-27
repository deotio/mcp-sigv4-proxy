# @deotio/mcp-sigv4-proxy

A stdio MCP proxy that signs requests with AWS SigV4 using the standard credential chain. Drop it into your `.mcp.json` as a `command` entry to connect Claude Code (or any MCP client) to IAM-authenticated MCP servers like AWS Bedrock AgentCore — with per-profile auth via `AWS_PROFILE`.

## Quick start

Add to your `.mcp.json`:

```json
"finops": {
  "command": "npx",
  "args": ["-y", "@deotio/mcp-sigv4-proxy"],
  "env": {
    "AWS_PROFILE": "dot-finops",
    "AWS_REGION": "us-east-1",
    "MCP_SERVER_URL": "https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/.../invocations?qualifier=DEFAULT"
  }
}
```

## How it works

```
stdin (JSON-RPC) -> validate -> SigV4 sign -> HTTPS POST -> response relay -> stdout
```

1. Reads JSON-RPC messages from stdin (one per line)
2. Validates each message is well-formed JSON-RPC 2.0
3. Signs the request with AWS SigV4 using the configured credentials
4. Forwards to the target MCP endpoint via HTTPS
5. Relays the response (JSON or SSE stream) back to stdout

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `MCP_SERVER_URL` | yes | — | Full HTTPS URL of the target MCP HTTP endpoint |
| `AWS_PROFILE` | no | SDK default chain | AWS named profile for signing |
| `AWS_REGION` | no | `us-east-1` | AWS region for SigV4 signing |
| `AWS_SERVICE` | no | `bedrock-agentcore` | SigV4 service name |

## Prerequisites

Your AWS profile needs the appropriate IAM permissions for the target service. For Bedrock AgentCore:

```
bedrock-agentcore:InvokeAgentRuntime
```

## Security

- **HTTPS-only** — `MCP_SERVER_URL` must use `https://`. Other schemes (`http://`, `file://`, `ftp://`) are rejected at startup to prevent SSRF.
- **TLS enforcement** — the proxy refuses to start if `NODE_TLS_REJECT_UNAUTHORIZED=0` is set, since it sends signed AWS credentials.
- **Input validation** — only well-formed JSON-RPC 2.0 messages are signed and forwarded.
- **Sanitized errors** — HTTP error bodies from the upstream are logged to stderr, not forwarded to the MCP client. Only the status code is relayed.
- **Buffer limits** — SSE streams are capped at 1 MB to prevent unbounded memory growth.

## License

Apache-2.0

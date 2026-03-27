# Why mcp-sigv4-proxy exists

## The problem

AWS services like Bedrock AgentCore expose MCP servers over HTTP, protected by IAM authentication via SigV4 request signing. MCP clients like Claude Code support two transport modes for connecting to servers:

- **stdio** — the client spawns a local process and communicates over stdin/stdout
- **http** — the client sends HTTP requests directly to a URL

The `http` transport works for public or token-authenticated endpoints, but it has no built-in support for AWS SigV4 signing. This means you can't point Claude Code at an IAM-protected MCP endpoint and have it "just work" — every request needs to be signed with AWS credentials, a region, and a service name.

Without this proxy, connecting to a SigV4-protected MCP server requires one of:

1. **A custom wrapper script** per project that handles credential resolution and request signing — duplicated across every repo that needs it.
2. **An API Gateway** in front of the MCP server that converts from token auth to IAM auth — adding infrastructure, latency, and cost.
3. **Disabling IAM auth** on the endpoint — defeating the purpose of fine-grained access control.

## The solution

`@deotio/mcp-sigv4-proxy` is a stdio-to-HTTP bridge that sits between the MCP client and the IAM-protected server. The client spawns it as a local `command` process (stdio transport), and the proxy handles SigV4 signing transparently:

```
┌─────────────┐    stdio     ┌──────────────────┐   signed HTTPS   ┌─────────────────┐
│  MCP Client  │ ──────────> │  mcp-sigv4-proxy  │ ──────────────> │  MCP Server      │
│ (Claude Code)│ <────────── │                   │ <────────────── │ (AgentCore, etc) │
└─────────────┘   JSON-RPC   └──────────────────┘    JSON / SSE    └─────────────────┘
```

This gives you:

- **Per-profile auth** — each `.mcp.json` entry can use a different `AWS_PROFILE`, so the same developer machine can connect to dev, staging, and prod with separate IAM identities.
- **Zero custom code** — one `npx` command replaces bespoke signing scripts.
- **Standard credential chain** — uses the same credential resolution as the AWS CLI and SDKs (env vars, config files, SSO, instance profiles).
- **Works with any SigV4 endpoint** — not just AgentCore. Any HTTP service that accepts SigV4-signed requests can be proxied.

## Comparison with `mcp-proxy-for-aws`

AWS publishes an official proxy, [`mcp-proxy-for-aws`](https://github.com/aws/mcp-proxy-for-aws), that solves the same problem. It is a mature, feature-rich project. This package exists as a **Node.js alternative** for teams that don't have (or want) a Python toolchain.

| | `@deotio/mcp-sigv4-proxy` | `mcp-proxy-for-aws` |
|---|---|---|
| Language | TypeScript / Node.js | Python |
| Install | `npx -y @deotio/mcp-sigv4-proxy` | `uvx mcp-proxy-for-aws@latest` |
| Runtime dependency | Node.js (often already present) | Python 3.10+ and `uv` |
| Config style | Environment variables | CLI arguments + env vars |
| Scope | Signing proxy only | Proxy + library for agent frameworks |
| Publisher | Independent (Deotio) | AWS |

### When to use this package

- You're in a **Node.js / TypeScript environment** and don't want Python as a dependency.
- You want a **single `npx` command** with no additional tooling (`uv`, `pip`, `virtualenv`).
- You prefer **environment-variable-only configuration** that fits naturally into `.mcp.json` `env` blocks.

### When to use `mcp-proxy-for-aws` instead

- You need the **library mode** for building agents with LangChain, LlamaIndex, or Strands.
- You want **AWS-official support** and long-term maintenance guarantees.
- You need features like **metadata injection**, **read-only tool filtering**, **configurable retries**, or **granular timeouts** (connect, read, write).
- You already have Python and `uv` installed.

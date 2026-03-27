# Phase 5 — Documentation

## Steps

5.1. Write `README.md`.
5.2. Write `CONTRIBUTING.md` (mirror cdk-grafana-resources structure).
5.3. Write `LICENSE` (Apache-2.0).

## README.md contents

- One-paragraph description
- Quick start (`.mcp.json` example for AgentCore)
- All environment variables table (from [00-overview.md](00-overview.md))
- How it works (text diagram: `stdin -> JSON-RPC validation -> SigV4 sign -> HTTPS POST -> response relay -> stdout`)
- Security notes: HTTPS-only, input validation, sanitized errors
- AWS profile setup prerequisite (`bedrock-agentcore:InvokeAgentRuntime`)
- Contributing link

## CONTRIBUTING.md contents

Mirror cdk-grafana-resources structure:
- Prerequisites (Node 20+, npm)
- `npm ci && npm run build && npm test`
- Release process (tag-triggered via CI)

## LICENSE

Apache-2.0.

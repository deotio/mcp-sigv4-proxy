# Plan: @deotio/mcp-sigv4-proxy

_Created: 2026-03-27_
_Reference: `/Users/rmyers/repos/dot/cdk-grafana-resources`_

## Goal

Publish a standalone CLI package that acts as a stdio MCP proxy, signing each request to any SigV4-protected HTTP MCP endpoint using standard AWS credential chain. Developers drop it into `.mcp.json` as a `command` entry with `AWS_PROFILE` in `env`, gaining per-profile auth without any custom scripting.

## Usage (the end state)

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

## Plan files

| File | Contents |
|---|---|
| [00-overview.md](00-overview.md) | This file — goal, usage, structure |
| [01-scaffolding.md](01-scaffolding.md) | package.json, tsconfig, lint, test config |
| [02-implementation.md](02-implementation.md) | src/index.ts proxy logic with security hardening |
| [03-testing.md](03-testing.md) | Test plan and test cases |
| [04-ci-release.md](04-ci-release.md) | GitHub Actions, dependabot, npm publishing |
| [05-documentation.md](05-documentation.md) | README, CONTRIBUTING, LICENSE |
| [06-rollout.md](06-rollout.md) | npm setup, branch protection, consumer migration |
| [07-improvements.md](07-improvements.md) | Future improvements from aws/mcp-proxy-for-aws analysis |
| [CHECKLIST.md](CHECKLIST.md) | Implementation checklist with all tasks |

## Repository Structure

```
mcp-sigv4-proxy/
├── .github/
│   ├── workflows/
│   │   ├── ci.yml
│   │   ├── release.yml
│   │   └── dependabot-auto-merge.yml
│   └── dependabot.yml
├── src/
│   └── index.ts
├── test/
│   └── index.test.ts
├── dist/                           # gitignored
├── plans/
│   ├── 00-overview.md
│   ├── 01-scaffolding.md
│   ├── 02-implementation.md
│   ├── 03-testing.md
│   ├── 04-ci-release.md
│   ├── 05-documentation.md
│   └── 06-rollout.md
├── .eslintrc.json
├── .gitignore
├── .prettierrc
├── CONTRIBUTING.md
├── LICENSE                         # Apache-2.0
├── README.md
├── jest.config.js
├── package.json
└── tsconfig.json
```

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `MCP_SERVER_URL` | yes | — | Full HTTPS URL of the target MCP HTTP endpoint |
| `AWS_PROFILE` | no* | SDK default chain | AWS named profile for signing |
| `AWS_REGION` | no | `us-east-1` | AWS region for SigV4 signing |
| `AWS_SERVICE` | no | `bedrock-agentcore` | SigV4 service name |

*`AWS_PROFILE` is optional at the env-var level but is the whole reason to use this proxy over `type: http`.

## Resolved Questions

- **`Sha256` import**: List `@aws-crypto/sha256-js` as an explicit dependency. Do not rely on transitive availability — it can break silently on version bumps.
- **`npx -y` caching**: `npx -y` downloads and caches the package on first use. No extra install step needed.
- **SigV4 service name**: `bedrock-agentcore` is assumed from the hostname and IAM action. Making it configurable via `AWS_SERVICE` handles edge cases.
- **Default branch**: Use `main` (not `master`) consistently across CI triggers and branch protection.

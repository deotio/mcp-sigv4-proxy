# Getting started

## Prerequisites

- **Node.js 20+** — required for the proxy runtime. Check with `node --version`.
- **An AWS profile** — configured via `~/.aws/config` and `~/.aws/credentials`, or via AWS SSO. The profile must have IAM permissions for the target service.
- **An MCP server URL** — the full HTTPS endpoint of the SigV4-protected MCP server you want to connect to.

No installation step is needed — `npx` downloads and caches the package on first use.

## Step 1: Verify your AWS profile

Make sure you can authenticate with the profile you intend to use:

```bash
# For static credentials or SSO
aws sts get-caller-identity --profile your-profile-name
```

If using AWS SSO, log in first:

```bash
aws sso login --profile your-profile-name
```

## Step 2: Find your MCP server URL

The URL depends on the service hosting your MCP server. For Bedrock AgentCore, it typically looks like:

```
https://bedrock-agentcore.<region>.amazonaws.com/runtimes/<runtime-id>/invocations?qualifier=DEFAULT
```

You can find it in the AgentCore console or via the AWS CLI:

```bash
aws bedrock-agentcore list-runtimes --profile your-profile-name
```

## Step 3: Add to your MCP configuration

Add an entry to your `.mcp.json` file (in your project root or `~/.mcp.json` for global config):

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "@deotio/mcp-sigv4-proxy"],
      "env": {
        "AWS_PROFILE": "your-profile-name",
        "AWS_REGION": "us-east-1",
        "MCP_SERVER_URL": "https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/your-runtime-id/invocations?qualifier=DEFAULT"
      }
    }
  }
}
```

Always set `AWS_REGION` explicitly — the proxy can infer it from the URL, but your shell's `AWS_REGION` takes precedence and may point to a different region. `AWS_SERVICE` is inferred automatically.

## Step 4: Test the connection

Start your MCP client (e.g. Claude Code). The proxy will be spawned automatically when the client connects to the `my-server` entry. You should see the server's tools and resources available in the client.

If something goes wrong, the proxy writes diagnostic messages to stderr. In Claude Code, check the MCP server logs for output like:

```
mcp-sigv4-proxy: MCP_SERVER_URL is required
mcp-sigv4-proxy: MCP_SERVER_URL must use https:// (got http:)
mcp-sigv4-proxy: HTTP 403: ...
mcp-sigv4-proxy: request failed: ...
```

## Slow-starting backends (AgentCore cold starts)

If your MCP server is hosted on a serverless platform like AWS Bedrock AgentCore Runtime, the first connection may time out because the container takes time to cold-start. Enable warm mode to solve this:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "@deotio/mcp-sigv4-proxy"],
      "env": {
        "MCP_WARM": "1",
        "AWS_PROFILE": "your-profile-name",
        "AWS_REGION": "us-east-1",
        "MCP_SERVER_URL": "https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/your-runtime-id/invocations?qualifier=DEFAULT"
      }
    }
  }
}
```

With `MCP_WARM=1`, the proxy warms the backend in the background at startup and responds to the MCP client instantly from cache. See [Configuration — Warm mode](configuration.md#warm-mode) for details.

## Multiple servers with different profiles

A common use case is connecting to the same MCP server across multiple AWS accounts or environments. Each gets its own `.mcp.json` entry with a different profile:

```json
{
  "mcpServers": {
    "finops-dev": {
      "command": "npx",
      "args": ["-y", "@deotio/mcp-sigv4-proxy"],
      "env": {
        "AWS_PROFILE": "dev-account",
        "AWS_REGION": "us-east-1",
        "MCP_SERVER_URL": "https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/dev-runtime/invocations?qualifier=DEFAULT"
      }
    },
    "finops-prod": {
      "command": "npx",
      "args": ["-y", "@deotio/mcp-sigv4-proxy"],
      "env": {
        "AWS_PROFILE": "prod-account",
        "AWS_REGION": "us-east-1",
        "MCP_SERVER_URL": "https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/prod-runtime/invocations?qualifier=DEFAULT"
      }
    }
  }
}
```

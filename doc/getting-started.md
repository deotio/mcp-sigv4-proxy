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

The URL depends on the service hosting your MCP server.

### Lambda Function URL

Get the URL from the Lambda console, CloudFormation outputs, or the AWS CLI:

```bash
aws lambda get-function-url-config --function-name your-function-name --profile your-profile-name
```

The URL looks like:

```
https://<id>.lambda-url.<region>.on.aws/
```

Append the MCP path (typically `/mcp`) to get the full endpoint:

```
https://<id>.lambda-url.us-east-1.on.aws/mcp
```

### Bedrock AgentCore

Get the runtime ID from the AgentCore console or via the AWS CLI:

```bash
aws bedrock-agentcore list-runtimes --profile your-profile-name
```

Take `agentRuntimeId` from the output and insert it into the URL:

```
https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/<runtime-id>/invocations?qualifier=DEFAULT
```

**`?qualifier=DEFAULT`** selects the active deployment of the runtime. `DEFAULT` is the standard alias; you would only use a different value if you've created a named alias pointing at a specific version.

## Step 3: Add to your MCP configuration

Add an entry to your `.mcp.json` file (in your project root or `~/.mcp.json` for global config):

**Lambda Function URL:**

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "@deotio/mcp-sigv4-proxy"],
      "env": {
        "AWS_PROFILE": "your-profile-name",
        "AWS_REGION": "us-east-1",
        "AWS_SERVICE": "lambda",
        "MCP_SERVER_URL": "https://<id>.lambda-url.us-east-1.on.aws/mcp"
      }
    }
  }
}
```

**Bedrock AgentCore:**

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

Always set `AWS_REGION` explicitly — the proxy can infer it from the URL, but your shell's `AWS_REGION` takes precedence and may point to a different region.

**Important:** `AWS_SERVICE` must be set to `lambda` for Lambda Function URLs. For AgentCore, the service is inferred automatically from the hostname.

## Step 4: Test the connection

Start your MCP client (e.g. Claude Code). The proxy will be spawned automatically when the client connects to the `my-server` entry. You should see the server's tools and resources available in the client.

If something goes wrong, the proxy writes diagnostic messages to stderr. In Claude Code, check the MCP server logs for output like:

```
mcp-sigv4-proxy: MCP_SERVER_URL is required
mcp-sigv4-proxy: MCP_SERVER_URL must use https:// (got http:)
mcp-sigv4-proxy: HTTP 403: ...
mcp-sigv4-proxy: request failed: ...
```

## Slow-starting backends

If your MCP server has slow cold starts (e.g. Bedrock AgentCore Runtime containers can take 60–130 seconds), the MCP client may time out before the backend is ready. Enable warm mode to solve this:

```json
"env": {
  "MCP_WARM": "1",
  ...
}
```

With `MCP_WARM=1`, the proxy warms the backend in the background at startup and responds to the MCP client instantly from cache. See [Configuration — Warm mode](configuration.md#warm-mode) for details.

**Note:** Lambda Function URLs have 2–5 second cold starts and do not need warm mode.

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
        "AWS_SERVICE": "lambda",
        "MCP_SERVER_URL": "https://<dev-id>.lambda-url.us-east-1.on.aws/mcp"
      }
    },
    "finops-prod": {
      "command": "npx",
      "args": ["-y", "@deotio/mcp-sigv4-proxy"],
      "env": {
        "AWS_PROFILE": "prod-account",
        "AWS_REGION": "us-east-1",
        "AWS_SERVICE": "lambda",
        "MCP_SERVER_URL": "https://<prod-id>.lambda-url.us-east-1.on.aws/mcp"
      }
    }
  }
}
```

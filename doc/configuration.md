# Configuration

The proxy is configured entirely through environment variables, set in the `env` block of your `.mcp.json` entry.

## Environment variables

### `MCP_SERVER_URL` (required)

The full HTTPS URL of the target MCP server endpoint. Must use the `https://` scheme.

```json
"MCP_SERVER_URL": "https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/abc123/invocations?qualifier=DEFAULT"
```

**`?qualifier=DEFAULT`** selects the active deployment of the runtime. `DEFAULT` is the standard alias; you would only use a different value if you've created a named alias pointing at a specific version.

The proxy validates this at startup and refuses to start if:
- The variable is missing or empty
- The URL uses a non-HTTPS scheme (`file://`, `ftp://`, etc.)

The one exception is `http://localhost`, `http://127.0.0.1`, and `http://[::1]`, which are allowed for local development and testing.

### `AWS_PROFILE` (optional)

The named AWS profile to use for credential resolution. This is read by the AWS SDK's standard credential provider chain.

```json
"AWS_PROFILE": "my-profile"
```

If omitted, the SDK falls back to its default credential resolution order:
1. Environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`)
2. Shared credentials file (`~/.aws/credentials`)
3. SSO credentials
4. EC2 instance metadata / ECS task role
5. etc.

In practice, you almost always want to set this — it's the main reason to use this proxy over a direct HTTP transport.

### `AWS_REGION` (recommended)

The AWS region used in the SigV4 signing process. Must match the region of the target service endpoint.

```json
"AWS_REGION": "us-east-1"
```

The proxy can infer the region from standard AWS endpoint hostnames:
- `bedrock-agentcore.us-east-1.amazonaws.com` -> `us-east-1`
- `service.eu-west-1.api.aws` -> `eu-west-1`

However, **always set `AWS_REGION` explicitly** in your `.mcp.json` `env` block. MCP clients typically inherit the parent shell's environment, so if your shell has `AWS_REGION=eu-central-1` (e.g. for a different project), that value will override the inference and cause a "Credential should be scoped to a valid region" error. Setting it explicitly in `env` prevents this.

If neither the env var nor inference produces a value, the default is `us-east-1`.

### `AWS_SERVICE` (optional, usually auto-detected)

The AWS service name used in the SigV4 signing process. This determines the signing scope and must match what the target service expects.

```json
"AWS_SERVICE": "bedrock-agentcore"
```

Like `AWS_REGION`, the proxy infers this from the hostname:
- `bedrock-agentcore.us-east-1.amazonaws.com` -> `bedrock-agentcore`

The default fallback is `bedrock-agentcore` when inference produces no result.

**Lambda Function URLs require explicit `AWS_SERVICE=lambda`.** The `*.lambda-url.*.on.aws` hostname is not recognized by the inference logic, so the proxy falls back to `bedrock-agentcore` and every request returns HTTP 403 with "Credential should be scoped to correct service: 'lambda'". Always set this explicitly for Lambda:

```json
"AWS_SERVICE": "lambda"
```

### `MCP_TIMEOUT` (optional, default: `180`)

Request timeout in seconds. Applies to each individual HTTP request (including retries). If a request takes longer than this, it is aborted and a JSON-RPC error is returned to the client.

```json
"MCP_TIMEOUT": "60"
```

### `MCP_RETRIES` (optional, default: `2`)

Number of retries for failed requests (0-10). Retries are triggered by:
- HTTP 5xx server errors — exponential backoff (1s, 2s, 4s, ...)
- HTTP 424 (AgentCore cold-start timeout) — longer backoff (5s, 10s, 20s, ...) to allow the container to finish starting
- Network failures (connection refused, DNS errors) — exponential backoff (1s, 2s, 4s, ...)
- Timeouts

```json
"MCP_RETRIES": "3"
```

### `MCP_LOG_LEVEL` (optional, default: `ERROR`)

Controls the verbosity of diagnostic output on stderr. Available levels:

| Level | Output |
|---|---|
| `SILENT` | Nothing |
| `ERROR` | HTTP errors, network failures, buffer overflows |
| `WARNING` | Retries, dropped non-JSON data, invalid input |
| `INFO` | Startup config, shutdown messages |
| `DEBUG` | Request details, URL inference, timing |

```json
"MCP_LOG_LEVEL": "INFO"
```

Note: Some MCP clients (e.g. Cline) scan stderr for the word "error" and misinterpret log messages as failures. The default `ERROR` level minimizes this risk. Use `SILENT` if you encounter false positives.

## Warm mode

Warm mode pre-warms slow-starting backends (like AWS Bedrock AgentCore Runtime) in the background so that the MCP client connects instantly instead of timing out during a cold start.

When enabled, the proxy:

1. **On startup**, immediately sends an MCP `initialize` request to the backend, retrying through HTTP 424 (cold-start timeout) errors with exponential backoff
2. **After the backend responds**, prefetches `tools/list`, `resources/list`, and `prompts/list` and caches the responses
3. **When the MCP client sends `initialize`**, responds instantly from cache (or with a synthetic response if the backend hasn't responded yet)
4. **When the MCP client sends `tools/list` etc.**, responds instantly from cache
5. **For all other requests** (`tools/call`, etc.), forwards to the backend normally — by this point, the backend is warm

This means the MCP client sees the server as connected with tools listed in under a second, even if the backend takes minutes to cold-start.

### Enabling warm mode

```json
"env": {
  "MCP_WARM": "1",
  "MCP_SERVER_URL": "https://bedrock-agentcore...",
  "AWS_PROFILE": "my-profile",
  "AWS_REGION": "us-east-1"
}
```

To disable: remove `MCP_WARM` or set it to `0`.

### Warm mode environment variables

| Variable | Default | Description |
|---|---|---|
| `MCP_WARM` | `0` | Set to `1` to enable warm mode |
| `MCP_WARM_RETRIES` | `5` | Max retries for the background warm-up `initialize` request (0-20) |
| `MCP_WARM_RETRY_DELAY` | `10000` | Base delay in milliseconds between warm-up retries (minimum 1000). Doubles on each retry. |
| `MCP_WARM_TIMEOUT` | `300000` | Overall deadline in milliseconds for the warm-up process. If exceeded, warm mode is disabled and the proxy falls back to pass-through. |

### Limitation: stateless servers only

Warm mode is only compatible with **stateless** MCP servers — servers that do not use session IDs (i.e., configured with `sessionIdGenerator: undefined` in the MCP SDK).

If the backend returns an `mcp-session-id` header during the warm-up `initialize` request, warm mode is **automatically disabled** and the proxy falls back to standard pass-through behavior. A warning is logged:

```
mcp-sigv4-proxy: warm: backend returned mcp-session-id header — stateful servers are not compatible with warm mode. Falling back to pass-through mode.
```

**How to tell if your server is stateful:** Check the `StreamableHTTPServerTransport` configuration in your server code. If `sessionIdGenerator` is `undefined` or absent, the server is stateless and warm mode is safe. Most MCP servers, including all AgentCore-hosted servers in this project, are stateless.

**What happens on fallback:** The proxy behaves identically to `MCP_WARM=0` — cold-start delays apply, but correctness is preserved. Check proxy logs (`MCP_LOG_LEVEL=INFO`) for the fallback warning.

### Cache behavior

The capability cache (`initialize`, `tools/list`, `resources/list`, `prompts/list`) lives for the lifetime of the proxy process, which matches the MCP client session lifetime. Since tool definitions only change on server redeploy — and a redeploy creates a new container (new cold start, new proxy process) — the cache is always fresh for the current server version. No TTL or manual invalidation is needed.

If the MCP client requests `tools/list` a second time (e.g., after a `notifications/tools/list_changed` event), the proxy forwards the request to the backend and updates the cache.

## AWS credential methods

The proxy delegates credential resolution to `@aws-sdk/credential-providers`, which supports all standard AWS credential methods:

### Static credentials (not recommended for production)

```json
"env": {
  "AWS_ACCESS_KEY_ID": "AKIA...",
  "AWS_SECRET_ACCESS_KEY": "...",
  "MCP_SERVER_URL": "https://..."
}
```

### Named profile with SSO

```json
"env": {
  "AWS_PROFILE": "my-sso-profile",
  "MCP_SERVER_URL": "https://..."
}
```

Requires that you've run `aws sso login --profile my-sso-profile` beforehand. SSO tokens are cached and reused across sessions until they expire.

### Named profile with static credentials

```json
"env": {
  "AWS_PROFILE": "my-static-profile",
  "MCP_SERVER_URL": "https://..."
}
```

Where `~/.aws/credentials` contains:

```ini
[my-static-profile]
aws_access_key_id = AKIA...
aws_secret_access_key = ...
```

### Assumed role via profile

```json
"env": {
  "AWS_PROFILE": "my-assumed-role",
  "MCP_SERVER_URL": "https://..."
}
```

Where `~/.aws/config` contains:

```ini
[profile my-assumed-role]
role_arn = arn:aws:iam::123456789012:role/MyRole
source_profile = my-base-profile
```

The SDK handles the `AssumeRole` call and temporary credential refresh automatically.

## IAM permissions

The IAM principal (user or role) associated with your credentials needs permission to call the target service.

### Lambda Function URL

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "lambda:InvokeFunctionUrl",
      "Resource": "arn:aws:lambda:us-east-1:123456789012:function:your-function-name",
      "Condition": {
        "StringEquals": { "lambda:FunctionUrlAuthType": "AWS_IAM" }
      }
    }
  ]
}
```

Also set `AWS_SERVICE=lambda` — see the `AWS_SERVICE` section above.

### Bedrock AgentCore

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "bedrock-agentcore:InvokeAgentRuntime",
      "Resource": "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/your-runtime-id"
    }
  ]
}
```

A `403 Forbidden` response from the upstream service typically means the IAM principal lacks the required permission or the resource ARN doesn't match.

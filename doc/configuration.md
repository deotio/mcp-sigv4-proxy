# Configuration

The proxy is configured entirely through environment variables, set in the `env` block of your `.mcp.json` entry.

## Environment variables

### `MCP_SERVER_URL` (required)

The full HTTPS URL of the target MCP server endpoint. Must use the `https://` scheme.

```json
"MCP_SERVER_URL": "https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/abc123/invocations?qualifier=DEFAULT"
```

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

### `AWS_REGION` (optional, usually auto-detected)

The AWS region used in the SigV4 signing process. Must match the region of the target service endpoint.

```json
"AWS_REGION": "eu-west-1"
```

The proxy infers the region from standard AWS endpoint hostnames automatically:
- `bedrock-agentcore.us-east-1.amazonaws.com` -> `us-east-1`
- `service.eu-west-1.api.aws` -> `eu-west-1`

You only need to set this if the hostname doesn't follow a standard pattern. If neither the env var nor inference produces a value, the default is `us-east-1`.

### `AWS_SERVICE` (optional, usually auto-detected)

The AWS service name used in the SigV4 signing process. This determines the signing scope and must match what the target service expects.

```json
"AWS_SERVICE": "bedrock-agentcore"
```

Like `AWS_REGION`, the proxy infers this from the hostname:
- `bedrock-agentcore.us-east-1.amazonaws.com` -> `bedrock-agentcore`

You only need to set this for non-standard endpoints. Default fallback is `bedrock-agentcore`.

### `MCP_TIMEOUT` (optional, default: `180`)

Request timeout in seconds. Applies to each individual HTTP request (including retries). If a request takes longer than this, it is aborted and a JSON-RPC error is returned to the client.

```json
"MCP_TIMEOUT": "60"
```

### `MCP_RETRIES` (optional, default: `0`)

Number of retries for failed requests (0-10). Retries use exponential backoff (1s, 2s, 4s, ...) and are triggered by:
- HTTP 5xx server errors
- Network failures (connection refused, DNS errors)
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

The IAM principal (user or role) associated with your credentials needs permission to call the target service. For Bedrock AgentCore:

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

# Improvements from `mcp-proxy-for-aws` analysis

Insights from reviewing [aws/mcp-proxy-for-aws](https://github.com/aws/mcp-proxy-for-aws) source code. These are features worth considering for future versions.

## High value

### 1. Infer service name and region from endpoint URL

The AWS proxy parses the endpoint hostname to auto-detect service and region:
- `bedrock-agentcore.us-east-1.amazonaws.com` -> service=`bedrock-agentcore`, region=`us-east-1`
- `service.region.api.aws` -> extracted from hostname segments

This eliminates the need to set `AWS_REGION` and `AWS_SERVICE` for standard AWS endpoints. Fall back to env vars only when inference fails.

**Env**: `MCP_SERVER_URL=https://bedrock-agentcore.us-east-1.amazonaws.com/...` would auto-detect both, no `AWS_REGION` or `AWS_SERVICE` needed.

### 2. Configurable request timeout

The AWS proxy supports `--timeout` (180s default), `--connect-timeout` (60s), `--read-timeout` (120s), and `--write-timeout` (180s). Our proxy uses Node's default `fetch` timeout which is effectively unlimited — a hanging upstream will block the sequential queue forever.

**Env**: `MCP_TIMEOUT=180` (seconds, applied to fetch).

### 3. Configurable retries with backoff

The AWS proxy supports `--retries` (0-10, default 0). Transient 5xx errors or network blips currently cause a hard failure. A simple retry with exponential backoff would improve resilience.

**Env**: `MCP_RETRIES=3` (default 0).

### 4. Log level control

The AWS proxy supports `--log-level` (DEBUG/INFO/WARNING/ERROR/CRITICAL). Our proxy writes all diagnostics to stderr unconditionally. A log level would reduce noise in production and enable verbose debugging when needed.

**Env**: `MCP_LOG_LEVEL=ERROR` (default, only errors to stderr).

Note: The AWS proxy warns that Cline checks stderr for "error" (case-insensitive) and misinterprets log messages as failures. Our log level should default to ERROR to avoid this.

## Medium value

### 5. Allow HTTP for localhost

The AWS proxy allows `http://localhost`, `http://127.0.0.1`, and `http://[::1]` for local development. Our proxy rejects all non-HTTPS URLs. Allowing localhost HTTP would be useful for testing against local MCP servers.

### 6. Sensitive header redaction in logs

The AWS proxy redacts `Authorization`, `X-Amz-Security-Token`, and `X-Amz-Date` headers when logging. We should do the same if we ever log request headers (currently we don't, but would matter if DEBUG logging is added).

### 7. Metadata injection

The AWS proxy supports `--metadata KEY=VALUE` which injects key-value pairs into the `_meta` field of JSON-RPC `params`. This is used by AgentCore for routing and context. Consider supporting `MCP_METADATA=KEY1=value1,KEY2=value2`.

## Low value (not planned)

### 8. Read-only tool filtering

The AWS proxy supports `--read-only` to filter out tools without `readOnlyHint=true`. This is useful but adds protocol awareness beyond simple proxying. Skip for now — keep the proxy simple.

### 9. Library mode

The AWS proxy doubles as a Python library for agent frameworks. Not relevant to our scope (CLI-only).

## Implementation priority

If adding features in a future release, the suggested order is:

1. **Infer service/region from URL** — reduces config friction, no breaking changes
2. **Request timeout** — prevents the sequential queue from blocking indefinitely
3. **Log level** — reduces stderr noise, avoids Cline false positives
4. **Retries** — improves resilience for transient failures
5. **Localhost HTTP** — convenience for local development

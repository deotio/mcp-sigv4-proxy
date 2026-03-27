# Troubleshooting

The proxy writes diagnostic output to stderr, controlled by `MCP_LOG_LEVEL` (default: `ERROR`). Set it to `DEBUG` or `INFO` for more detail. In Claude Code, check the MCP server logs panel to see these messages.

## Startup errors

### `mcp-sigv4-proxy: MCP_SERVER_URL is required`

The `MCP_SERVER_URL` environment variable is missing or empty. Make sure it's set in the `env` block of your `.mcp.json` entry.

### `mcp-sigv4-proxy: MCP_SERVER_URL must use https:// (got http:)`

The URL must use HTTPS. The proxy refuses to sign requests over unencrypted connections because it would expose AWS credentials in transit. Change the URL scheme to `https://`.

The one exception is localhost (`http://localhost`, `http://127.0.0.1`, `http://[::1]`), which is allowed for local development.

### `mcp-sigv4-proxy: NODE_TLS_REJECT_UNAUTHORIZED=0 is not allowed`

Something in your environment has set `NODE_TLS_REJECT_UNAUTHORIZED=0`, which disables TLS certificate verification. The proxy rejects this because it sends signed AWS credentials and needs verified TLS to prevent credential interception. Remove this environment variable.

## Authentication errors

### `mcp-sigv4-proxy: HTTP 403: {"message":"Credential should be scoped to a valid region."}`

The SigV4 signing region doesn't match what the service expects. This usually happens when `AWS_REGION` from your shell environment (e.g. `eu-central-1` for a different project) leaks into the proxy and overrides the region inferred from the URL.

**Fix:** Always set `AWS_REGION` explicitly in your `.mcp.json` `env` block to match the endpoint's region:

```json
"env": {
  "AWS_REGION": "us-east-1",
  "MCP_SERVER_URL": "https://bedrock-agentcore.us-east-1.amazonaws.com/..."
}
```

### `mcp-sigv4-proxy: HTTP 403: {"message":"The request signature we calculated does not match..."}`

The request was signed but the signature doesn't match what the server computed. This was caused by a bug in versions prior to 0.2.1 where the URL query string (e.g. `?qualifier=DEFAULT`) was included in the path component during signing instead of being passed as a separate query parameter. **Upgrade to 0.2.1+** to fix this.

If you're already on 0.2.1+ and still see this error:

- **Clock skew** — SigV4 signatures include a timestamp. If your system clock is off by more than 5 minutes, requests will be rejected. Check with `date` and sync if needed.
- **Wrong service name** — `AWS_SERVICE` doesn't match what the endpoint expects. Try `bedrock-agentcore` (the default) or `bedrock`.

### `mcp-sigv4-proxy: HTTP 403: ...` (other 403 errors)

The request was signed and delivered, but the target service rejected it. Common causes:

- **Wrong IAM permissions** — the principal doesn't have the required action (e.g. `bedrock-agentcore:InvokeAgentRuntime`). Check the IAM policy attached to the user or role.
- **Wrong region** — `AWS_REGION` doesn't match the endpoint's region. See the "Credential should be scoped to a valid region" entry above.
- **Wrong service name** — `AWS_SERVICE` doesn't match what the endpoint expects. Try `bedrock-agentcore` (the default) or `bedrock`.
- **Expired credentials** — if using SSO, re-run `aws sso login --profile your-profile`. If using static credentials, verify they haven't been rotated.
- **Clock skew** — SigV4 signatures include a timestamp. If your system clock is off by more than 5 minutes, requests will be rejected. Check with `date` and sync if needed.

### `mcp-sigv4-proxy: request failed: TypeError: fetch failed`

The proxy couldn't establish a TCP/TLS connection to the target URL. Common causes:

- **Wrong URL** — double-check the hostname and port in `MCP_SERVER_URL`.
- **DNS resolution failure** — the hostname doesn't resolve. Try `nslookup <hostname>`.
- **Network connectivity** — firewalls, VPN, or security groups may be blocking the connection.
- **TLS certificate issue** — the target's certificate is invalid or issued by an untrusted CA. The proxy does not allow disabling TLS verification.

### `mcp-sigv4-proxy: HTTP 404: ...`

The URL path or query parameters are incorrect. For Bedrock AgentCore, verify the runtime ID and qualifier in the URL.

## Runtime errors

### `mcp-sigv4-proxy: ignoring non-JSON input line`

The proxy received a line on stdin that isn't valid JSON. This is normal during some MCP client initialization sequences and can usually be ignored. If it happens for every message, there may be a protocol mismatch.

### `mcp-sigv4-proxy: ignoring non-JSON-RPC message`

The proxy received valid JSON but it's not a JSON-RPC 2.0 message (missing `"jsonrpc": "2.0"` field). Only JSON-RPC 2.0 messages are signed and forwarded.

### `mcp-sigv4-proxy: dropping non-JSON SSE data: ...`

The upstream server sent an SSE `data:` line that isn't valid JSON. The proxy drops these to prevent injecting malformed data into the MCP client. The first 100 characters of the dropped data are logged.

### `mcp-sigv4-proxy: dropping non-JSON response body: ...`

The upstream returned a 200 response with a non-JSON body. This might indicate the URL is pointing at a non-MCP endpoint (e.g. a health check page).

### `mcp-sigv4-proxy: SSE buffer exceeded 1 MB limit, aborting stream`

A streaming response accumulated more than 1 MB of data without a newline character. The proxy aborts the stream to prevent unbounded memory growth and sends a JSON-RPC error to the client. This is a safety limit and shouldn't occur with well-behaved MCP servers.

### `mcp-sigv4-proxy: Request timed out`

The upstream server didn't respond within the configured timeout (default: 180 seconds). Possible causes:
- The server is overloaded or unresponsive
- Network latency is high
- The timeout is too short for your use case

Increase the timeout with `MCP_TIMEOUT` (in seconds) or add retries with `MCP_RETRIES`.

### `mcp-sigv4-proxy: HTTP 500, retrying (1/3)`

The upstream returned a server error and the proxy is retrying. Configure retry count with `MCP_RETRIES` (0-10, default 0). Retries use exponential backoff.

## Debugging tips

1. **Test credentials independently** — verify your profile works with the AWS CLI before involving the proxy:
   ```bash
   aws sts get-caller-identity --profile your-profile
   ```

2. **Test the endpoint independently** — use `awscurl` or a similar tool to make a signed request directly:
   ```bash
   awscurl --profile your-profile --region us-east-1 --service bedrock-agentcore \
     -X POST -d '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{"capabilities":{}}}' \
     "https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/.../invocations?qualifier=DEFAULT"
   ```

3. **Run the proxy manually** — spawn it outside of an MCP client to see stderr output directly:
   ```bash
   echo '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{"capabilities":{}}}' | \
     MCP_SERVER_URL="https://..." AWS_PROFILE=your-profile npx @deotio/mcp-sigv4-proxy
   ```

4. **Check the process is spawning** — if the MCP client shows no server at all, the proxy may not be starting. Verify `npx @deotio/mcp-sigv4-proxy` runs without errors when executed manually.

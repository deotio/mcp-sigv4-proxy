import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { SignatureV4 } from '@smithy/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';
import { Sha256 } from '@aws-crypto/sha256-js';
import readline from 'readline';

export const MAX_SSE_BUFFER_BYTES = 1_048_576; // 1 MB

export interface ProxyConfig {
  url: URL;
  region: string;
  service: string;
}

export function validateEnv(): ProxyConfig {
  if (!process.env.MCP_SERVER_URL) {
    process.stderr.write('mcp-sigv4-proxy: MCP_SERVER_URL is required\n');
    process.exit(1);
  }

  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    process.stderr.write(
      'mcp-sigv4-proxy: NODE_TLS_REJECT_UNAUTHORIZED=0 is not allowed — ' +
        'this proxy sends signed AWS credentials and requires verified TLS\n',
    );
    process.exit(1);
  }

  const url = new URL(process.env.MCP_SERVER_URL);
  if (url.protocol !== 'https:') {
    process.stderr.write(
      `mcp-sigv4-proxy: MCP_SERVER_URL must use https:// (got ${url.protocol})\n`,
    );
    process.exit(1);
  }

  return {
    url,
    region: process.env.AWS_REGION ?? 'us-east-1',
    service: process.env.AWS_SERVICE ?? 'bedrock-agentcore',
  };
}

export function createSigner(config: ProxyConfig): SignatureV4 {
  return new SignatureV4({
    credentials: fromNodeProviderChain(),
    region: config.region,
    service: config.service,
    sha256: Sha256,
  });
}

export function parseInputLine(line: string): { body: string; requestId: unknown } | null {
  const body = line.trim();
  if (!body) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    process.stderr.write('mcp-sigv4-proxy: ignoring non-JSON input line\n');
    return null;
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as Record<string, unknown>).jsonrpc !== '2.0'
  ) {
    process.stderr.write('mcp-sigv4-proxy: ignoring non-JSON-RPC message\n');
    return null;
  }

  const requestId = (parsed as Record<string, unknown>).id ?? null;
  return { body, requestId };
}

export function buildHttpRequest(url: URL, body: string): HttpRequest {
  return new HttpRequest({
    method: 'POST',
    hostname: url.hostname,
    path: url.pathname + url.search,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body)),
      host: url.hostname,
    },
    body,
  });
}

export async function handleResponse(response: Response, requestId: unknown): Promise<void> {
  if (!response.ok) {
    const text = await response.text();
    process.stderr.write(`mcp-sigv4-proxy: HTTP ${response.status}: ${text}\n`);
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: requestId,
        error: { code: -32000, message: `HTTP ${response.status}` },
      }) + '\n',
    );
    return;
  }

  const ct = response.headers.get('content-type') ?? '';

  if (ct.includes('text/event-stream')) {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      if (Buffer.byteLength(buffer) > MAX_SSE_BUFFER_BYTES) {
        process.stderr.write('mcp-sigv4-proxy: SSE buffer exceeded 1 MB limit, aborting stream\n');
        reader.cancel();
        process.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: requestId,
            error: { code: -32000, message: 'SSE stream exceeded buffer limit' },
          }) + '\n',
        );
        break;
      }

      const lines = buffer.split('\n');
      buffer = lines.pop()!;

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          try {
            JSON.parse(data);
            process.stdout.write(data + '\n');
          } catch {
            process.stderr.write(
              `mcp-sigv4-proxy: dropping non-JSON SSE data: ${data.slice(0, 100)}\n`,
            );
          }
        }
      }
    }
  } else {
    const text = await response.text();
    const trimmed = text.trim();
    try {
      JSON.parse(trimmed);
      process.stdout.write(trimmed + '\n');
    } catch {
      process.stderr.write(
        `mcp-sigv4-proxy: dropping non-JSON response body: ${trimmed.slice(0, 100)}\n`,
      );
    }
  }
}

export async function processLine(
  line: string,
  url: URL,
  signer: SignatureV4,
): Promise<void> {
  const input = parseInputLine(line);
  if (!input) return;

  const { body, requestId } = input;
  const request = buildHttpRequest(url, body);

  try {
    const signed = await signer.sign(request);

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: signed.headers as Record<string, string>,
      body,
    });

    await handleResponse(response, requestId);
  } catch (err) {
    process.stderr.write(`mcp-sigv4-proxy: request failed: ${err}\n`);
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: requestId,
        error: { code: -32000, message: 'Proxy request failed' },
      }) + '\n',
    );
  }
}

export function startProxy(): void {
  const config = validateEnv();
  const signer = createSigner(config);
  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  let pending: Promise<void> = Promise.resolve();

  rl.on('line', (line) => {
    pending = pending.then(() => processLine(line, config.url, signer)).catch(() => {});
  });

  rl.on('close', async () => {
    process.stderr.write('mcp-sigv4-proxy: stdin closed, draining in-flight requests\n');
    await pending;
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    process.stderr.write('mcp-sigv4-proxy: received SIGTERM, shutting down\n');
    rl.close();
  });

  process.on('SIGINT', () => {
    process.stderr.write('mcp-sigv4-proxy: received SIGINT, shutting down\n');
    rl.close();
  });
}

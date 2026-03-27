import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { ChildProcess, spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'dist', 'index.js');

// --- Helpers ---

function spawnProxy(
  env: Record<string, string>,
  opts?: { input?: string[]; timeoutMs?: number },
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child: ChildProcess = spawn('node', [BIN], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout!.on('data', (d) => (stdout += d.toString()));
    child.stderr!.on('data', (d) => (stderr += d.toString()));

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
    }, opts?.timeoutMs ?? 5000);

    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, code });
    });

    if (opts?.input) {
      for (const line of opts.input) {
        child.stdin!.write(line + '\n');
      }
      child.stdin!.end();
    } else {
      child.stdin!.end();
    }
  });
}

const baseEnv = {
  MCP_SERVER_URL: 'https://example.com',
  AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
  AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  AWS_REGION: 'us-east-1',
  MCP_LOG_LEVEL: 'DEBUG',
};

function makeConfig(overrides?: Record<string, unknown>) {
  return {
    url: new URL('https://example.com'),
    region: 'us-east-1',
    service: 'test',
    timeoutMs: 180_000,
    retries: 2,
    ...overrides,
  };
}

// --- Unit tests (import proxy.ts for coverage) ---

import {
  parseInputLine,
  parseEndpointUrl,
  buildHttpRequest,
  handleResponse,
  processLine,
  validateEnv,
  createSigner,
  setLogLevel,
  log,
  MAX_SSE_BUFFER_BYTES,
} from '../src/proxy.js';

// --- parseEndpointUrl ---

describe('parseEndpointUrl', () => {
  test('parses bedrock-agentcore amazonaws hostname', () => {
    const result = parseEndpointUrl('bedrock-agentcore.us-east-1.amazonaws.com');
    expect(result).toEqual({ service: 'bedrock-agentcore', region: 'us-east-1' });
  });

  test('parses eu-west-1 region', () => {
    const result = parseEndpointUrl('bedrock-agentcore.eu-west-1.amazonaws.com');
    expect(result).toEqual({ service: 'bedrock-agentcore', region: 'eu-west-1' });
  });

  test('parses service.region.api.aws format', () => {
    const result = parseEndpointUrl('myservice.us-west-2.api.aws');
    expect(result).toEqual({ service: 'myservice', region: 'us-west-2' });
  });

  test('returns null for non-standard hostname', () => {
    expect(parseEndpointUrl('example.com')).toBeNull();
  });

  test('returns null for localhost', () => {
    expect(parseEndpointUrl('localhost')).toBeNull();
  });

  test('returns null for IP address', () => {
    expect(parseEndpointUrl('127.0.0.1')).toBeNull();
  });
});

// --- log ---

describe('log', () => {
  let stderrSpy: ReturnType<typeof jest.spyOn>;
  beforeEach(() => {
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    stderrSpy.mockRestore();
    setLogLevel('ERROR');
  });

  test('ERROR level logs errors', () => {
    setLogLevel('ERROR');
    log('ERROR', 'test error');
    expect(stderrSpy).toHaveBeenCalledWith('mcp-sigv4-proxy: test error\n');
  });

  test('ERROR level suppresses warnings', () => {
    setLogLevel('ERROR');
    log('WARNING', 'test warning');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  test('DEBUG level logs everything', () => {
    setLogLevel('DEBUG');
    log('DEBUG', 'debug msg');
    log('INFO', 'info msg');
    log('WARNING', 'warn msg');
    log('ERROR', 'error msg');
    expect(stderrSpy).toHaveBeenCalledTimes(4);
  });

  test('SILENT level suppresses everything', () => {
    setLogLevel('SILENT');
    log('ERROR', 'should not appear');
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

// --- parseInputLine ---

describe('parseInputLine', () => {
  let stderrSpy: ReturnType<typeof jest.spyOn>;
  beforeEach(() => {
    setLogLevel('DEBUG');
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    stderrSpy.mockRestore();
    setLogLevel('ERROR');
  });

  test('returns null for empty string', () => {
    expect(parseInputLine('')).toBeNull();
    expect(parseInputLine('   ')).toBeNull();
  });

  test('returns null and warns for non-JSON', () => {
    expect(parseInputLine('not json')).toBeNull();
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('ignoring non-JSON input line'),
    );
  });

  test('returns null and warns for JSON without jsonrpc', () => {
    expect(parseInputLine('{"foo": "bar"}')).toBeNull();
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('ignoring non-JSON-RPC message'),
    );
  });

  test('returns null for wrong jsonrpc version', () => {
    expect(parseInputLine('{"jsonrpc": "1.0", "method": "test"}')).toBeNull();
  });

  test('returns null for array JSON', () => {
    expect(parseInputLine('[1, 2, 3]')).toBeNull();
  });

  test('returns null for null JSON', () => {
    expect(parseInputLine('null')).toBeNull();
  });

  test('parses valid JSON-RPC with id', () => {
    const result = parseInputLine('{"jsonrpc": "2.0", "method": "test", "id": 42}');
    expect(result).not.toBeNull();
    expect(result!.requestId).toBe(42);
    expect(result!.body).toBe('{"jsonrpc": "2.0", "method": "test", "id": 42}');
  });

  test('parses notification (no id) with requestId null', () => {
    const result = parseInputLine('{"jsonrpc": "2.0", "method": "notifications/initialized"}');
    expect(result).not.toBeNull();
    expect(result!.requestId).toBeNull();
  });
});

// --- buildHttpRequest ---

describe('buildHttpRequest', () => {
  test('builds correct HttpRequest with query separated from path', () => {
    const url = new URL('https://example.com/path?q=1');
    const body = '{"jsonrpc":"2.0","method":"test","id":1}';
    const req = buildHttpRequest(url, body);

    expect(req.method).toBe('POST');
    expect(req.hostname).toBe('example.com');
    expect(req.path).toBe('/path');
    expect(req.query).toEqual({ q: '1' });
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]),
    );
    expect(headers['content-type']).toBe('application/json');
    expect(headers['host']).toBe('example.com');
    expect(headers['content-length']).toBe(String(Buffer.byteLength(body)));
    expect(req.body).toBe(body);
  });

  test('omits query when URL has no query string', () => {
    const url = new URL('https://example.com/path');
    const req = buildHttpRequest(url, '{}');

    expect(req.path).toBe('/path');
    expect(Object.keys(req.query ?? {}).length).toBe(0);
  });

  test('handles AgentCore URL with encoded ARN', () => {
    const url = new URL(
      'https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/arn%3Aaws%3Abedrock-agentcore%3Aus-east-1%3A130128480380%3Aruntime%2FfinopsMcpprod-ZW2BlvHbUv/invocations?qualifier=DEFAULT',
    );
    const req = buildHttpRequest(url, '{}');

    expect(req.path).toBe(
      '/runtimes/arn%3Aaws%3Abedrock-agentcore%3Aus-east-1%3A130128480380%3Aruntime%2FfinopsMcpprod-ZW2BlvHbUv/invocations',
    );
    expect(req.query).toEqual({ qualifier: 'DEFAULT' });
  });
});

// --- handleResponse ---

describe('handleResponse', () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    setLogLevel('DEBUG');
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    setLogLevel('ERROR');
  });

  test('HTTP error includes upstream message from JSON body', async () => {
    const response = new Response('{"message":"User is not authorized"}', {
      status: 403,
      statusText: 'Forbidden',
      headers: { 'Content-Type': 'application/json' },
    });

    await handleResponse(response, 1);

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('HTTP 403'),
    );

    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.jsonrpc).toBe('2.0');
    expect(output.id).toBe(1);
    expect(output.error.code).toBe(-32000);
    expect(output.error.message).toBe('HTTP 403: User is not authorized');
  });

  test('HTTP error includes short plain-text body', async () => {
    const response = new Response('Internal Server Error details', { status: 500 });
    await handleResponse(response, 5);

    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.id).toBe(5);
    expect(output.error.message).toBe('HTTP 500: Internal Server Error details');
  });

  test('HTTP error omits overly long plain-text body', async () => {
    const response = new Response('x'.repeat(300), { status: 500 });
    await handleResponse(response, 6);

    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.error.message).toBe('HTTP 500');
  });

  test('error with null id (notification)', async () => {
    const response = new Response('error', { status: 400 });
    await handleResponse(response, null);

    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.id).toBeNull();
  });

  test('200 JSON response is forwarded', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { data: 'hello' } });
    const response = new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    await handleResponse(response, 1);

    const output = (stdoutSpy.mock.calls[0][0] as string).trim();
    expect(JSON.parse(output)).toEqual({ jsonrpc: '2.0', id: 1, result: { data: 'hello' } });
  });

  test('200 non-JSON response is dropped with warning', async () => {
    const response = new Response('<html>not json</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });

    await handleResponse(response, 1);

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('dropping non-JSON response body'),
    );
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  test('200 SSE stream forwards JSON data lines', async () => {
    const sseBody =
      'data: {"jsonrpc":"2.0","id":1,"result":"chunk1"}\n\ndata: {"jsonrpc":"2.0","id":1,"result":"chunk2"}\n\n';
    const response = new Response(sseBody, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });

    await handleResponse(response, 1);

    expect(stdoutSpy).toHaveBeenCalledTimes(2);
    const out1 = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    const out2 = JSON.parse((stdoutSpy.mock.calls[1][0] as string).trim());
    expect(out1.result).toBe('chunk1');
    expect(out2.result).toBe('chunk2');
  });

  test('SSE non-JSON data lines are dropped with warning', async () => {
    const sseBody = 'data: not-json-at-all\ndata: {"valid":"json"}\n';
    const response = new Response(sseBody, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });

    await handleResponse(response, 1);

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('dropping non-JSON SSE data'),
    );
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim())).toEqual({ valid: 'json' });
  });

  test('SSE buffer overflow aborts and emits error', async () => {
    const bigChunk = 'x'.repeat(MAX_SSE_BUFFER_BYTES + 100);
    const response = new Response(bigChunk, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });

    await handleResponse(response, 7);

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('SSE buffer exceeded 1 MB limit'),
    );
    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.id).toBe(7);
    expect(output.error.message).toBe('SSE stream exceeded buffer limit');
  });

  test('SSE ignores non-data lines', async () => {
    const sseBody = 'event: message\nid: 123\ndata: {"ok":true}\nretry: 5000\n\n';
    const response = new Response(sseBody, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });

    await handleResponse(response, 1);

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim())).toEqual({ ok: true });
  });
});

describe('MAX_SSE_BUFFER_BYTES', () => {
  test('is 1 MB', () => {
    expect(MAX_SSE_BUFFER_BYTES).toBe(1_048_576);
  });
});

// --- validateEnv ---

describe('validateEnv', () => {
  let exitSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;
  const origEnv = { ...process.env };

  beforeEach(() => {
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    process.env = { ...origEnv };
  });

  test('exits if MCP_SERVER_URL is missing', () => {
    delete process.env.MCP_SERVER_URL;
    expect(() => validateEnv()).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('exits if NODE_TLS_REJECT_UNAUTHORIZED=0', () => {
    process.env.MCP_SERVER_URL = 'https://example.com';
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    expect(() => validateEnv()).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('exits if URL is http:// (non-localhost)', () => {
    process.env.MCP_SERVER_URL = 'http://example.com';
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    expect(() => validateEnv()).toThrow('process.exit called');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('must use https://'));
  });

  test('exits for file:// URL', () => {
    process.env.MCP_SERVER_URL = 'file:///etc/passwd';
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    expect(() => validateEnv()).toThrow('process.exit called');
  });

  test('allows http://localhost', () => {
    process.env.MCP_SERVER_URL = 'http://localhost:8080/mcp';
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    delete process.env.AWS_REGION;
    delete process.env.AWS_SERVICE;
    const config = validateEnv();
    expect(config.url.hostname).toBe('localhost');
  });

  test('allows http://127.0.0.1', () => {
    process.env.MCP_SERVER_URL = 'http://127.0.0.1:3000';
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    delete process.env.AWS_REGION;
    delete process.env.AWS_SERVICE;
    const config = validateEnv();
    expect(config.url.hostname).toBe('127.0.0.1');
  });

  test('infers service and region from amazonaws URL', () => {
    process.env.MCP_SERVER_URL =
      'https://bedrock-agentcore.eu-west-1.amazonaws.com/runtimes/abc/invocations';
    delete process.env.AWS_REGION;
    delete process.env.AWS_SERVICE;
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

    const config = validateEnv();
    expect(config.region).toBe('eu-west-1');
    expect(config.service).toBe('bedrock-agentcore');
  });

  test('env vars override inferred values', () => {
    process.env.MCP_SERVER_URL = 'https://bedrock-agentcore.us-east-1.amazonaws.com/path';
    process.env.AWS_REGION = 'ap-southeast-1';
    process.env.AWS_SERVICE = 'custom-svc';
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

    const config = validateEnv();
    expect(config.region).toBe('ap-southeast-1');
    expect(config.service).toBe('custom-svc');
  });

  test('falls back to defaults for non-standard hostnames', () => {
    process.env.MCP_SERVER_URL = 'https://my-custom-server.example.com';
    delete process.env.AWS_REGION;
    delete process.env.AWS_SERVICE;
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

    const config = validateEnv();
    expect(config.region).toBe('us-east-1');
    expect(config.service).toBe('bedrock-agentcore');
  });

  test('parses MCP_TIMEOUT', () => {
    process.env.MCP_SERVER_URL = 'https://example.com';
    process.env.MCP_TIMEOUT = '60';
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

    const config = validateEnv();
    expect(config.timeoutMs).toBe(60_000);
  });

  test('defaults timeout to 180s', () => {
    process.env.MCP_SERVER_URL = 'https://example.com';
    delete process.env.MCP_TIMEOUT;
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

    const config = validateEnv();
    expect(config.timeoutMs).toBe(180_000);
  });

  test('parses MCP_RETRIES', () => {
    process.env.MCP_SERVER_URL = 'https://example.com';
    process.env.MCP_RETRIES = '5';
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

    const config = validateEnv();
    expect(config.retries).toBe(5);
  });

  test('clamps MCP_RETRIES to 0-10', () => {
    process.env.MCP_SERVER_URL = 'https://example.com';
    process.env.MCP_RETRIES = '99';
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

    const config = validateEnv();
    expect(config.retries).toBe(10);
  });

  test('defaults retries to 2', () => {
    process.env.MCP_SERVER_URL = 'https://example.com';
    delete process.env.MCP_RETRIES;
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

    const config = validateEnv();
    expect(config.retries).toBe(2);
  });
});

// --- createSigner ---

describe('createSigner', () => {
  test('returns a SignatureV4 instance', () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
    process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

    const signer = createSigner(makeConfig());
    expect(signer).toBeDefined();
    expect(typeof signer.sign).toBe('function');
  });
});

// --- processLine ---

describe('processLine', () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    setLogLevel('DEBUG');
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    setLogLevel('ERROR');
  });

  test('skips empty lines', async () => {
    const config = makeConfig();
    const signer = createSigner(config);
    await processLine('', config, signer);
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  test('skips non-JSON', async () => {
    const config = makeConfig();
    const signer = createSigner(config);
    await processLine('not json', config, signer);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('ignoring non-JSON input line'),
    );
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  test('skips non-JSON-RPC', async () => {
    const config = makeConfig();
    const signer = createSigner(config);
    await processLine('{"foo":"bar"}', config, signer);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('ignoring non-JSON-RPC message'),
    );
  });

  test('signs and forwards valid JSON-RPC, relays response', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
    process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

    const config = makeConfig({ url: new URL('https://example.com/path') });
    const signer = createSigner(config);

    const responseBody = JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(responseBody, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;

    try {
      await processLine('{"jsonrpc":"2.0","method":"test","id":1}', config, signer);

      const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
      expect(output.jsonrpc).toBe('2.0');
      expect(output.id).toBe(1);
      expect(output.result).toBe('ok');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('emits JSON-RPC error on network failure', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
    process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

    const config = makeConfig({ url: new URL('https://127.0.0.1:1'), retries: 0 });
    const signer = createSigner(config);
    await processLine('{"jsonrpc":"2.0","method":"test","id":99}', config, signer);

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('request failed'));
    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.id).toBe(99);
    expect(output.error.code).toBe(-32000);
  });

  test('timeout produces specific error message', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
    process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

    const config = makeConfig({
      url: new URL('https://example.com'),
      timeoutMs: 1, // 1ms timeout — will always abort
    });
    const signer = createSigner(config);

    // Mock fetch to hang long enough to trigger timeout
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      // Wait for abort signal
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    }) as typeof fetch;

    try {
      await processLine('{"jsonrpc":"2.0","method":"test","id":1}', config, signer);
      const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
      expect(output.error.message).toBe('Request timed out');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// --- Integration tests ---

describe('integration: startup validation', () => {
  test('missing MCP_SERVER_URL exits with code 1', async () => {
    const result = await spawnProxy({ MCP_SERVER_URL: '' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('MCP_SERVER_URL is required');
  });

  test('http:// remote URL is rejected', async () => {
    const result = await spawnProxy({ MCP_SERVER_URL: 'http://example.com/foo' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('must use https://');
  });

  test('file:// URL is rejected', async () => {
    const result = await spawnProxy({ MCP_SERVER_URL: 'file:///etc/passwd' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('must use https://');
  });

  test('ftp:// URL is rejected', async () => {
    const result = await spawnProxy({ MCP_SERVER_URL: 'ftp://example.com' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('must use https://');
  });

  test('NODE_TLS_REJECT_UNAUTHORIZED=0 is rejected', async () => {
    const result = await spawnProxy({
      MCP_SERVER_URL: 'https://example.com',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('NODE_TLS_REJECT_UNAUTHORIZED=0 is not allowed');
  });

  test('valid https:// URL starts and exits on stdin close', async () => {
    const result = await spawnProxy(baseEnv, { timeoutMs: 3000 });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('stdin closed');
  });
});

describe('integration: URL inference', () => {
  test('infers region and service from amazonaws URL', async () => {
    // Explicitly unset AWS_REGION so inference from URL is used
    const envWithoutRegion = { ...baseEnv, AWS_REGION: '' };
    const result = await spawnProxy(
      {
        ...envWithoutRegion,
        MCP_SERVER_URL:
          'https://bedrock-agentcore.eu-west-1.amazonaws.com/runtimes/abc/invocations',
        MCP_LOG_LEVEL: 'DEBUG',
      },
      { timeoutMs: 3000 },
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('service: bedrock-agentcore');
    expect(result.stderr).toContain('region: eu-west-1');
  });
});

describe('integration: input validation', () => {
  test('empty lines are silently skipped', async () => {
    const result = await spawnProxy(baseEnv, { input: ['', '  ', ''], timeoutMs: 3000 });
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('ignoring');
  });

  test('non-JSON input is ignored', async () => {
    const result = await spawnProxy(baseEnv, { input: ['not json'], timeoutMs: 3000 });
    expect(result.stderr).toContain('ignoring non-JSON input line');
    expect(result.stdout).toBe('');
  });

  test('JSON without jsonrpc is ignored', async () => {
    const result = await spawnProxy(baseEnv, { input: ['{"foo":"bar"}'], timeoutMs: 3000 });
    expect(result.stderr).toContain('ignoring non-JSON-RPC message');
  });
});

describe('integration: request forwarding', () => {
  test('network error produces JSON-RPC error with correct id', async () => {
    const result = await spawnProxy(
      { ...baseEnv, MCP_SERVER_URL: 'https://127.0.0.1:1', MCP_RETRIES: '0' },
      { input: ['{"jsonrpc":"2.0","method":"test","id":42}'], timeoutMs: 5000 },
    );

    const output = JSON.parse(result.stdout.trim());
    expect(output.id).toBe(42);
    expect(output.error.code).toBe(-32000);
  });

  test('notification error has id: null', async () => {
    const result = await spawnProxy(
      { ...baseEnv, MCP_SERVER_URL: 'https://127.0.0.1:1', MCP_RETRIES: '0' },
      {
        input: ['{"jsonrpc":"2.0","method":"notifications/initialized"}'],
        timeoutMs: 5000,
      },
    );

    const output = JSON.parse(result.stdout.trim());
    expect(output.id).toBeNull();
  });
});

describe('integration: sequential processing', () => {
  test('multiple rapid lines produce in-order responses', async () => {
    const lines = Array.from({ length: 5 }, (_, i) =>
      JSON.stringify({ jsonrpc: '2.0', method: 'test', id: i + 1 }),
    );

    const result = await spawnProxy(
      { ...baseEnv, MCP_SERVER_URL: 'https://127.0.0.1:1', MCP_RETRIES: '0' },
      { input: lines, timeoutMs: 15000 },
    );

    const outputs = result.stdout
      .trim()
      .split('\n')
      .filter((l) => l)
      .map((l) => JSON.parse(l));

    expect(outputs).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(outputs[i].id).toBe(i + 1);
    }
  });
});

describe('integration: graceful shutdown', () => {
  test('stdin close drains and exits 0', async () => {
    const result = await spawnProxy(baseEnv, { timeoutMs: 3000 });
    expect(result.stderr).toContain('stdin closed');
    expect(result.code).toBe(0);
  });

  test('SIGTERM triggers shutdown', async () => {
    const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>(
      (resolve) => {
        const child = spawn('node', [BIN], {
          env: { ...process.env, ...baseEnv },
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        child.stdout!.on('data', (d) => (stdout += d.toString()));
        child.stderr!.on('data', (d) => (stderr += d.toString()));

        setTimeout(() => child.kill('SIGTERM'), 500);

        child.on('close', (code) => resolve({ stdout, stderr, code }));
      },
    );

    expect(result.stderr).toContain('received SIGTERM');
  });
});

describe('integration: log level', () => {
  test('SILENT suppresses all stderr', async () => {
    const result = await spawnProxy(
      { ...baseEnv, MCP_LOG_LEVEL: 'SILENT' },
      { input: ['not json'], timeoutMs: 3000 },
    );

    expect(result.stderr).toBe('');
  });

  test('ERROR is the default (suppresses warnings)', async () => {
    const result = await spawnProxy(
      { ...baseEnv, MCP_LOG_LEVEL: '' },
      { input: ['not json'], timeoutMs: 3000 },
    );

    // "ignoring non-JSON input line" is WARNING level — should not appear
    expect(result.stderr).not.toContain('ignoring');
  });
});

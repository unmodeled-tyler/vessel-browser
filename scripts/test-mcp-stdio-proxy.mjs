import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

async function main() {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'vessel-proxy-test-'));
  const configDir = path.join(tmpDir, 'config');
  mkdirSync(configDir, { recursive: true });

  const seenRequests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      seenRequests.push({
        headers: req.headers,
        body: JSON.parse(body),
      });

      if (seenRequests.length === 1) {
        const accept = String(req.headers.accept || '');
        if (
          !accept.includes('application/json') ||
          !accept.includes('text/event-stream')
        ) {
          res.writeHead(406, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad accept' }));
          return;
        }

        if (req.headers.authorization !== 'Bearer test-token') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad auth' }));
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'mcp-session-id': 'session-123',
        });
        res.write('event: message\n');
        res.write(
          'data: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26","capabilities":{},"serverInfo":{"name":"vessel","version":"test"}}}\n\n',
        );
        res.end();
        return;
      }

      if (req.headers['mcp-session-id'] !== 'session-123') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing session header' }));
        return;
      }

      if (req.headers['mcp-protocol-version'] !== '2025-03-26') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing protocol header' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [] } }));
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 3100;

  writeFileSync(
    path.join(configDir, 'mcp-auth.json'),
    JSON.stringify({
      endpoint: `http://127.0.0.1:${port}/mcp`,
      token: 'test-token',
      pid: null,
    }) + '\n',
  );
  writeFileSync(
    path.join(configDir, 'vessel-settings.json'),
    JSON.stringify({ mcpPort: port }) + '\n',
  );

  const child = spawn(process.execPath, ['scripts/mcp-stdio-proxy.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      VESSEL_CONFIG_DIR: configDir,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  child.stdin.write(
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}\n',
  );
  child.stdin.write(
    '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n',
  );
  child.stdin.end();

  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });

  await new Promise((resolve) => server.close(resolve));

  if (exitCode !== 0) {
    throw new Error(`proxy exited with ${exitCode}: ${stderr}`);
  }

  if (stderr.trim()) {
    throw new Error(`unexpected stderr: ${stderr}`);
  }

  const lines = stdout
    .trim()
    .split(/\n+/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  if (lines.length !== 2) {
    throw new Error(`expected 2 stdout lines, got ${lines.length}: ${stdout}`);
  }

  if (lines[0]?.id !== 1 || lines[1]?.id !== 2) {
    throw new Error(`unexpected response ids: ${stdout}`);
  }

  if (seenRequests.length !== 2) {
    throw new Error(
      `expected 2 upstream requests, got ${seenRequests.length}`,
    );
  }

  process.stdout.write('[mcp-proxy] proxy integration check passed\n');
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});

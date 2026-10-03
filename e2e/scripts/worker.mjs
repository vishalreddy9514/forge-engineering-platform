// Starts the BullMQ worker for the end-to-end run and answers on a small HTTP port once it has
// logged "Worker started", so Playwright's webServer can wait for it like the other processes.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const port = Number(process.env.E2E_WORKER_PORT ?? 4099);
let ready = false;

// Info level so the start line is logged; only warnings and errors are passed on (pino JSON).
const worker = spawn(process.execPath, ['dist/worker.js'], {
  cwd: new URL('../../apps/api/', import.meta.url),
  env: { ...process.env, LOG_LEVEL: 'info', LOG_PRETTY: 'false' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
let pending = '';
worker.stdout.on('data', (chunk) => {
  pending += chunk.toString();
  const lines = pending.split('\n');
  pending = lines.pop() ?? '';
  for (const line of lines) {
    if (line.includes('Worker started')) ready = true;
    let level = 50;
    try {
      level = JSON.parse(line).level ?? 50;
    } catch {
      // not JSON: pass it on
    }
    if (level >= 40) process.stdout.write(`${line}\n`);
  }
});
worker.on('exit', (code) => process.exit(code ?? 1));

const server = createServer((_req, res) => {
  res.writeHead(ready ? 200 : 503).end(ready ? 'ready' : 'starting');
}).listen(port, '127.0.0.1');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close();
    worker.kill(signal);
  });
}

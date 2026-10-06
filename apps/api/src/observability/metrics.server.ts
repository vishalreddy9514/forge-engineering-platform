import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServer, type Server } from 'node:http';

import type { Env } from '../config/env';
import { flushErrorReports } from './errors';
import { registry } from './metrics';

/**
 * Serves GET /metrics on METRICS_PORT (default 9464), a port of its own: Nginx and the ALB
 * route only the application port, so metrics are reachable from inside the network only.
 * METRICS_PORT=0 turns it off (tests).
 */
@Injectable()
export class MetricsServer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MetricsServer.name);
  private server?: Server;

  constructor(private readonly config: ConfigService<Env, true>) {}

  async onApplicationBootstrap(): Promise<void> {
    const port = this.config.get('METRICS_PORT', { infer: true });
    if (!port) return;
    this.server = createServer((req, res) => {
      if (req.method !== 'GET' || req.url?.split('?')[0] !== '/metrics') {
        res.writeHead(404).end();
        return;
      }
      registry
        .metrics()
        .then((body) => {
          res.writeHead(200, { 'Content-Type': registry.contentType }).end(body);
        })
        .catch((error: unknown) => {
          this.logger.error(`Metrics collection failed: ${String(error)}`);
          res.writeHead(500).end();
        });
    });
    const listening = await new Promise<boolean>((resolve) => {
      this.server
        ?.once('error', () => {
          resolve(false);
        })
        .listen(port, '0.0.0.0', () => {
          resolve(true);
        });
    });
    if (!listening) {
      // Metrics are not worth a crash: locally the API and the worker share one host and one
      // port number, so the second process to start runs without them.
      this.logger.warn(`Metrics port ${String(port)} is in use; metrics are off in this process`);
      this.server = undefined;
      return;
    }
    this.logger.log(`Metrics on :${String(port)}/metrics`);
  }

  async onApplicationShutdown(): Promise<void> {
    await flushErrorReports();
    await new Promise<void>((resolve) => {
      if (this.server)
        this.server.close(() => {
          resolve();
        });
      else resolve();
    });
  }
}

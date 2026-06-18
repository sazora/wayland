import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

const tempDirs: string[] = [];

function createPackagedRendererRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wayland-static-routes-'));
  const rendererDir = path.join(root, 'out', 'renderer');
  fs.mkdirSync(rendererDir, { recursive: true });
  fs.writeFileSync(path.join(rendererDir, 'index.html'), '<!doctype html><html><body>ok</body></html>', 'utf8');
  tempDirs.push(root);
  return root;
}

function getRegisteredGetRoutePaths(app: express.Express): Array<string | RegExp> {
  return app.router.stack
    .filter(
      (layer: { route?: { path: string | RegExp; methods?: Record<string, boolean> } }) => layer.route?.methods?.get
    )
    .map((layer: { route?: { path: string | RegExp } }) => layer.route?.path)
    .filter((value): value is string | RegExp => value !== undefined);
}

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();

  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('registerStaticRoutes', () => {
  it('does not register a dedicated /favicon.ico route in production static mode', async () => {
    const packagedRoot = createPackagedRendererRoot();

    vi.doMock('electron', () => ({
      app: {
        setName: vi.fn(),
        getAppPath: () => packagedRoot,
      },
    }));
    vi.doMock('@/common/platform', () => ({
      getPlatformServices: () => ({
        paths: {
          getAppPath: () => packagedRoot,
        },
      }),
    }));
    vi.doMock('@process/webserver/auth/middleware/TokenMiddleware', () => ({
      TokenMiddleware: {
        extractToken: () => null,
        isTokenValid: () => true,
      },
    }));
    vi.doMock('@process/webserver/middleware/security', () => ({
      createRateLimiter: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
    }));

    const { registerStaticRoutes } = await import('@process/webserver/routes/staticRoutes');
    const app = express();

    registerStaticRoutes(app);

    expect(getRegisteredGetRoutePaths(app)).not.toContain('/favicon.ico');
  });

  it('serves public SMS compliance legal pages before the SPA catch-all', async () => {
    const packagedRoot = createPackagedRendererRoot();

    vi.doMock('electron', () => ({
      app: {
        setName: vi.fn(),
        getAppPath: () => packagedRoot,
      },
    }));
    vi.doMock('@/common/platform', () => ({
      getPlatformServices: () => ({
        paths: {
          getAppPath: () => packagedRoot,
        },
      }),
    }));
    vi.doMock('@process/webserver/auth/middleware/TokenMiddleware', () => ({
      TokenMiddleware: {
        extractToken: () => null,
        isTokenValid: () => true,
      },
    }));
    vi.doMock('@process/webserver/middleware/security', () => ({
      createRateLimiter: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
    }));

    const { registerStaticRoutes } = await import('@process/webserver/routes/staticRoutes');
    const app = express();

    registerStaticRoutes(app);

    const routes = getRegisteredGetRoutePaths(app);
    expect(routes).toContain('/privacy');
    expect(routes).toContain('/terms');

    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const privacy = await fetch(`http://127.0.0.1:${port}/privacy`);
      const terms = await fetch(`http://127.0.0.1:${port}/terms`);

      expect(privacy.status).toBe(200);
      expect(await privacy.text()).toContain('Mobile phone numbers collected for SMS consent are not shared');
      expect(terms.status).toBe(200);
      expect(await terms.text()).toContain('Message frequency varies based on project activity');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

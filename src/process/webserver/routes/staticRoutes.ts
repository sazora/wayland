/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Express, Request, Response } from 'express';
import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { getPlatformServices } from '@/common/platform';
import { TokenMiddleware } from '@process/webserver/auth/middleware/TokenMiddleware';
import { AUTH_CONFIG } from '../config/constants';
import { createRateLimiter } from '../middleware/security';

type LegalPage = {
  title: string;
  updated: string;
  intro: string;
  sections: Array<{
    heading: string;
    paragraphs: string[];
    bullets?: string[];
  }>;
};

const LEGAL_UPDATED = 'June 18, 2026';

const legalPages: Record<'privacy' | 'terms', LegalPage> = {
  privacy: {
    title: 'AerdiA SMS Messaging Privacy Policy',
    updated: LEGAL_UPDATED,
    intro:
      'This policy describes SMS messages sent through Wayland Lab Project Assistant for AerdiA project coordination and customer care.',
    sections: [
      {
        heading: 'Information we collect',
        paragraphs: [
          'AerdiA may collect a recipient name, mobile phone number, company or role, project association, message content, delivery status, and opt-out status when using Project Assistant messaging.',
        ],
      },
      {
        heading: 'How we use SMS information',
        paragraphs: [
          'AerdiA uses SMS information to send low-volume project coordination, scheduling, document/status requests, customer care, and related operational messages for active business or project relationships.',
        ],
      },
      {
        heading: 'Mobile number sharing',
        paragraphs: [
          'Mobile phone numbers collected for SMS consent are not shared with third parties or affiliates for marketing or promotional purposes.',
          'AerdiA may share SMS information with service providers only as needed to operate, secure, and deliver the messaging service, including telecommunications providers such as Twilio.',
        ],
      },
      {
        heading: 'Message frequency and charges',
        paragraphs: [
          'Message frequency varies based on project activity. Message and data rates may apply.',
        ],
      },
      {
        heading: 'Opt out and help',
        paragraphs: [
          'Recipients can reply STOP to opt out of SMS messages. For help, contact your AerdiA project contact.',
        ],
      },
    ],
  },
  terms: {
    title: 'AerdiA SMS Messaging Terms and Conditions',
    updated: LEGAL_UPDATED,
    intro:
      'These terms apply to SMS messages sent by AerdiA through Wayland Lab Project Assistant for project coordination and customer care.',
    sections: [
      {
        heading: 'Program description',
        paragraphs: [
          'AerdiA sends low-volume SMS messages related to active business and project relationships. Messages may include project updates, scheduling reminders, document or status requests, and customer care.',
        ],
      },
      {
        heading: 'Consent',
        paragraphs: [
          'By providing your mobile number to AerdiA and agreeing to receive project-related text messages, you consent to receive SMS messages from AerdiA. Consent may be provided verbally, in writing, through project intake or contract forms, or by direct request to AerdiA staff.',
        ],
      },
      {
        heading: 'Opt out',
        paragraphs: ['You can cancel SMS messages at any time by replying STOP.'],
      },
      {
        heading: 'Help',
        paragraphs: [
          'For help, contact your AerdiA project contact. Replies may not be monitored except for carrier-supported opt-out handling.',
        ],
      },
      {
        heading: 'Charges and frequency',
        paragraphs: [
          'Message frequency varies based on project activity. Message and data rates may apply. Carriers are not liable for delayed or undelivered messages.',
        ],
      },
      {
        heading: 'Privacy',
        paragraphs: [
          'AerdiA handles SMS information according to the AerdiA SMS Messaging Privacy Policy at /privacy.',
        ],
      },
    ],
  },
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderLegalPage(page: LegalPage): string {
  const sections = page.sections
    .map((section) => {
      const paragraphs = section.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join('');
      const bullets = section.bullets?.length
        ? `<ul>${section.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join('')}</ul>`
        : '';
      return `<section><h2>${escapeHtml(section.heading)}</h2>${paragraphs}${bullets}</section>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(page.title)}</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f6f7f9; color: #1f2933; }
    main { box-sizing: border-box; width: min(880px, 100%); margin: 0 auto; padding: 48px 20px 64px; }
    article { background: #fff; border: 1px solid #d9dee7; border-radius: 8px; padding: 32px; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.06); }
    h1 { margin: 0 0 8px; font-size: 32px; line-height: 1.15; letter-spacing: 0; }
    h2 { margin: 28px 0 8px; font-size: 18px; line-height: 1.3; letter-spacing: 0; }
    p, li { font-size: 15px; line-height: 1.65; }
    p { margin: 0 0 12px; }
    .updated { color: #667085; font-size: 14px; margin-bottom: 24px; }
    a { color: #1456f0; }
    @media (max-width: 640px) {
      main { padding: 24px 12px 40px; }
      article { padding: 22px; }
      h1 { font-size: 25px; }
    }
  </style>
</head>
<body>
  <main>
    <article>
      <h1>${escapeHtml(page.title)}</h1>
      <p class="updated">Last updated: ${escapeHtml(page.updated)}</p>
      <p>${escapeHtml(page.intro)}</p>
      ${sections}
    </article>
  </main>
</body>
</html>`;
}

/**
 * Vite dev server port - read from ELECTRON_RENDERER_URL when available
 * (electron-vite sets it to the actual port), fallback to 5173.
 */
export const VITE_DEV_PORT = (() => {
  const url = process.env['ELECTRON_RENDERER_URL'];
  if (url) {
    try {
      return Number(new URL(url).port) || 5173;
    } catch {
      // ignore parse errors
    }
  }
  return 5173;
})();

/**
 * Try to resolve built renderer assets path, return null if not found
 */
export const resolveRendererPath = (): {
  staticRoot: string;
  indexHtml: string;
} | null => {
  const appPath = getPlatformServices().paths.getAppPath();
  if (!appPath) return null;

  const candidates = [
    {
      staticRoot: path.join(appPath, 'out', 'renderer'),
      indexHtml: path.join(appPath, 'out', 'renderer', 'index.html'),
    },
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate.indexHtml)) {
      return candidate;
    }
  }

  return null;
};

/**
 * Create a proxy middleware that forwards requests to the Vite dev server
 */
function createViteDevProxy(): (req: Request, res: Response) => void {
  return (req: Request, res: Response) => {
    // Remove ALL restrictive security headers set by Express middleware -
    // Vite dev server content doesn't need them and they block HMR/inline scripts
    res.removeHeader('Content-Security-Policy');
    res.removeHeader('X-Frame-Options');
    res.removeHeader('X-Content-Type-Options');
    res.removeHeader('X-XSS-Protection');

    const options: http.RequestOptions = {
      hostname: 'localhost',
      port: VITE_DEV_PORT,
      path: req.url,
      method: req.method,
      headers: {
        ...req.headers,
        host: `localhost:${VITE_DEV_PORT}`,
      },
    };

    const proxyReq = http.request(options, (proxyRes) => {
      const headers = proxyRes.headers;
      for (const [key, value] of Object.entries(headers)) {
        if (value !== undefined) {
          try {
            res.setHeader(key, value);
          } catch {
            // Ignore invalid header errors
          }
        }
      }
      res.status(proxyRes.statusCode || 200);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.error(`[ViteProxy] Error proxying ${req.method} ${req.url}: ${err.message}`);
      if (!res.headersSent) {
        res.status(502).send(`[WebUI] Vite dev server (localhost:${VITE_DEV_PORT}) unavailable: ${err.message}`);
      }
    });

    req.pipe(proxyReq);
  };
}

/**
 * Register static asset routes for production mode
 */
function registerProductionStaticRoutes(expressApp: Express, staticRoot: string, indexHtmlPath: string): void {
  const pageRateLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: 300,
    message: 'Too many requests, please try again later',
  });

  const serveApplication = async (req: Request, res: Response) => {
    try {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');

      const token = TokenMiddleware.extractToken(req);
      if (token && !(await TokenMiddleware.isTokenValid(token))) {
        res.clearCookie(AUTH_CONFIG.COOKIE.NAME);
      }

      const htmlContent = fs.readFileSync(indexHtmlPath, 'utf8');
      // Inject per-request CSP nonce into every <script> tag (inline + module).
      // The renderer's built index.html ships static theme-restore scripts and a
      // module script for main.tsx; strict CSP requires all of them to carry
      // the nonce minted by cspNonceMiddleware.
      const nonce = typeof res.locals.cspNonce === 'string' ? res.locals.cspNonce : '';
      const noncedHtml = nonce
        ? htmlContent.replace(/<script(?![^>]*\bnonce=)([^>]*)>/g, `<script nonce="${nonce}"$1>`)
        : htmlContent;
      res.setHeader('Content-Type', 'text/html');
      res.send(noncedHtml);
    } catch (error) {
      console.error('Error serving index.html:', error);
      res.status(500).send('Internal Server Error');
    }
  };

  expressApp.get('/', pageRateLimiter, serveApplication);
  expressApp.get('/privacy', pageRateLimiter, (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderLegalPage(legalPages.privacy));
  });
  expressApp.get('/terms', pageRateLimiter, (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderLegalPage(legalPages.terms));
  });

  // SPA sub-routes (React Router)
  expressApp.get(/^\/(?!api|static|assets)(?!.*\.[a-zA-Z0-9]+$).*/, pageRateLimiter, serveApplication);

  // Static assets
  expressApp.use(express.static(staticRoot));

  const staticDir = path.join(staticRoot, 'static');
  if (fs.existsSync(staticDir) && fs.statSync(staticDir).isDirectory()) {
    expressApp.use('/static', express.static(staticDir));
  }
}

/**
 * Register static assets and page routes
 *
 * In production: serve built files from out/renderer/
 * In development: proxy to Vite dev server (localhost:5173)
 */
export function registerStaticRoutes(expressApp: Express): void {
  const resolved = resolveRendererPath();

  if (resolved) {
    console.log(`[WebUI] Serving renderer from: ${resolved.staticRoot}`);
    registerProductionStaticRoutes(expressApp, resolved.staticRoot, resolved.indexHtml);
    return;
  }

  // No built assets - proxy to Vite dev server in development mode
  console.log(`[WebUI] No renderer build found, proxying to Vite dev server at http://localhost:${VITE_DEV_PORT}`);
  const proxy = createViteDevProxy();
  expressApp.use(proxy);
}

export default registerStaticRoutes;

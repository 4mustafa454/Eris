// GET /frame.jpg → the latest rendered frame, for the dashboard Live page (AGENTS.md §5.5, §6).
// Bound to localhost only. If the port is taken (another job process or `npm run frames`), it warns once and
// resolves null: the call carries on without the mirror.
import { createServer } from 'node:http';

const ALLOWED_ORIGINS = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);

/**
 * @param {{ port?: number, host?: string, getJpeg: () => Buffer | null, log?: Pick<Console,'warn'|'info'> }} options
 * @returns {Promise<{ port: number, close(): Promise<void> } | null>}
 */
export function startFrameServer({ port = 8788, host = '127.0.0.1', getJpeg, log = console }) {
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if ((req.method !== 'GET' && req.method !== 'HEAD') || path !== '/frame.jpg') {
      res.writeHead(404).end();
      return;
    }
    const headers = { 'cache-control': 'no-store' };
    if (ALLOWED_ORIGINS.has(req.headers.origin)) headers['access-control-allow-origin'] = req.headers.origin;
    let jpeg = null;
    try { jpeg = getJpeg(); } catch (error) { log.warn(`[eris] frame encode failed: ${error.message}`); }
    if (!jpeg) {
      res.writeHead(503, headers).end();
      return;
    }
    res.writeHead(200, { ...headers, 'content-type': 'image/jpeg', 'content-length': jpeg.length });
    res.end(req.method === 'HEAD' ? undefined : jpeg);
  });

  return new Promise(resolve => {
    server.once('error', error => {
      log.warn(error.code === 'EADDRINUSE'
        ? `[eris] frame server: port ${port} is in use, frame.jpg not served by this process`
        : `[eris] frame server failed: ${error.message}`);
      resolve(null);
    });
    server.listen(port, host, () => {
      server.removeAllListeners('error');
      server.on('error', error => log.warn(`[eris] frame server error: ${error.message}`));
      server.unref();
      resolve({
        port: server.address().port,
        close: () => new Promise(done => { server.close(() => done()); server.closeAllConnections(); }),
      });
    });
  });
}

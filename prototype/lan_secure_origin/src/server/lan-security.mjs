import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isLoopbackIp, getActiveMediaRoot } from './cert-helper.mjs';
import { loadBatchCheckpoint } from '../health/batch-probe-store.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROTOTYPE_DIR = path.resolve(__dirname, '..', '..');

const trustedClientIps = new Set();
let activeDeviceToken = null;

export function getAllowedRoots() {
  const primary = getActiveMediaRoot();
  const roots = [primary];
  const renderRoot = 'G:\\Media\\VR\\Render';
  if (fs.existsSync(renderRoot)) roots.push(renderRoot);
  return roots;
}

/**
 * Resolves a requested media path safely within the configured allowed media roots.
 * Strictly prevents parent directory traversal (..) and symlink boundary escapes.
 *
 * @param {string} relParam
 * @returns {string | null}
 */
export function resolveSecureMediaPath(relParam) {
  if (!relParam || typeof relParam !== 'string') return null;
  const roots = getAllowedRoots();

  let candidateRel = relParam.replace(/\\/g, '/').trim();
  while (candidateRel.startsWith('/')) candidateRel = candidateRel.slice(1);
  if (!candidateRel) return null;

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let targetRel = candidateRel;

    const rootBase = path.basename(root);
    if (targetRel.toLowerCase().startsWith(rootBase.toLowerCase() + '/')) {
      targetRel = targetRel.slice(rootBase.length + 1);
    }

    const resolved = path.resolve(root, targetRel);
    const relToRoot = path.relative(root, resolved);
    if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
      continue;
    }

    if (fs.existsSync(resolved)) {
      try {
        const realFile = fs.realpathSync(resolved);
        const realRoot = fs.realpathSync(root);
        const relReal = path.relative(realRoot, realFile);
        if (!relReal.startsWith('..') && !path.isAbsolute(relReal) && fs.statSync(realFile).isFile()) {
          return realFile;
        }
      } catch (e) {}
    }
  }

  return null;
}

/**
 * Gets or initializes the active device pairing / session token.
 *
 * @param {string} [prototypeDir]
 * @returns {string}
 */
export function getActiveDeviceToken(prototypeDir = PROTOTYPE_DIR) {
  if (!activeDeviceToken) {
    try {
      const cp = loadBatchCheckpoint(prototypeDir);
      if (cp && cp.sessionToken) activeDeviceToken = cp.sessionToken;
    } catch (_) {}
    if (!activeDeviceToken) {
      activeDeviceToken = crypto.randomBytes(16).toString('hex');
    }
  }
  return activeDeviceToken;
}

export function trustClientIp(ip) {
  if (ip) trustedClientIps.add(ip);
}

export function revokeTrustedClientIp(ip) {
  trustedClientIps.delete(ip);
}

export function clearTrustedClientIps() {
  trustedClientIps.clear();
}

/**
 * Validates whether the incoming HTTP/HTTPS request originates from an authorized device:
 * 1. PC loopback (127.0.0.1, ::1) is always authorized.
 * 2. Paired/trusted client IP.
 * 3. Valid device session cookie (batch_probe_session or vreconder_device_session).
 * 4. Valid Authorization / X-Device-Token header.
 * 5. Valid URL query token (?token=...).
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {string} [prototypeDir]
 * @returns {boolean}
 */
export function isDeviceAuthorized(req, prototypeDir = PROTOTYPE_DIR) {
  const remoteIp = req.socket?.remoteAddress || '';
  if (isLoopbackIp(remoteIp)) return true;
  if (trustedClientIps.has(remoteIp)) return true;

  const token = getActiveDeviceToken(prototypeDir);
  const cookieHeader = req.headers?.cookie;
  if (cookieHeader) {
    const match = cookieHeader.match(/(?:^|;\s*)(?:batch_probe_session|vreconder_device_session)=([^;]*)/);
    if (match && decodeURIComponent(match[1]) === token) {
      if (remoteIp) trustedClientIps.add(remoteIp);
      return true;
    }
  }

  const authHeader = req.headers?.['x-device-token'] || req.headers?.authorization;
  if (authHeader) {
    const candidate = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (candidate === token) {
      if (remoteIp) trustedClientIps.add(remoteIp);
      return true;
    }
  }

  try {
    const urlObj = new URL(req.url, 'http://localhost');
    const qToken = urlObj.searchParams.get('token');
    if (qToken && qToken === token) {
      if (remoteIp) trustedClientIps.add(remoteIp);
      return true;
    }
  } catch (_) {}

  return false;
}

/**
 * Handles loopback-only device trust requests from PC controller.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {object} [latestTelemetry]
 * @returns {boolean}
 */
export function handleDeviceTrustRoute(req, res, latestTelemetry = null) {
  if (!isLoopbackIp(req.socket?.remoteAddress)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Device trust endpoint is only callable from PC loopback' }));
    return true;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const payload = JSON.parse(body || '{}');
      const targetIp = payload.ip || (latestTelemetry && latestTelemetry.clientIp);
      if (targetIp) {
        trustClientIp(targetIp);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, trustedIp: targetIp }));
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No target IP specified or active' }));
      }
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
  return true;
}

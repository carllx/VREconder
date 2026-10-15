import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isLoopbackIp, getActiveMediaRoot } from './cert-helper.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROTOTYPE_DIR = path.resolve(__dirname, '..', '..');

// ============================================================
// 1. Media Root & Path Resolution Guardrails (Boundary Closure)
// ============================================================

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

// ============================================================
// 2. Dedicated Device Authentication & Session Store (P0 / P2)
// ============================================================

let activeDeviceSecret = crypto.randomBytes(32).toString('hex');
const activeSessions = new Map(); // sessionToken -> { createdAt: number, clientIp: string }
let activePairingPin = null;
let pairingPinExpiresAt = 0;
const pinFailedAttempts = new Map(); // clientIp -> { count: number, lockedUntil: number }
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 60 * 1000;

export function generatePlayerPairingPin() {
  activePairingPin = String(crypto.randomInt(100000, 1000000));
  pairingPinExpiresAt = Date.now() + 15 * 60 * 1000;
  return { pin: activePairingPin, expiresAt: pairingPinExpiresAt };
}

export function getActivePairingPin() {
  if (activePairingPin && Date.now() < pairingPinExpiresAt) {
    return { pin: activePairingPin, expiresAt: pairingPinExpiresAt };
  }
  return generatePlayerPairingPin();
}

export function verifyDevicePin(inputPin, clientIp = 'default') {
  if (!inputPin || typeof inputPin !== 'string') {
    return { valid: false, reason: 'INVALID_INPUT' };
  }
  const now = Date.now();
  const failureEntry = pinFailedAttempts.get(clientIp) || { count: 0, lockedUntil: 0 };
  if (failureEntry.lockedUntil > now) {
    const retryAfterSec = Math.ceil((failureEntry.lockedUntil - now) / 1000);
    return { valid: false, reason: 'RATE_LIMITED', retryAfterSec };
  }

  if (!activePairingPin || now >= pairingPinExpiresAt) {
    failureEntry.count++;
    if (failureEntry.count >= MAX_FAILED_ATTEMPTS) failureEntry.lockedUntil = now + LOCKOUT_MS;
    pinFailedAttempts.set(clientIp, failureEntry);
    return { valid: false, reason: 'PIN_EXPIRED_OR_ABSENT' };
  }

  if (inputPin.trim() === activePairingPin) {
    activePairingPin = null; // Single-use invalidation
    pairingPinExpiresAt = 0;
    pinFailedAttempts.delete(clientIp);
    const sessionToken = crypto.randomBytes(24).toString('hex');
    activeSessions.set(sessionToken, { createdAt: now, clientIp });
    return { valid: true, sessionToken };
  } else {
    failureEntry.count++;
    if (failureEntry.count >= MAX_FAILED_ATTEMPTS) failureEntry.lockedUntil = now + LOCKOUT_MS;
    pinFailedAttempts.set(clientIp, failureEntry);
    return { valid: false, reason: 'PIN_MISMATCH' };
  }
}

export function createAuthorizedSession(clientIp = 'loopback') {
  const sessionToken = crypto.randomBytes(24).toString('hex');
  activeSessions.set(sessionToken, { createdAt: Date.now(), clientIp });
  return sessionToken;
}

export function revokeAllDeviceSessions() {
  activeSessions.clear();
  activeDeviceSecret = crypto.randomBytes(32).toString('hex');
  activePairingPin = null;
  pairingPinExpiresAt = 0;
  pinFailedAttempts.clear();
}

export function getDeviceSessionToken(req) {
  const cookieHeader = req.headers?.cookie;
  if (cookieHeader) {
    const match = cookieHeader.match(/(?:^|;\s*)vreconder_device_session=([^;]*)/);
    if (match) return decodeURIComponent(match[1]);
  }
  const authHeader = req.headers?.['x-device-session'] || req.headers?.authorization;
  if (authHeader) {
    return authHeader.replace(/^Bearer\s+/i, '').trim();
  }
  return null;
}

/**
 * Validates device authorization:
 * 1. PC loopback is always authorized.
 * 2. Paired session token from secure cookie/header present in activeSessions.
 * IP address alone is NEVER used as authorization!
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
export function isDeviceAuthorized(req) {
  const remoteIp = req.socket?.remoteAddress || '';
  if (isLoopbackIp(remoteIp)) return true;

  const token = getDeviceSessionToken(req);
  if (token && activeSessions.has(token)) {
    return true;
  }

  return false;
}

// ============================================================
// 3. Static Asset Whitelist Enforcement (P0 / P1)
// ============================================================

/**
 * Checks if a requested pathname is on the explicit public static asset whitelist.
 * Strictly blocks all .json, .jsonl, .log, .key, .crt, .mjs, and private configs.
 *
 * @param {string} pathname
 * @param {boolean} isLoopback
 * @returns {boolean}
 */
export function isAllowedPublicStaticAsset(pathname, isLoopback = false) {
  if (!pathname || typeof pathname !== 'string') return false;
  // Disallow path traversal, backslashes, hidden files, or null bytes
  if (pathname.includes('..') || pathname.includes('\\') || pathname.includes('\0')) return false;

  const lower = pathname.toLowerCase();

  // Explicit forbidden file extensions (NEVER serve statically)
  const forbiddenExts = ['.json', '.jsonl', '.log', '.key', '.crt', '.mjs', '.md', '.txt', '.py', '.sh', '.ps1', '.bat'];
  for (const ext of forbiddenExts) {
    if (lower.endsWith(ext)) return false;
  }

  // Controller UI is restricted strictly to PC loopback
  if (pathname === '/controller' || pathname === '/controller.html') {
    return isLoopback;
  }

  // Allowed HTML pages
  const allowedHtml = ['/index.html', '/', '/native-video-diag.html', '/webgl-upload-diag.html'];
  if (allowedHtml.includes(pathname)) return true;

  // Frontend JS modules (strictly inside /src/)
  if (pathname.startsWith('/src/') && lower.endsWith('.js')) {
    return true;
  }

  // Frontend CSS
  if (pathname === '/styles.css') return true;

  // Frontend static image/icon assets
  if (/\.(png|svg|ico)$/i.test(pathname)) {
    if (pathname.startsWith('/icons/') || pathname.startsWith('/assets/') || pathname === '/favicon.ico') {
      return true;
    }
  }

  return false;
}

// ============================================================
// 4. Loopback & Pairing Route Handlers (P2)
// ============================================================

export function handleDevicePinRoute(req, res) {
  if (!isLoopbackIp(req.socket?.remoteAddress)) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Pairing PIN is only viewable from PC local console' }));
    return true;
  }
  const pinData = getActivePairingPin();
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true, pin: pinData.pin, expiresAt: pinData.expiresAt }));
  return true;
}

export function handleDevicePairRoute(req, res, isHttps) {
  const isLoopback = isLoopbackIp(req.socket?.remoteAddress);
  if (!isHttps && !isLoopback) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Pairing requires secure HTTPS connection', code: 'HTTPS_REQUIRED' }));
    return true;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const payload = body ? JSON.parse(body) : {};
      const clientIp = req.socket?.remoteAddress || 'unknown';
      const result = verifyDevicePin(payload.pin, clientIp);

      if (!result.valid) {
        if (result.reason === 'RATE_LIMITED') {
          res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': String(result.retryAfterSec || 60) });
          res.end(JSON.stringify({ error: 'Too many failed pairing attempts. Please wait.', retryAfterSec: result.retryAfterSec }));
          return;
        }
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: result.reason === 'PIN_EXPIRED_OR_ABSENT' ? 'PIN expired or not generated' : 'Invalid pairing PIN' }));
        return;
      }

      // Issue long-lived secure HttpOnly session cookie
      res.setHeader('Set-Cookie', `vreconder_device_session=${result.sessionToken}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=31536000`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, authorized: true }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
  return true;
}

export function handleDeviceApproveRoute(req, res) {
  if (!isLoopbackIp(req.socket?.remoteAddress)) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Device approval endpoint is only callable from PC loopback' }));
    return true;
  }
  const sessionToken = createAuthorizedSession('loopback_approved');
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true, sessionToken }));
  return true;
}

export function handleDeviceRevokeRoute(req, res) {
  if (!isLoopbackIp(req.socket?.remoteAddress)) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Device revocation is only callable from PC loopback' }));
    return true;
  }
  revokeAllDeviceSessions();
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true, revoked: true, message: 'All active device sessions revoked' }));
  return true;
}

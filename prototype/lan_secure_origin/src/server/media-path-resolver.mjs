import path from 'node:path';
import fs from 'node:fs';

/**
 * Checks whether a target file path is contained within at least one of the allowed roots.
 *
 * @param {string} targetPath
 * @param {string[]} allowedRoots
 * @returns {boolean}
 */
export function isPathContained(targetPath, allowedRoots = []) {
  if (!targetPath || !allowedRoots || allowedRoots.length === 0) return false;
  const normTarget = path.normalize(path.resolve(targetPath));
  for (const root of allowedRoots) {
    if (!root) continue;
    const normRoot = path.normalize(path.resolve(root));
    const rel = path.relative(normRoot, normTarget);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      return true;
    }
  }
  return false;
}

/**
 * Resolves a media path or relative parameter securely against approved media roots.
 * Returns the absolute resolved path ONLY if:
 * 1. It is contained within an approved root
 * 2. It physically exists on disk
 *
 * Otherwise returns null.
 *
 * @param {string} relParam
 * @param {string[]} allowedRoots
 * @returns {string | null}
 */
export function resolveSecureMediaPath(relParam, allowedRoots = []) {
  if (!relParam || typeof relParam !== 'string' || !allowedRoots || allowedRoots.length === 0) {
    return null;
  }

  // 1. Direct resolution or relative to each root
  for (const root of allowedRoots) {
    if (!root) continue;
    const resolved = path.resolve(root, relParam);
    if (isPathContained(resolved, [root]) && fs.existsSync(resolved)) {
      return resolved;
    }
  }

  // 2. Resolution relative to root's parent directory (e.g. prefixed with 'Render/...')
  for (const root of allowedRoots) {
    if (!root) continue;
    const parentDir = path.dirname(root);
    const resolved = path.resolve(parentDir, relParam);
    if (isPathContained(resolved, allowedRoots) && fs.existsSync(resolved)) {
      return resolved;
    }
  }

  return null;
}

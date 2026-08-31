import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const POLICY_VERSION = 'v1.0.0-safari-compat';

export class DeviceProbeCache {
  constructor(storagePath) {
    this.storagePath = storagePath ? path.resolve(storagePath) : path.join(process.cwd(), 'prototype/lan_secure_origin/device_probe_cache.json');
    this.memoryCache = new Map();
    this.loadFromDisk();
  }

  getCacheKey(fingerprintId, clientFamily = 'safari-ios', policyVersion = POLICY_VERSION) {
    return `${fingerprintId}:${clientFamily}:${policyVersion}`;
  }

  loadFromDisk() {
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = JSON.parse(fs.readFileSync(this.storagePath, 'utf8'));
        for (const [k, v] of Object.entries(raw)) {
          this.memoryCache.set(k, v);
        }
      }
    } catch (e) {}
  }

  saveToDisk() {
    try {
      const obj = Object.fromEntries(this.memoryCache);
      const tmp = `${this.storagePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
      fs.renameSync(tmp, this.storagePath);
    } catch (e) {}
  }

  get(fingerprintId, clientFamily = 'safari-ios', policyVersion = POLICY_VERSION) {
    const key = this.getCacheKey(fingerprintId, clientFamily, policyVersion);
    return this.memoryCache.get(key) || null;
  }

  set(fingerprintId, result, clientFamily = 'safari-ios', policyVersion = POLICY_VERSION) {
    const key = this.getCacheKey(fingerprintId, clientFamily, policyVersion);
    const entry = {
      fingerprintId,
      clientFamily,
      policyVersion,
      result,
      cachedAt: new Date().toISOString()
    };
    this.memoryCache.set(key, entry);
    this.saveToDisk();
    return entry;
  }

  clear() {
    this.memoryCache.clear();
    this.saveToDisk();
  }
}

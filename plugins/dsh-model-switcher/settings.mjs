import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostProvider, hostCredentialRef } from './catalog.mjs';

export function validateGatewayURL(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Enter only the gateway origin, for example http://192.168.50.10:8083.');
  }
  if (url.protocol === 'http:') {
    const ip = url.hostname.split('.').map(Number);
    const privateIPv4 = ip.length === 4 && ip.every(n => Number.isInteger(n) && n >= 0 && n <= 255) &&
      (ip[0] === 10 || ip[0] === 127 || (ip[0] === 192 && ip[1] === 168) ||
       (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31));
    if (!privateIPv4 && url.hostname !== 'localhost' && !url.hostname.endsWith('.local')) {
      throw new Error('Use a private LAN address for HTTP, or a trusted HTTPS endpoint.');
    }
  }
  return url.origin;
}

export function validateHost(host) {
  if (!host || !/^[a-z][a-z0-9-]{0,23}$/.test(host.id) || typeof host.label !== 'string' || !host.label.trim() || host.label.length > 80 ||
      host.provider !== hostProvider(host.id) || host.credentialRef !== hostCredentialRef(host.id) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(host.gatewayId)) {
    throw new Error('A saved model host binding is invalid. Run the installer to review it.');
  }
  return { id: host.id, label: host.label.trim(), provider: host.provider, credentialRef: host.credentialRef,
    gatewayId: host.gatewayId, url: validateGatewayURL(host.url) };
}

export function validateClientConfig(config) {
  if (config?.version !== 2 || !Array.isArray(config.hosts) || config.hosts.length < 1 || config.hosts.length > 16) throw new Error('The model client needs one or more named host bindings.');
  const hosts = config.hosts.map(validateHost);
  for (const field of ['id', 'provider', 'credentialRef', 'gatewayId']) if (new Set(hosts.map(host => host[field])).size !== hosts.length) throw new Error('Duplicate model host bindings require review.');
  return { version: 2, hosts };
}

export function readClientConfig(home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')) {
  return validateClientConfig(JSON.parse(fs.readFileSync(path.join(home, 'local-model-switch-client.json'), 'utf8')));
}

/** Credentials remain in Harness's private credential store, never in renderer code. */
export async function loadGatewayConfig({ hostId, home, resolveCredential } = {}) {
  const host = readClientConfig(home).hosts.find(item => item.id === hostId);
  if (!host) throw new Error('The requested model host is not configured.');
  const resolved = resolveCredential ? await resolveCredential(host.credentialRef) : undefined;
  const key = resolved?.value ?? process.env[host.credentialRef];
  if (typeof key !== 'string' || !key.trim()) throw new Error('The Windows model server credential is missing. Run the installer again.');
  return { ...host, baseURL: host.url, key };
}

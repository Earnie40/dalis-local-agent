import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import type { AuthorizedTargetRule, ResolvedAuthorizedTarget } from './live-validation-types.js';

export type TargetRejectionCode =
  | 'INVALID_TARGET'
  | 'UNRESOLVED_TARGET'
  | 'PUBLIC_INTERNET'
  | 'OUTSIDE_AUTHORIZED_SCOPE';

export class TargetAuthorizationError extends Error {
  constructor(
    public readonly code: TargetRejectionCode,
    message: string,
    public readonly target: string,
  ) {
    super(message);
    this.name = 'TargetAuthorizationError';
  }
}

export interface TargetResolver {
  resolve(hostname: string): Promise<string[]>;
}

export class NodeTargetResolver implements TargetResolver {
  async resolve(hostname: string): Promise<string[]> {
    const records = await lookup(hostname, { all: true, verbatim: true });
    return [...new Set(records.map((record) => record.address))];
  }
}

function parseTarget(target: string): { protocol?: string; hostname: string; port?: number } {
  const value = target.trim();
  if (!value) throw new TargetAuthorizationError('INVALID_TARGET', 'Target is empty.', target);

  try {
    const url = value.includes('://') ? new URL(value) : undefined;
    if (url) {
      if (!['http:', 'https:'].includes(url.protocol)) {
        throw new TargetAuthorizationError(
          'INVALID_TARGET',
          `Unsupported live-validation protocol "${url.protocol}".`,
          target,
        );
      }
      if (url.username || url.password) {
        throw new TargetAuthorizationError('INVALID_TARGET', 'Credentials are not allowed in target URLs.', target);
      }
      return {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, '').toLowerCase(),
        port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
      };
    }
  } catch (error) {
    if (error instanceof TargetAuthorizationError) throw error;
    throw new TargetAuthorizationError('INVALID_TARGET', `Target is not a valid URL: ${value}`, target);
  }

  const bracketed = value.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) return { hostname: bracketed[1].toLowerCase(), port: bracketed[2] ? Number(bracketed[2]) : undefined };

  const hostPort = value.match(/^([^:]+):(\d+)$/);
  if (hostPort) return { hostname: hostPort[1].toLowerCase(), port: Number(hostPort[2]) };
  return { hostname: value.toLowerCase() };
}

function normalizeRule(rule: string | AuthorizedTargetRule): AuthorizedTargetRule {
  if (typeof rule !== 'string') {
    return {
      host: rule.host?.trim().replace(/^\[|\]$/g, '').toLowerCase(),
      cidr: rule.cidr?.trim().toLowerCase(),
      ports: rule.ports ? [...new Set(rule.ports)] : undefined,
    };
  }

  const value = rule.trim();
  if (!value || value === '*' || value.includes('*')) {
    throw new Error('LIVE_VALIDATION allowlists require exact hosts/IPs or CIDRs; wildcards are forbidden.');
  }
  if (value.includes('/') && !value.includes('://')) return { cidr: value.toLowerCase() };
  const parsed = parseTarget(value);
  return { host: parsed.hostname, ports: parsed.port ? [parsed.port] : undefined };
}

function ipv4ToBigInt(address: string): bigint | null {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return octets.reduce((value, part) => (value << 8n) | BigInt(part), 0n);
}

function ipv6ToBigInt(input: string): bigint | null {
  let address = input.toLowerCase().split('%')[0];
  const ipv4Tail = address.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (ipv4Tail) {
    const ipv4 = ipv4ToBigInt(ipv4Tail);
    if (ipv4 === null) return null;
    address = address.slice(0, -ipv4Tail.length) + `${Number((ipv4 >> 16n) & 0xffffn).toString(16)}:${Number(ipv4 & 0xffffn).toString(16)}`;
  }

  const sides = address.split('::');
  if (sides.length > 2) return null;
  const left = sides[0] ? sides[0].split(':') : [];
  const right = sides.length === 2 && sides[1] ? sides[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((sides.length === 1 && missing !== 0) || (sides.length === 2 && missing < 1)) return null;
  const parts = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return parts.reduce((value, part) => (value << 16n) | BigInt(parseInt(part, 16)), 0n);
}

function addressToBigInt(address: string, family: 4 | 6): bigint | null {
  return family === 4 ? ipv4ToBigInt(address) : ipv6ToBigInt(address);
}

export function cidrContains(cidr: string, address: string): boolean {
  const [network, prefixText] = cidr.split('/');
  const family = isIP(network);
  if ((family !== 4 && family !== 6) || isIP(address) !== family) return false;
  const bits = family === 4 ? 32 : 128;
  const prefix = Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) return false;
  const networkValue = addressToBigInt(network, family);
  const addressValue = addressToBigInt(address, family);
  if (networkValue === null || addressValue === null) return false;
  const shift = BigInt(bits - prefix);
  return (networkValue >> shift) === (addressValue >> shift);
}

/** Only isolated/private/link-local/loopback unicast destinations are live-test eligible. */
export function isPrivateLabAddress(address: string): boolean {
  if (isIP(address) === 4) {
    return (
      cidrContains('10.0.0.0/8', address) ||
      cidrContains('172.16.0.0/12', address) ||
      cidrContains('192.168.0.0/16', address) ||
      cidrContains('127.0.0.0/8', address) ||
      cidrContains('169.254.0.0/16', address)
    );
  }
  if (isIP(address) === 6) {
    const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    if (mapped) return isPrivateLabAddress(mapped);
    return address === '::1' || cidrContains('fc00::/7', address) || cidrContains('fe80::/10', address);
  }
  return false;
}

export class AuthorizedTargetAllowlist {
  private readonly rules: AuthorizedTargetRule[];

  constructor(
    rules: Array<string | AuthorizedTargetRule>,
    private readonly resolver: TargetResolver = new NodeTargetResolver(),
  ) {
    if (rules.length === 0) throw new Error('LIVE_VALIDATION requires a non-empty authorized target allowlist.');
    this.rules = rules.map(normalizeRule);
    for (const rule of this.rules) {
      if ((!rule.host && !rule.cidr) || (rule.host && rule.cidr)) {
        throw new Error('Each allowlist rule must define exactly one of host or cidr.');
      }
      if (rule.cidr) {
        const [network] = rule.cidr.split('/');
        if (!isIP(network) || !cidrContains(rule.cidr, network) || !isPrivateLabAddress(network)) {
          throw new Error(`Allowlist CIDR is not a valid private Tomahawk1 lab network: ${rule.cidr}`);
        }
      }
      if (rule.host?.includes('*')) throw new Error('Wildcard hosts are forbidden in LIVE_VALIDATION allowlists.');
      if (rule.ports?.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
        throw new Error('Allowlist ports must be integers between 1 and 65535.');
      }
    }
  }

  async authorize(target: string): Promise<ResolvedAuthorizedTarget> {
    const parsed = parseTarget(target);
    let addresses: string[];
    try {
      addresses = isIP(parsed.hostname) ? [parsed.hostname] : await this.resolver.resolve(parsed.hostname);
    } catch (error) {
      throw new TargetAuthorizationError(
        'UNRESOLVED_TARGET',
        `Target resolution failed for "${parsed.hostname}": ${error instanceof Error ? error.message : String(error)}`,
        target,
      );
    }
    addresses = [...new Set(addresses.map((address) => address.toLowerCase()))];
    if (addresses.length === 0 || addresses.some((address) => !isIP(address))) {
      throw new TargetAuthorizationError('UNRESOLVED_TARGET', `Target "${parsed.hostname}" did not resolve to an IP address.`, target);
    }
    const publicAddresses = addresses.filter((address) => !isPrivateLabAddress(address));
    if (publicAddresses.length > 0) {
      throw new TargetAuthorizationError(
        'PUBLIC_INTERNET',
        `Public Internet routing is forbidden; "${parsed.hostname}" resolved outside the isolated lab.`,
        target,
      );
    }

    const matchedRules = this.rules.filter((rule) => {
      const portAllowed = !rule.ports || (parsed.port !== undefined && rule.ports.includes(parsed.port));
      if (!portAllowed) return false;
      if (rule.host) return rule.host === parsed.hostname;
      return Boolean(rule.cidr && addresses.every((address) => cidrContains(rule.cidr!, address)));
    });
    if (matchedRules.length === 0) {
      throw new TargetAuthorizationError(
        'OUTSIDE_AUTHORIZED_SCOPE',
        `Target "${parsed.hostname}" is not provably within the configured Tomahawk1 lab allowlist.`,
        target,
      );
    }

    return {
      requestedTarget: target,
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      addresses,
      matchedRules,
      resolvedAt: new Date(),
    };
  }
}

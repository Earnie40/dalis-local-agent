import { describe, expect, it } from 'vitest';
import {
  AnonymizedSourceDetector,
  DEFAULT_DETECTION_CONFIG,
  parseAwsIpRanges,
  parseTorExitAddresses,
} from '@dacai-local-agent/security';

describe('DEFAULT_DETECTION_CONFIG', () => {
  it('has no hardcoded placeholder IPs — real data comes from a fetch, not a literal', () => {
    expect(DEFAULT_DETECTION_CONFIG.knownTorExitNodes).toEqual([]);
    expect(DEFAULT_DETECTION_CONFIG.knownProxyIps).toEqual([]);
    expect(DEFAULT_DETECTION_CONFIG.knownDatacenterRanges).toEqual([]);
  });
});

describe('parseTorExitAddresses', () => {
  it('extracts IPs from real Tor Project exit-address format, skipping malformed lines', () => {
    const body = [
      'ExitNode ABCDEF0123456789ABCDEF0123456789ABCDEF01',
      'Published 2026-08-15 00:00:00',
      'LastStatus 2026-08-15 01:00:00',
      'ExitAddress 198.51.100.7 2026-08-15 01:00:00',
      '',
      'ExitNode FEDCBA9876543210FEDCBA9876543210FEDCBA98',
      'ExitAddress not-an-ip 2026-08-15 01:00:00', // malformed — must be skipped, not crash the parse
      'ExitAddress 203.0.113.42 2026-08-15 01:05:00',
    ].join('\n');

    expect(parseTorExitAddresses(body)).toEqual(['198.51.100.7', '203.0.113.42']);
  });

  it('returns an empty list rather than throwing on a completely empty or unexpected body', () => {
    expect(parseTorExitAddresses('')).toEqual([]);
    expect(parseTorExitAddresses('<html>unexpected content</html>')).toEqual([]);
  });
});

describe('parseAwsIpRanges', () => {
  it('extracts CIDR prefixes from the real AWS ip-ranges.json shape', () => {
    const body = JSON.stringify({
      syncToken: '123',
      prefixes: [
        { ip_prefix: '3.5.140.0/22', region: 'ap-northeast-2', service: 'AMAZON' },
        { ip_prefix: '13.34.37.64/27', region: 'ap-southeast-4', service: 'EC2' },
        { region: 'no-prefix-field', service: 'S3' },
      ],
    });

    expect(parseAwsIpRanges(body)).toEqual(['3.5.140.0/22', '13.34.37.64/27']);
  });

  it('throws a clear error on genuinely invalid JSON rather than silently returning nothing', () => {
    expect(() => parseAwsIpRanges('not json')).toThrow(/not valid JSON/);
  });
});

describe('AnonymizedSourceDetector with real fetched-shaped data', () => {
  it('flags a request whose source IP falls within a fetched datacenter CIDR range', () => {
    const detector = new AnonymizedSourceDetector({
      ...DEFAULT_DETECTION_CONFIG,
      knownDatacenterRanges: ['3.5.140.0/22'],
    });

    const result = detector.detect({ sourceIp: '3.5.140.100', endpoint: '/api/security/engagements' });

    expect(result.detected).toBe(true);
    expect(result.detectionMethod).toBe('datacenter-range');
    // Deliberately weaker confidence than a known Tor exit node or proxy IP.
    expect(result.confidence).toBeLessThan(0.5);
  });

  it('does not flag an address outside every configured range', () => {
    const detector = new AnonymizedSourceDetector({ ...DEFAULT_DETECTION_CONFIG, knownDatacenterRanges: ['3.5.140.0/22'] });
    const result = detector.detect({ sourceIp: '198.51.100.7', endpoint: '/api/security/engagements' });
    expect(result.detected).toBe(false);
  });

  it('flags a real fetched Tor exit-node IP by exact match', () => {
    const detector = new AnonymizedSourceDetector({ ...DEFAULT_DETECTION_CONFIG, knownTorExitNodes: ['198.51.100.7'] });
    const result = detector.detect({ sourceIp: '198.51.100.7', endpoint: '/api/security/engagements' });
    expect(result.detected).toBe(true);
    expect(result.detectionMethod).toBe('tor-exit-node');
  });
});

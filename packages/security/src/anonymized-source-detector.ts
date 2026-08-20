/**
 * Anonymized Source Detector
 *
 * Detects requests routed through Tor, proxies, VPNs, and other anonymity services.
 * Classifies risk and logs for audit/response.
 */

import { cidrContains } from './target-allowlist.js';
import type { AnonymizedSourceDetectionConfig } from '@dacai-local-agent/security';

/**
 * No hardcoded IP/CIDR lists here. Real values come from
 * anonymized-source-feeds.ts (a real fetch from the Tor Project and AWS's
 * published ranges), refreshed periodically by AnonymizedSourceFeedRefresher
 * and supplied to this detector's config. An empty list here means "no data
 * has been fetched yet," never a placeholder standing in for real data.
 */
export const DEFAULT_DETECTION_CONFIG: AnonymizedSourceDetectionConfig = {
  enableTorDetection: true,
  enableProxyDetection: true,
  enableVpnDetection: true,
  enableDatacenterDetection: true,
  knownTorExitNodes: [],
  knownProxyIps: [],
  knownDatacenterRanges: [],
  classificationRules: {
    singleRequestClassification: 'informational',
    patternDetectionThreshold: 50, // requests per minute
    patternClassification: 'hostile',
  },
  responseActions: {
    informational: 'log',
    suspicious: 'throttle',
    hostile: 'block',
  },
};

export interface DetectionRequest {
  sourceIp: string;
  userAgent?: string;
  endpoint: string;
  headers?: Record<string, string>;
}

export interface DetectionResult {
  detected: boolean;
  detectionMethod?: string;
  classification: 'informational' | 'suspicious' | 'hostile';
  confidence: number; // 0.0 to 1.0
  reason?: string;
}

/**
 * AnonymizedSourceDetector: Identify Tor/proxy/VPN requests
 */
export class AnonymizedSourceDetector {
  constructor(private config: AnonymizedSourceDetectionConfig = DEFAULT_DETECTION_CONFIG) {}

  /**
   * Analyze a request for anonymized source indicators
   */
  detect(request: DetectionRequest): DetectionResult {
    // Check Tor exit nodes
    if (this.config.enableTorDetection && this.isTorExitNode(request.sourceIp)) {
      return {
        detected: true,
        detectionMethod: 'tor-exit-node',
        classification: this.config.classificationRules.singleRequestClassification,
        confidence: 0.95,
        reason: `IP ${request.sourceIp} is a known Tor exit node`,
      };
    }

    // Check known proxy IPs
    if (this.config.enableProxyDetection && this.isKnownProxy(request.sourceIp)) {
      return {
        detected: true,
        detectionMethod: 'proxy-ip',
        classification: 'informational',
        confidence: 0.85,
        reason: `IP ${request.sourceIp} is a known proxy server`,
      };
    }

    // Check user agent for VPN/proxy signatures
    if (this.config.enableVpnDetection && request.userAgent && this.hasVpnSignature(request.userAgent)) {
      return {
        detected: true,
        detectionMethod: 'vpn-signature',
        classification: 'informational',
        confidence: 0.6,
        reason: `User-Agent contains VPN/proxy signature: ${request.userAgent}`,
      };
    }

    // Weaker signal than a known proxy/VPN exit: only means the request originated from a
    // published cloud-provider netblock, not that it's a known anonymization service.
    if (this.config.enableDatacenterDetection && this.isDatacenterRange(request.sourceIp)) {
      return {
        detected: true,
        detectionMethod: 'datacenter-range',
        classification: 'informational',
        confidence: 0.4,
        reason: `IP ${request.sourceIp} is within a published cloud-provider IP range`,
      };
    }

    // Check for suspicious header patterns
    const headerResult = this.checkSuspiciousHeaders(request.headers || {});
    if (headerResult.detected) {
      return headerResult;
    }

    // No anonymization detected
    return {
      detected: false,
      classification: 'informational',
      confidence: 0.0,
    };
  }

  private isTorExitNode(ip: string): boolean {
    return this.config.knownTorExitNodes.includes(ip);
  }

  private isKnownProxy(ip: string): boolean {
    return this.config.knownProxyIps.includes(ip);
  }

  private isDatacenterRange(ip: string): boolean {
    return this.config.knownDatacenterRanges.some((cidr) => cidrContains(cidr, ip));
  }

  private hasVpnSignature(userAgent: string): boolean {
    const vpnSignatures = [
      'tor',
      'vpn',
      'proxy',
      'anonymizer',
      'psiphon',
      'windscribe',
      'expressvpn',
      'nordvpn',
      'surfshark',
    ];

    const lowerUA = userAgent.toLowerCase();
    return vpnSignatures.some((sig) => lowerUA.includes(sig));
  }

  private checkSuspiciousHeaders(headers: Record<string, string>): DetectionResult {
    // Check for X-Forwarded-For chains (proxy stacking)
    const xForwardedFor = headers['x-forwarded-for'];
    if (xForwardedFor && xForwardedFor.split(',').length > 3) {
      return {
        detected: true,
        detectionMethod: 'proxy-stacking',
        classification: 'suspicious',
        confidence: 0.7,
        reason: 'X-Forwarded-For contains chain of multiple proxies',
      };
    }

    // Check for unusual accept-language encoding (often Tor)
    const acceptLanguage = headers['accept-language'];
    if (acceptLanguage && acceptLanguage === 'en-US,en;q=0.9') {
      // Tor Browser's default; exact match is suspicious
      return {
        detected: true,
        detectionMethod: 'tor-browser-fingerprint',
        classification: 'suspicious',
        confidence: 0.6,
        reason: 'Accept-Language matches Tor Browser default fingerprint',
      };
    }

    return {
      detected: false,
      classification: 'informational',
      confidence: 0.0,
    };
  }

  /**
   * Determine action to take based on classification
   */
  getRecommendedAction(classification: 'informational' | 'suspicious' | 'hostile'): string {
    return this.config.responseActions[classification];
  }
}

/**
 * Pattern-based detection: track repeated requests from same anonymized source
 */
export class AnonymizedSourcePatternDetector {
  private sourcePatterns = new Map<string, { count: number; lastSeen: Date }>();

  constructor(
    private config: AnonymizedSourceDetectionConfig = DEFAULT_DETECTION_CONFIG,
    private timeWindowMs: number = 60000, // 1 minute
  ) {}

  /**
   * Record a request from an anonymized source
   */
  recordRequest(sourceIp: string): {
    isPattern: boolean;
    classification: 'suspicious' | 'hostile';
    requestCount: number;
  } {
    const now = new Date();
    const pattern = this.sourcePatterns.get(sourceIp);

    if (!pattern) {
      // First request from this source
      this.sourcePatterns.set(sourceIp, { count: 1, lastSeen: now });
      return { isPattern: false, classification: 'suspicious', requestCount: 1 };
    }

    // Check if still within time window
    const timeSinceLastRequest = now.getTime() - pattern.lastSeen.getTime();
    if (timeSinceLastRequest > this.timeWindowMs) {
      // Reset pattern
      this.sourcePatterns.set(sourceIp, { count: 1, lastSeen: now });
      return { isPattern: false, classification: 'suspicious', requestCount: 1 };
    }

    // Increment count
    pattern.count++;
    pattern.lastSeen = now;

    const isPattern = pattern.count >= this.config.classificationRules.patternDetectionThreshold;
    return {
      isPattern,
      classification: isPattern ? 'hostile' : 'suspicious',
      requestCount: pattern.count,
    };
  }

  /**
   * Clear old patterns (cleanup)
   */
  cleanup(): number {
    const now = new Date();
    let removed = 0;

    for (const [sourceIp, pattern] of this.sourcePatterns.entries()) {
      const timeSinceLastRequest = now.getTime() - pattern.lastSeen.getTime();
      if (timeSinceLastRequest > this.timeWindowMs * 5) {
        // 5x time window = definitely stale
        this.sourcePatterns.delete(sourceIp);
        removed++;
      }
    }

    return removed;
  }
}

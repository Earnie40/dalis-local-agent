import { scanForSecrets } from '@dacai-local-agent/security';
import {
  allowsPresentTense,
  framingFor,
  isPublishable,
  type Capability,
  type CapabilityStatus,
} from './capabilities.js';
import { PROHIBITED_DISTRIBUTION } from './sources.js';

/**
 * The overclaim guard.
 *
 * This runs on every draft before a human ever sees it, and it contains no
 * model. That is the whole design: asking a language model to check whether a
 * language model overclaimed is asking the same faculty to audit itself, and it
 * fails in exactly the cases that matter — fluent, confident, wrong.
 *
 * What it catches:
 *
 *   1. Present-tense assertion of a capability that is not at least a working
 *      prototype. "DACAIS operates autonomous aerospace systems" when aerospace
 *      is HORIZON.
 *   2. Any reference to an UNVERIFIED capability, which must not be published
 *      at all.
 *   3. Claims with no evidence behind them.
 *   4. Fabricated-looking metrics — numbers that appear in the draft but not in
 *      the measured metric set.
 *   5. Secrets that survived into the text.
 *   6. Language describing a prohibited distribution practice.
 *
 * A finding at `blocking` severity stops the draft. Nothing downstream may move
 * a blocked asset toward approval.
 */

export type RiskSeverity = 'blocking' | 'warning' | 'advisory';

export interface RiskFinding {
  severity: RiskSeverity;
  code:
    | 'present-tense-overclaim'
    | 'unverified-capability'
    | 'unsupported-claim'
    | 'unverified-metric'
    | 'secret-leak'
    | 'prohibited-practice'
    | 'missing-limitation';
  message: string;
  /** The exact text that triggered the finding, so a human can see it. */
  excerpt?: string;
  capabilitySlug?: string;
  /** Concrete correction, not just an objection. */
  remedy?: string;
}

export interface RiskCheckInput {
  body: string;
  title?: string;
  /** Capabilities the draft is permitted to reference, with their real status. */
  capabilities: readonly Capability[];
  /**
   * Claims the draft asserts, each with whether evidence was actually found.
   * A claim with supportingEvidenceCount 0 is unsupported regardless of how
   * confident the prose sounds.
   */
  claims?: ReadonlyArray<{ text: string; supportingEvidenceCount: number; capabilitySlug?: string }>;
  /** Numbers the metric engine actually measured. Anything else is suspect. */
  measuredMetrics?: ReadonlyArray<{ label: string; value: number | string }>;
}

export interface RiskReport {
  findings: RiskFinding[];
  blocked: boolean;
  /** Capability slugs the draft referenced, resolved from its text. */
  referencedCapabilities: string[];
}

/**
 * Verbs that assert a present, operational capability.
 *
 * The list is about *doing*, not about *being*: "DACAIS has an architecture for
 * X" is a claim about design and is fine at DESIGN_COMPLETE, while "DACAIS
 * operates X" is a claim about the world.
 */
const PRESENT_TENSE_VERBS = [
  'operates', 'operate', 'runs', 'run', 'controls', 'control', 'flies', 'fly',
  'powers', 'power', 'deploys', 'deploy', 'manages', 'manage', 'automates', 'automate',
  'delivers', 'deliver', 'provides', 'provide', 'handles', 'handle', 'monitors', 'monitor',
  'coordinates', 'coordinate', 'orchestrates', 'orchestrate', 'supports', 'support',
  'has deployed', 'have deployed', 'is deployed', 'are deployed', 'in production',
  'production-ready', 'battle-tested', 'proven in production',
];

/** Phrases that correctly frame something as not-yet-real. */
const INTENT_MARKERS = [
  'is developing', 'are developing', 'is building', 'are building', 'intended to',
  'designed to extend', 'working toward', 'working towards', 'plans to', 'planned',
  'roadmap', 'future', 'horizon', 'research', 'exploring', 'investigating',
  'would', 'could', 'aims to', 'intends to', 'prototype', 'in development',
  'not yet', 'does not yet', 'no production',
];

/** Superlatives that assert a market position the system cannot evidence. */
const UNSUPPORTABLE_SUPERLATIVES = [
  'the first', 'the only', 'the best', 'world-class', 'industry-leading',
  'unmatched', 'unrivaled', 'unrivalled', 'revolutionary', 'game-changing',
  'best-in-class', 'state-of-the-art', 'cutting-edge leader',
];

export class RiskGuard {
  check(input: RiskCheckInput): RiskReport {
    const findings: RiskFinding[] = [];
    const text = `${input.title ?? ''}\n${input.body}`;
    const lower = text.toLowerCase();
    const referenced: string[] = [];

    for (const capability of input.capabilities) {
      const mentions = findMentions(text, capability);
      if (!mentions.length) continue;
      referenced.push(capability.slug);

      if (!isPublishable(capability.status)) {
        findings.push({
          severity: 'blocking',
          code: 'unverified-capability',
          capabilitySlug: capability.slug,
          message:
            `The draft references "${capability.name}", whose status is UNVERIFIED. ` +
            'No evidence has been found for it, so it cannot appear in public content.',
          excerpt: mentions[0].sentence,
          remedy:
            `Either attach evidence for "${capability.slug}" and assign it a real status, or remove the reference.`,
        });
        continue;
      }

      if (allowsPresentTense(capability.status)) continue;

      // Below working-prototype: present-tense operational verbs are refused
      // unless the sentence also carries intent framing.
      for (const mention of mentions) {
        const sentence = mention.sentence.toLowerCase();
        const verb = PRESENT_TENSE_VERBS.find((candidate) => sentence.includes(` ${candidate} `) || sentence.includes(`${candidate} `));
        if (!verb) continue;
        if (INTENT_MARKERS.some((marker) => sentence.includes(marker))) continue;

        const framing = framingFor(capability.status);
        findings.push({
          severity: 'blocking',
          code: 'present-tense-overclaim',
          capabilitySlug: capability.slug,
          message:
            `"${capability.name}" is ${capability.status}, but the draft describes it in the present tense ` +
            `("${verb}"). ${framing.guidance}`,
          excerpt: mention.sentence.trim().slice(0, 300),
          remedy: `Rewrite as: DACAIS ${framing.exampleVerb} ${capability.name.toLowerCase()}.`,
        });
      }
    }

    for (const claim of input.claims ?? []) {
      if (claim.supportingEvidenceCount > 0) continue;
      findings.push({
        severity: 'blocking',
        code: 'unsupported-claim',
        capabilitySlug: claim.capabilitySlug,
        message: 'A claim in this draft has no supporting evidence on record.',
        excerpt: claim.text.slice(0, 300),
        remedy: 'Attach evidence (a source symbol, test, benchmark, or document) or remove the claim.',
      });
    }

    findings.push(...this.checkNumbers(input));

    const secrets = scanForSecrets(text);
    if (secrets.length) {
      findings.push({
        severity: 'blocking',
        code: 'secret-leak',
        message: `${secrets.length} possible secret(s) detected in the draft text.`,
        remedy: 'Remove the credential material. Never publish a draft that tripped this check.',
      });
    }

    for (const practice of PROHIBITED_DISTRIBUTION) {
      if (lower.includes(practice.toLowerCase())) {
        findings.push({
          severity: 'warning',
          code: 'prohibited-practice',
          message: `The draft mentions "${practice}", which this system must never perform.`,
          remedy: 'If this is describing what DACAIS does NOT do, that is fine. If it is a plan, it is refused.',
        });
      }
    }

    for (const superlative of UNSUPPORTABLE_SUPERLATIVES) {
      if (!lower.includes(superlative)) continue;
      findings.push({
        severity: 'warning',
        code: 'unsupported-claim',
        message: `"${superlative}" asserts a market position this system has no evidence for.`,
        excerpt: sentenceContaining(text, superlative)?.slice(0, 300),
        remedy: 'State what the system actually does and let the reader draw the comparison.',
      });
    }

    // A draft that touches a horizon-stage area should say what does not exist
    // yet. Advisory rather than blocking: an architecture post need not carry a
    // disclaimer in every paragraph.
    const horizonReferenced = input.capabilities.filter(
      (capability) => referenced.includes(capability.slug) && isHorizonStage(capability.status),
    );
    if (horizonReferenced.length && !INTENT_MARKERS.some((marker) => lower.includes(marker))) {
      findings.push({
        severity: 'advisory',
        code: 'missing-limitation',
        message:
          `The draft references ${horizonReferenced.map((c) => c.name).join(', ')}, which ` +
          'are direction rather than current capability, but states no limitation.',
        remedy: 'Add one sentence naming what does not exist yet. It costs credibility to omit and buys it to include.',
      });
    }

    return {
      findings,
      blocked: findings.some((finding) => finding.severity === 'blocking'),
      referencedCapabilities: [...new Set(referenced)],
    };
  }

  /**
   * Numbers in the draft that the metric engine did not measure.
   *
   * Deliberately narrow: only figures shaped like performance claims (percent,
   * multiplier, latency, throughput, counts with a unit) are checked, because
   * flagging every "5" in prose would train the operator to ignore this.
   */
  private checkNumbers(input: RiskCheckInput): RiskFinding[] {
    const measured = new Set(
      (input.measuredMetrics ?? []).map((metric) => String(metric.value).toLowerCase().trim()),
    );
    const findings: RiskFinding[] = [];
    const seen = new Set<string>();

    const patterns = [
      /\b\d+(?:\.\d+)?\s*%/g,
      /\b\d+(?:\.\d+)?\s*x\b/gi,
      /\b\d+(?:\.\d+)?\s*(?:ms|milliseconds|seconds|s|minutes)\b/gi,
      /\b\d+(?:\.\d+)?\s*(?:tokens\/s|tokens per second|req\/s|rps|qps)\b/gi,
      /\b\d{2,}\s*(?:tests|users|customers|deployments|workflows|agents)\b/gi,
    ];

    for (const pattern of patterns) {
      for (const match of input.body.matchAll(pattern)) {
        const raw = match[0].toLowerCase().trim();
        const numeric = raw.replace(/[^\d.]/g, '');
        if (seen.has(raw)) continue;
        seen.add(raw);
        if (measured.has(raw) || measured.has(numeric)) continue;

        findings.push({
          severity: 'blocking',
          code: 'unverified-metric',
          message:
            `The draft states "${match[0].trim()}", which does not correspond to any measured metric on record.`,
          excerpt: sentenceContaining(input.body, match[0])?.slice(0, 300),
          remedy:
            'Measure it and record it in metric_registry, or remove the number. ' +
            'An unmeasured figure in published content is a fabrication.',
        });
      }
    }

    return findings;
  }
}

interface Mention {
  sentence: string;
  index: number;
}

/**
 * Sentences that mention a capability, by name or by a distinctive token of it.
 *
 * Whole-word matching on tokens of four characters or more: matching on "AI"
 * or "the" would attach every capability to every sentence.
 */
function findMentions(text: string, capability: Capability): Mention[] {
  const needles = [
    capability.name.toLowerCase(),
    ...capability.name.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 4),
  ];
  const unique = [...new Set(needles)];
  const sentences = splitSentences(text);

  return sentences.flatMap((sentence, index) => {
    const lower = sentence.toLowerCase();
    const hit = unique.some((needle) =>
      new RegExp(`\\b${escapeRegExp(needle)}\\b`).test(lower),
    );
    return hit ? [{ sentence, index }] : [];
  });
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function sentenceContaining(text: string, needle: string): string | undefined {
  const lower = needle.toLowerCase();
  return splitSentences(text).find((sentence) => sentence.toLowerCase().includes(lower));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isHorizonStage(status: CapabilityStatus): boolean {
  return status === 'HORIZON' || status === 'RESEARCH' || status === 'DESIGN_COMPLETE';
}

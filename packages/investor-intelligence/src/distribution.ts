import { createId, getPool } from '@dacai-local-agent/shared';
import { PROHIBITED_DISTRIBUTION } from './sources.js';
import type { AssetType } from './opportunity.js';

/**
 * Channel intelligence.
 *
 * The question this module answers is "where does this content genuinely
 * belong", and the question it refuses to answer is "where can we post this".
 * Those produce different systems: the first ranks channels by whether the
 * audience would actually want the piece, the second ranks by reach.
 *
 * Community norms are stored per channel and surfaced with every
 * recommendation, because the failure mode for a technical founder is not
 * malice — it is posting a company update to a community that only wanted
 * technical substance, and burning the channel permanently.
 */

export type ChannelType =
  | 'owned_website'
  | 'owned_blog'
  | 'founder_social'
  | 'company_social'
  | 'code_host'
  | 'video_platform'
  | 'aggregator'
  | 'community_forum'
  | 'newsletter'
  | 'press';

export interface Channel {
  id: string;
  slug: string;
  name: string;
  channelType: ChannelType;
  url?: string;
  audience?: string;
  fitNotes?: string;
  norms?: string;
  publishingEnabled: boolean;
  enabled: boolean;
}

export class DistributionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DistributionError';
  }
}

/**
 * Default channels.
 *
 * Owned channels first, deliberately. A company's own site and repository are
 * where content should live; third-party communities are where a link to it may
 * sometimes be welcome. Reversing that order is how organizations end up
 * spamming.
 */
export const DEFAULT_CHANNELS: ReadonlyArray<Omit<Channel, 'id'>> = [
  {
    slug: 'dacais-website',
    name: 'DACAIS website',
    channelType: 'owned_website',
    audience: 'Prospective customers, partners, and investors evaluating the company.',
    fitNotes: 'Canonical home for positioning, product description, and architecture explainers.',
    norms: 'Owned surface. Substance over volume; every claim here is quotable back at you.',
    publishingEnabled: false,
    enabled: true,
  },
  {
    slug: 'founder-linkedin',
    name: 'Founder LinkedIn',
    channelType: 'founder_social',
    audience: 'Operators, investors, and technical peers who follow the founder personally.',
    fitNotes:
      'First-person accounts of building something specific. Works when it reads as a person thinking out ' +
      'loud, fails when it reads as marketing.',
    norms:
      'No engagement bait, no manufactured contrarianism. One genuine post beats five scheduled ones. ' +
      'Do not tag people to force visibility.',
    publishingEnabled: false,
    enabled: true,
  },
  {
    slug: 'dacais-linkedin',
    name: 'DACAIS company LinkedIn',
    channelType: 'company_social',
    audience: 'Followers of the company; a broader, less technical audience.',
    fitNotes: 'Milestones, releases, and explainers written for a mixed audience.',
    norms: 'Company voice. Announce things that actually happened.',
    publishingEnabled: false,
    enabled: true,
  },
  {
    slug: 'github',
    name: 'GitHub',
    channelType: 'code_host',
    audience: 'Engineers evaluating the work directly.',
    fitNotes:
      'READMEs, architecture docs, and project descriptions. The highest-credibility channel available, ' +
      'because the reader can check the claims against the code.',
    norms: 'Accuracy is enforced by the audience. Do not describe capabilities the repository does not contain.',
    publishingEnabled: false,
    enabled: true,
  },
  {
    slug: 'technical-blog',
    name: 'DACAIS technical blog',
    channelType: 'owned_blog',
    audience: 'Engineers and technical decision-makers.',
    fitNotes: 'Long-form architecture and engineering writing where the detail is the value.',
    norms: 'Depth is the point. A post with no specifics is worse than no post.',
    publishingEnabled: false,
    enabled: true,
  },
  {
    slug: 'youtube',
    name: 'YouTube',
    channelType: 'video_platform',
    audience: 'People who want to see the software actually run.',
    fitNotes: 'Demos of working software, architecture walkthroughs.',
    norms: 'Show real runs. An edited reconstruction presented as a live demo is a fabrication.',
    publishingEnabled: false,
    enabled: true,
  },
  {
    slug: 'hacker-news',
    name: 'Hacker News',
    channelType: 'aggregator',
    audience: 'Broad technical readership, highly skeptical of marketing.',
    fitNotes:
      'Only genuinely substantive technical writing. Submit the artifact, not a pitch — and expect the ' +
      'comments to find every weak claim.',
    norms:
      'No vote manipulation, no coordinated submission, no sockpuppet accounts. Disclose affiliation. ' +
      'Submitting your own work is fine; pretending it is not yours is not.',
    publishingEnabled: false,
    enabled: true,
  },
  {
    slug: 'technical-communities',
    name: 'Topic-specific technical communities',
    channelType: 'community_forum',
    audience: 'Practitioners in a specific technical domain.',
    fitNotes: 'Participate where the work is genuinely relevant to an ongoing conversation.',
    norms:
      'Read the room before posting. Contribute more than you promote. Never cross-post the same text ' +
      'across communities — that is spam regardless of intent.',
    publishingEnabled: false,
    enabled: true,
  },
];

/** Which asset types are a natural fit for which channel types. */
const ASSET_CHANNEL_FIT: Record<AssetType, ChannelType[]> = {
  linkedin_founder_post: ['founder_social'],
  linkedin_company_post: ['company_social'],
  technical_essay: ['owned_blog', 'aggregator', 'community_forum'],
  short_technical_update: ['founder_social', 'company_social'],
  demo_description: ['video_platform', 'owned_website', 'code_host'],
  video_script: ['video_platform'],
  github_project_description: ['code_host'],
  architecture_explainer: ['owned_blog', 'code_host', 'owned_website'],
  visual_caption: ['founder_social', 'company_social'],
  founder_essay: ['owned_blog', 'founder_social'],
  faq: ['owned_website'],
  press_note: ['press', 'owned_website'],
};

export interface ChannelRecommendation {
  channel: Channel;
  fit: 'natural' | 'plausible' | 'poor';
  reasoning: string;
  cautions: string[];
}

export class DistributionAgent {
  /**
   * Ranks channels for one asset.
   *
   * Returns reasoning per channel rather than a single answer, because the
   * operator knows things this system does not — which communities they are
   * already a member of, what they posted last week.
   */
  recommend(input: {
    assetType: AssetType;
    channels: readonly Channel[];
    isTechnicallySubstantive: boolean;
    hasDemonstrableCapability: boolean;
  }): ChannelRecommendation[] {
    const preferred = new Set(ASSET_CHANNEL_FIT[input.assetType] ?? []);

    return input.channels
      .filter((channel) => channel.enabled)
      .map((channel) => {
        const cautions: string[] = [];
        let fit: ChannelRecommendation['fit'] = preferred.has(channel.channelType) ? 'natural' : 'poor';
        let reasoning: string;

        if (fit === 'natural') {
          reasoning = `${channel.name} is a natural home for a ${humanize(input.assetType)}: ${channel.fitNotes ?? ''}`.trim();
        } else if (channel.channelType === 'owned_website' || channel.channelType === 'owned_blog') {
          // Owned surfaces are always at least plausible: it is your own site.
          fit = 'plausible';
          reasoning = `${channel.name} is an owned surface, so publishing here carries no community-norm risk.`;
        } else {
          reasoning = `${channel.name} does not naturally host a ${humanize(input.assetType)}.`;
        }

        if (channel.channelType === 'aggregator' && !input.isTechnicallySubstantive) {
          fit = 'poor';
          cautions.push(
            'This audience penalizes anything that reads as promotion. Without real technical substance, ' +
              'posting here damages standing rather than building it.',
          );
        }

        if (channel.channelType === 'community_forum') {
          cautions.push(
            'Only post if this is genuinely relevant to an existing conversation there, and disclose your affiliation.',
          );
        }

        if (channel.channelType === 'video_platform' && !input.hasDemonstrableCapability) {
          fit = 'poor';
          cautions.push('Nothing here is demonstrable today, so there is nothing honest to record.');
        }

        if (channel.norms) cautions.push(channel.norms);

        return { channel, fit, reasoning, cautions };
      })
      .sort((a, b) => rank(a.fit) - rank(b.fit));
  }

  /**
   * Fails closed on any prohibited practice.
   *
   * Called before an export or a publish. The check is a string match against a
   * fixed list rather than a model judgement, so it cannot be talked out of a
   * refusal.
   */
  assertPermittedPractice(description: string): void {
    const lower = description.toLowerCase();
    for (const practice of PROHIBITED_DISTRIBUTION) {
      if (lower.includes(practice.toLowerCase())) {
        throw new DistributionError(
          `Refusing a distribution plan describing "${practice}". ` +
            'This system builds discoverability through substantive public work; it does not manufacture ' +
            'attention or simulate independent voices.',
        );
      }
    }
  }
}

function rank(fit: ChannelRecommendation['fit']): number {
  return fit === 'natural' ? 0 : fit === 'plausible' ? 1 : 2;
}

function humanize(value: string): string {
  return value.replace(/_/g, ' ');
}

export class ChannelStore {
  async seedDefaults(): Promise<number> {
    let created = 0;
    for (const channel of DEFAULT_CHANNELS) {
      const { rowCount } = await getPool().query(
        `INSERT INTO distribution_channels
           (id, slug, name, channel_type, url, audience, fit_notes, norms, publishing_enabled, enabled)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (slug) DO NOTHING`,
        [
          createId('chn'), channel.slug, channel.name, channel.channelType,
          channel.url ?? null, channel.audience ?? null, channel.fitNotes ?? null,
          channel.norms ?? null, false, channel.enabled,
        ],
      );
      created += rowCount ?? 0;
    }
    return created;
  }

  async list(): Promise<Channel[]> {
    const { rows } = await getPool().query(
      'SELECT * FROM distribution_channels ORDER BY channel_type, name',
    );
    return rows.map((row) => ({
      id: String(row.id),
      slug: String(row.slug),
      name: String(row.name),
      channelType: String(row.channel_type) as ChannelType,
      url: (row.url as string | null) ?? undefined,
      audience: (row.audience as string | null) ?? undefined,
      fitNotes: (row.fit_notes as string | null) ?? undefined,
      norms: (row.norms as string | null) ?? undefined,
      publishingEnabled: Boolean(row.publishing_enabled),
      enabled: Boolean(row.enabled),
    }));
  }
}

/**
 * Whether real publishing is permitted at all.
 *
 * Two independent conditions: a global feature flag that is off by default, and
 * a per-channel flag. Both must be true. The database additionally refuses to
 * mark anything PUBLISHED without a named human approver, so this is the third
 * of three independent controls.
 */
export function publishingEnabled(channel: Channel, env: NodeJS.ProcessEnv = process.env): boolean {
  const globalFlag = env.INTELLIGENCE_PUBLISHING_ENABLED?.toLowerCase();
  return (globalFlag === 'true' || globalFlag === '1') && channel.publishingEnabled;
}

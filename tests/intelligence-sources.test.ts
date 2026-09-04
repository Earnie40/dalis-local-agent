import { describe, expect, it } from 'vitest';
import {
  admitSource,
  assertProfessionalQuery,
  assertPublicSourceUrl,
  assertResearchableSubject,
  isPublicSourceKind,
  SourcePolicyError,
} from '@dacai-local-agent/investor-intelligence';

describe('investor-intelligence collection policy', () => {
  it('accepts a plausible public HTTPS source', () => {
    const url = assertPublicSourceUrl('https://future.ventures/team');
    expect(url.hostname).toBe('future.ventures');
  });

  it('refuses a non-HTTPS URL', () => {
    expect(() => assertPublicSourceUrl('http://future.ventures/team')).toThrow(SourcePolicyError);
  });

  it('refuses a URL carrying credentials', () => {
    expect(() => assertPublicSourceUrl('https://user:pass@future.ventures/')).toThrow(/credentials/);
  });

  it('refuses localhost and internal hosts', () => {
    expect(() => assertPublicSourceUrl('https://localhost/x')).toThrow(SourcePolicyError);
    expect(() => assertPublicSourceUrl('https://svc.internal/x')).toThrow(SourcePolicyError);
  });

  it('refuses known personal-data-broker hosts', () => {
    expect(() => assertPublicSourceUrl('https://www.spokeo.com/John-Smith')).toThrow(/personal-data broker/);
    expect(() => assertPublicSourceUrl('https://rocketreach.co/john-smith')).toThrow(/contact-data broker/);
  });

  it('refuses authenticated-surface paths (login, messaging, private groups)', () => {
    expect(() => assertPublicSourceUrl('https://example.com/login')).toThrow(/authentication endpoint/);
    expect(() => assertPublicSourceUrl('https://example.com/messages/inbox')).toThrow(/messaging surface/);
    expect(() => assertPublicSourceUrl('https://example.com/groups/abc/members')).toThrow(/private group/);
  });

  it('accepts only the enumerated public source kinds', () => {
    expect(isPublicSourceKind('public_blog')).toBe(true);
    expect(isPublicSourceKind('private_group')).toBe(false);
    expect(isPublicSourceKind('leaked_database')).toBe(false);
  });

  it('admitSource refuses a source with no license', () => {
    expect(() =>
      admitSource({ url: 'https://example.com/a', kind: 'public_blog', license: '' }),
    ).toThrow(SourcePolicyError);
  });

  it('admitSource refuses an unrecognized source kind even with a valid URL and license', () => {
    expect(() =>
      admitSource({ url: 'https://example.com/a', kind: 'private_forum', license: 'CC' }),
    ).toThrow(/not an enumerated public source/);
  });

  it('admitSource normalizes a URL by stripping its fragment', () => {
    const admitted = admitSource({
      url: 'https://example.com/a?x=1#section-2',
      kind: 'public_blog',
      license: 'CC',
    });
    expect(admitted.url).toBe('https://example.com/a?x=1');
  });

  it('refuses to research a private individual', () => {
    expect(() =>
      assertResearchableSubject({ displayName: 'Jane Doe', entityType: 'person', isPublicProfessional: false }),
    ).toThrow(/not marked as a public professional entity/);
  });

  it('allows researching an entity marked public-professional', () => {
    expect(() =>
      assertResearchableSubject({ displayName: 'Jane Doe', entityType: 'person', isPublicProfessional: true }),
    ).not.toThrow();
  });

  it('refuses a research query seeking personal contact details, location, or private circumstances', () => {
    expect(() => assertProfessionalQuery('what is their home address')).toThrow(/personal contact details/);
    expect(() => assertProfessionalQuery('where does she live')).toThrow(/residence lookup/);
    expect(() => assertProfessionalQuery('their net worth and divorce')).toThrow(/private personal circumstances/);
    expect(() => assertProfessionalQuery('daily routine and whereabouts')).toThrow(/location tracking/);
  });

  it('allows a professional-activity research query', () => {
    expect(assertProfessionalQuery('Future Ventures investment thesis')).toBe('Future Ventures investment thesis');
  });

  it('refuses an empty or oversized query', () => {
    expect(() => assertProfessionalQuery('   ')).toThrow(SourcePolicyError);
    expect(() => assertProfessionalQuery('x'.repeat(400))).toThrow(/300 characters/);
  });
});

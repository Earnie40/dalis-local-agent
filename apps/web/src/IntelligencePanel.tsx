import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  intelligenceApi,
  type AnalyticsEvidence,
  type Brief,
  type Capability,
  type CoInvestorSummary,
  type CompanyInvestor,
  type ContentAsset,
  type ContentAuditRow,
  type DiligenceSession,
  type EvidenceGap,
  type FundingRoundDetail,
  type FundingRoundSummary,
  type GraphEdgeRow,
  type InvestmentNeighborhood,
  type InvestmentTimelineEvent,
  type InvestorFitScore,
  type MetricRecord,
  type OpportunityRecord,
  type Overview,
  type PortfolioEntry,
  type RichRelationship,
  type SectorProfile,
  type SignalRow,
  type ThemeStrength,
} from './intelligence-api';
import { useStickToBottom } from './use-stick-to-bottom';

type Tab = 'overview' | 'entities' | 'opportunities' | 'evidence' | 'content' | 'diligence' | 'brief';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'entities', label: 'Entities' },
  { id: 'opportunities', label: 'Opportunities' },
  { id: 'evidence', label: 'Evidence' },
  { id: 'content', label: 'Content' },
  { id: 'diligence', label: 'Diligence' },
  { id: 'brief', label: 'Daily Brief' },
];

function useAsync<T>(loader: () => Promise<T>, deps: unknown[]): [T | undefined, boolean, string | undefined, () => void] {
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    loader()
      .then((result) => { if (!cancelled) setData(result); })
      .catch((e) => { if (!cancelled) setError(String(e instanceof Error ? e.message : e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // `deps` and `tick` are the intentional dependency list; `loader` is
    // deliberately excluded because callers pass a fresh closure each render.
  }, [...deps, tick]);

  return [data, loading, error, () => setTick((value) => value + 1)];
}

function statusBadgeClass(status: string): string {
  if (status === 'PRODUCTION' || status === 'WORKING_PROTOTYPE' || status === 'MEASURED' || status === 'STRONG') return 'ok';
  if (status === 'UNVERIFIED' || status === 'DANGEROUS' || status === 'UNSUPPORTED') return 'danger';
  return 'warn';
}

export function IntelligencePanel() {
  const [tab, setTab] = useState<Tab>('overview');
  const [selectedEntityId, setSelectedEntityId] = useState<string | undefined>(undefined);
  const [selectedOpportunityId, setSelectedOpportunityId] = useState<string | undefined>(undefined);
  const [selectedContentId, setSelectedContentId] = useState<string | undefined>(undefined);
  const bodyScroll = useStickToBottom<HTMLDivElement>([tab, selectedEntityId, selectedOpportunityId, selectedContentId]);

  return (
    <div className="intelligence">
      <nav className="intel-tabs">
        {TABS.map((item) => (
          <button
            key={item.id}
            className={tab === item.id ? 'active' : ''}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div className="intel-body" ref={bodyScroll.ref} onScroll={bodyScroll.onScroll}>
        {tab === 'overview' && <OverviewView />}
        {tab === 'entities' && (
          <EntitiesView selectedId={selectedEntityId} onSelect={setSelectedEntityId} />
        )}
        {tab === 'opportunities' && (
          <OpportunitiesView selectedId={selectedOpportunityId} onSelect={setSelectedOpportunityId} onOpenContent={(id) => { setSelectedContentId(id); setTab('content'); }} />
        )}
        {tab === 'evidence' && <EvidenceView />}
        {tab === 'content' && <ContentView selectedId={selectedContentId} onSelect={setSelectedContentId} />}
        {tab === 'diligence' && <DiligenceView />}
        {tab === 'brief' && <BriefView />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function OverviewView() {
  const [overview, loading, error] = useAsync<Overview>(() => intelligenceApi.overview(), []);
  const [providers] = useAsync(() => intelligenceApi.providers(), []);
  const [policy] = useAsync(() => intelligenceApi.policy(), []);

  if (loading) return <p className="muted">Loading overview…</p>;
  if (error) return <p className="error">{error}</p>;
  if (!overview) return null;

  return (
    <div className="intel-stack">
      <div className="intel-grid">
        <StatCard label="Entities tracked" value={overview.entitiesTracked} />
        <StatCard label="Capabilities publishable" value={`${overview.capabilities.publishable} / ${overview.capabilities.total}`} />
        <StatCard label="High-confidence opportunities" value={`${overview.opportunities.highConfidence} / ${overview.opportunities.total}`} />
        <StatCard label="Drafts awaiting review" value={overview.draftsAwaitingReview} />
        <StatCard label="Evidence gaps" value={overview.evidenceGaps} warn={overview.evidenceGaps > 0} />
        <StatCard label="Metrics measured" value={`${overview.metrics.measured} / ${overview.metrics.measured + overview.metrics.needsMeasurement}`} />
      </div>

      <section className="intel-card">
        <h3>Research providers</h3>
        <table className="intel-table">
          <tbody>
            {providers?.providers.map((provider) => (
              <tr key={provider.id}>
                <td>{provider.id}</td>
                <td>
                  <span className={`badge ${provider.available ? 'ok' : 'warn'}`}>
                    {provider.available ? 'available' : 'not configured'}
                  </span>
                </td>
                <td className="muted small">{provider.reason ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {policy && (
        <section className="intel-card">
          <h3>Collection policy</h3>
          <pre className="intel-pre">{policy.policy}</pre>
        </section>
      )}
    </div>
  );
}

function StatCard({ label, value, warn }: { label: string; value: string | number; warn?: boolean }) {
  return (
    <div className={`intel-stat ${warn ? 'warn' : ''}`}>
      <div className="intel-stat-value">{value}</div>
      <div className="intel-stat-label">{label}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

function EntitiesView({ selectedId, onSelect }: { selectedId?: string; onSelect: (id: string | undefined) => void }) {
  const [list, loading, error, refresh] = useAsync(() => intelligenceApi.listEntities(), []);
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div className="intel-columns">
      <div className="intel-column">
        <div className="intel-row-between">
          <h3>Entities</h3>
          <button className="small" onClick={() => setShowCreate((v) => !v)}>{showCreate ? 'Cancel' : '+ Add'}</button>
        </div>
        {showCreate && <CreateEntityForm onCreated={() => { setShowCreate(false); refresh(); }} />}
        {loading && <p className="muted">Loading…</p>}
        {error && <p className="error">{error}</p>}
        <ul className="intel-list">
          {list?.entities.map((entity) => (
            <li key={entity.id}>
              <button className={selectedId === entity.id ? 'active' : ''} onClick={() => onSelect(entity.id)}>
                <strong>{entity.displayName}</strong>
                <span className="muted small">{entity.entityType.replace(/_/g, ' ')}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="intel-column wide">
        {selectedId ? <EntityDetail id={selectedId} onNavigate={onSelect} /> : <p className="muted">Select an entity.</p>}
      </div>
    </div>
  );
}

function CreateEntityForm({ onCreated }: { onCreated: () => void }) {
  const [displayName, setDisplayName] = useState('');
  const [entityType, setEntityType] = useState('investment_firm');
  const [primaryUrl, setPrimaryUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const submit = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    if (!displayName.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      await intelligenceApi.createEntity({ displayName, entityType, primaryUrl: primaryUrl || undefined });
      onCreated();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }, [displayName, entityType, primaryUrl, onCreated]);

  return (
    <form className="intel-form" onSubmit={submit}>
      <input placeholder="Display name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      <select value={entityType} onChange={(e) => setEntityType(e.target.value)}>
        <option value="investment_firm">Investment firm</option>
        <option value="person">Person</option>
        <option value="portfolio_company">Portfolio company</option>
        <option value="strategic_company">Strategic company</option>
        <option value="organization">Organization</option>
        <option value="community">Community</option>
        <option value="publication">Publication</option>
        <option value="conference">Conference</option>
        <option value="government_body">Government body</option>
      </select>
      <input placeholder="Primary URL (https://…)" value={primaryUrl} onChange={(e) => setPrimaryUrl(e.target.value)} />
      <button type="submit" className="primary small" disabled={busy || !displayName.trim()}>Create</button>
      {error && <p className="error small">{error}</p>}
    </form>
  );
}

type EntityTab = 'overview' | 'activity' | 'network' | 'sectors' | 'timeline' | 'relationships' | 'fit';

const ENTITY_TABS: Array<{ id: EntityTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'activity', label: 'Portfolio & rounds' },
  { id: 'network', label: 'Network' },
  { id: 'sectors', label: 'Sector profile' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'relationships', label: 'Relationships & evidence' },
  { id: 'fit', label: 'Investor fit' },
];

function EntityDetail({ id, onNavigate }: { id: string; onNavigate: (id: string | undefined) => void }) {
  const [detail, loading, error, refresh] = useAsync(() => intelligenceApi.getEntity(id), [id]);
  const [signals] = useAsync(() => intelligenceApi.entitySignals(id, 90), [id]);
  const [busy, setBusy] = useState<string | undefined>();
  const [log, setLog] = useState<string[]>([]);
  const [entityTab, setEntityTab] = useState<EntityTab>('overview');

  useEffect(() => {
    setEntityTab('overview');
    setLog([]);
  }, [id]);

  const run = useCallback(async (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    try {
      const result = await action();
      setLog((current) => [`${label}: ${JSON.stringify(result).slice(0, 300)}`, ...current].slice(0, 8));
      refresh();
    } catch (e) {
      setLog((current) => [`${label} FAILED: ${String(e instanceof Error ? e.message : e)}`, ...current].slice(0, 8));
    } finally {
      setBusy(undefined);
    }
  }, [id, refresh]);

  if (loading) return <p className="muted">Loading…</p>;
  if (error) return <p className="error">{error}</p>;
  if (!detail) return null;

  const supportsFit = isFitCompany(detail.entity.entityType);
  const visibleTabs = ENTITY_TABS.filter((tab) => tab.id !== 'fit' || supportsFit);

  return (
    <div className="intel-stack">
      <div className="intel-row-between">
        <h2>{detail.entity.displayName}</h2>
        <span className="badge">{detail.entity.entityType.replace(/_/g, ' ')}</span>
      </div>
      {detail.entity.professionalSummary && <p className="muted">{detail.entity.professionalSummary}</p>}
      {detail.entity.primaryUrl && (
        <a className="muted small" href={detail.entity.primaryUrl} target="_blank" rel="noreferrer">
          {detail.entity.primaryUrl}
        </a>
      )}

      <div className="intel-actions-row">
        <button disabled={!!busy} onClick={() => run('collect', () => intelligenceApi.collect(id))}>
          {busy === 'collect' ? 'Collecting…' : 'Collect public signals'}
        </button>
        <button disabled={!!busy} onClick={() => run('extract-themes', () => intelligenceApi.extractThemes(id))}>
          {busy === 'extract-themes' ? 'Extracting…' : 'Extract themes'}
        </button>
        <button disabled={!!busy} onClick={() => run('extract-investments', () => intelligenceApi.extractInvestments(id))}>
          {busy === 'extract-investments' ? 'Extracting VC facts…' : 'Extract VC facts'}
        </button>
        <button disabled={!!busy} onClick={() => run('build-graph', () => intelligenceApi.buildGraph(id))}>
          {busy === 'build-graph' ? 'Building…' : 'Build graph'}
        </button>
        <button disabled={!!busy} onClick={() => run('find-opportunities', () => intelligenceApi.findOpportunities(id))}>
          {busy === 'find-opportunities' ? 'Scoring…' : 'Find opportunities'}
        </button>
      </div>

      {log.length > 0 && (
        <div className="intel-card">
          <h4>Pipeline log</h4>
          {log.map((line, index) => <div key={index} className="intel-log-line">{line}</div>)}
        </div>
      )}

      <nav className="intel-entity-tabs" aria-label={`${detail.entity.displayName} intelligence views`}>
        {visibleTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={entityTab === tab.id ? 'active' : ''}
            onClick={() => setEntityTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {entityTab === 'overview' && (
        <EntityOverview
          themes={detail.themes}
          relationships={detail.relationships}
          signals={signals?.signals ?? []}
        />
      )}
      {entityTab === 'activity' && (
        <InvestmentActivityView id={id} entityType={detail.entity.entityType} />
      )}
      {entityTab === 'network' && (
        <InvestmentNetworkView id={id} entityType={detail.entity.entityType} onNavigate={onNavigate} />
      )}
      {entityTab === 'sectors' && <SectorProfileView id={id} />}
      {entityTab === 'timeline' && <InvestmentTimelineView id={id} />}
      {entityTab === 'relationships' && <RichRelationshipsView id={id} />}
      {entityTab === 'fit' && supportsFit && <InvestorFitView companyId={id} />}
    </div>
  );
}

function EntityOverview({
  themes,
  relationships,
  signals,
}: {
  themes: ThemeStrength[];
  relationships: GraphEdgeRow[];
  signals: SignalRow[];
}) {
  return (
    <div className="intel-stack">

      <section className="intel-card">
        <h3>Current Themes</h3>
        {!themes.length && <p className="muted">No themes yet. Collect signals and extract themes.</p>}
        <div className="intel-table-scroll">
          <table className="intel-table">
            <thead><tr><th>Theme</th><th>Importance</th><th>Decay</th><th>Signals</th><th>Sources</th></tr></thead>
            <tbody>
              {themes.map((theme) => (
                <tr key={theme.id}>
                  <td>{theme.label}</td>
                  <td>{theme.importance.toFixed(2)}</td>
                  <td>{theme.timeDecay.toFixed(2)}</td>
                  <td>{theme.signalCount}</td>
                  <td>{theme.sourceCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="intel-card">
        <h3>Recent Signals</h3>
        {!signals.length && <p className="muted">No signals collected yet.</p>}
        <ul className="intel-list plain">
          {signals.slice(0, 15).map((signal) => (
            <li key={signal.id}>
              <div className="intel-row-between">
                <a href={signal.sourceUrl} target="_blank" rel="noreferrer">{signal.title ?? signal.sourceUrl}</a>
                <span className="muted small">{signal.publishedAt?.slice(0, 10) ?? 'undated'}</span>
              </div>
              <p className="muted small">{signal.summary ?? signal.excerpt.slice(0, 200)}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="intel-card">
        <h3>Graph relationships</h3>
        {!relationships.length && <p className="muted">No relationships recorded yet.</p>}
        <div className="intel-table-scroll">
          <table className="intel-table">
            <thead><tr><th>Kind</th><th>Relationship</th><th>Target</th><th>Confidence</th><th>Sources</th></tr></thead>
            <tbody>
              {relationships.map((edge) => (
                <tr key={edge.id}>
                  <td><span className="badge">{humanize(edge.statementKind)}</span></td>
                  <td>{humanize(edge.relationship)}</td>
                  <td>{edge.targetLabel ?? '(unnamed)'}</td>
                  <td>{edge.confidence?.toFixed(2) ?? '—'}</td>
                  <td>{edge.sourceCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function InvestmentActivityView({ id, entityType }: { id: string; entityType: string }) {
  const [selectedRoundId, setSelectedRoundId] = useState<string | undefined>();
  const [data, loading, error] = useAsync(async () => {
    const [portfolio, rounds, investors] = await Promise.all([
      intelligenceApi.getPortfolio(id, { limit: 100 }),
      intelligenceApi.getFundingRounds(id, { limit: 100 }),
      isCompanyEntity(entityType)
        ? intelligenceApi.getCompanyInvestors(id, { limit: 100 })
        : Promise.resolve({ investors: [] as CompanyInvestor[] }),
    ]);
    return { portfolio: portfolio.portfolio, rounds: rounds.rounds, investors: investors.investors };
  }, [id, entityType]);

  if (loading) return <p className="muted">Loading investment activity…</p>;
  if (error) return <p className="error">{error}</p>;
  if (!data) return null;

  return (
    <div className="intel-stack">
      <section className="intel-card">
        <div className="intel-row-between">
          <h3>Portfolio</h3>
          <span className="muted small">{data.portfolio.length} compan{data.portfolio.length === 1 ? 'y' : 'ies'}</span>
        </div>
        {!data.portfolio.length && <p className="muted">No evidence-backed portfolio companies recorded.</p>}
        <div className="intel-table-scroll">
          <table className="intel-table">
            <thead><tr><th>Company</th><th>Rounds</th><th>First</th><th>Latest</th><th>Evidence</th></tr></thead>
            <tbody>
              {data.portfolio.map((entry: PortfolioEntry) => (
                <tr key={entry.company.id}>
                  <td>{entry.company.displayName}</td>
                  <td>{entry.roundCount}</td>
                  <td>{dateLabel(entry.firstInvestmentAt)}</td>
                  <td>{dateLabel(entry.lastInvestmentAt)}</td>
                  <td>{entry.evidence.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="intel-card">
        <div className="intel-row-between">
          <h3>Funding rounds</h3>
          <span className="muted small">{data.rounds.length} persisted</span>
        </div>
        {!data.rounds.length && <p className="muted">No funding rounds recorded for this entity.</p>}
        <div className="intel-table-scroll">
          <table className="intel-table">
            <thead><tr><th>Company</th><th>Round</th><th>Date</th><th>Amount</th><th>Role</th><th>Participants</th><th>Evidence</th></tr></thead>
            <tbody>
              {data.rounds.map((round: FundingRoundSummary) => (
                <tr key={round.id}>
                  <td>
                    <button className="intel-link-button" type="button" onClick={() => setSelectedRoundId(round.id)}>
                      {round.company.displayName}
                    </button>
                  </td>
                  <td>{humanize(round.roundType)}</td>
                  <td>{dateLabel(round.announcedAt)}</td>
                  <td>{moneyLabel(round.amount, round.currency)}</td>
                  <td>{round.entityParticipation ? humanize(round.entityParticipation.role) : 'company'}</td>
                  <td>{round.participantCount}</td>
                  <td>{round.evidence.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {isCompanyEntity(entityType) && (
        <section className="intel-card">
          <h3>Company investors</h3>
          {!data.investors.length && <p className="muted">No evidence-backed investors recorded.</p>}
          <div className="intel-table-scroll">
            <table className="intel-table">
              <thead><tr><th>Investor</th><th>Rounds</th><th>Led</th><th>First</th><th>Latest</th><th>Evidence</th></tr></thead>
              <tbody>
                {data.investors.map((entry: CompanyInvestor) => (
                  <tr key={entry.investor.id}>
                    <td>{entry.investor.displayName}</td>
                    <td>{entry.roundCount}</td>
                    <td>{entry.hasLed ? 'yes' : 'no'}</td>
                    <td>{dateLabel(entry.firstInvestmentAt)}</td>
                    <td>{dateLabel(entry.lastInvestmentAt)}</td>
                    <td>{entry.evidence.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {selectedRoundId && <FundingRoundDetailView id={selectedRoundId} onClose={() => setSelectedRoundId(undefined)} />}
    </div>
  );
}

function FundingRoundDetailView({ id, onClose }: { id: string; onClose: () => void }) {
  const [data, loading, error] = useAsync(() => intelligenceApi.getFundingRound(id), [id]);
  if (loading) return <section className="intel-card"><p className="muted">Loading round detail…</p></section>;
  if (error) return <section className="intel-card danger"><p className="error">{error}</p></section>;
  if (!data) return null;
  const round: FundingRoundDetail = data.round;
  return (
    <section className="intel-card intel-round-detail">
      <div className="intel-row-between">
        <div>
          <h3>{round.company.displayName} · {humanize(round.roundType)}</h3>
          <p className="muted small">{dateLabel(round.announcedAt)} · {moneyLabel(round.amount, round.currency)} · {round.assertionClass}</p>
        </div>
        <button type="button" className="small" onClick={onClose}>Close</button>
      </div>
      <div className="intel-table-scroll">
        <table className="intel-table">
          <thead><tr><th>Participant</th><th>Type</th><th>Role</th><th>Lead status</th><th>Confidence</th><th>Evidence</th></tr></thead>
          <tbody>
            {round.participants.map((participant) => (
              <tr key={participant.id}>
                <td>{participant.entity.displayName}</td>
                <td>{humanize(participant.participantType)}</td>
                <td>{humanize(participant.role)}</td>
                <td>{humanize(participant.leadStatus)}</td>
                <td>{participant.confidence?.toFixed(2) ?? '—'}</td>
                <td><EvidenceDisclosure evidence={participant.evidence} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <EvidenceDisclosure evidence={round.evidence} label="Round provenance" />
    </section>
  );
}

function InvestmentNetworkView({
  id,
  entityType,
  onNavigate,
}: {
  id: string;
  entityType: string;
  onNavigate: (id: string | undefined) => void;
}) {
  const [depth, setDepth] = useState<1 | 2>(1);
  const [data, loading, error] = useAsync(async () => {
    const [coInvestors, neighborhood] = await Promise.all([
      entityType === 'investment_firm'
        ? intelligenceApi.getCoInvestors(id, { limit: 50 })
        : Promise.resolve({ coInvestors: [] as CoInvestorSummary[] }),
      intelligenceApi.getNeighborhood(id, { depth, limit: depth === 1 ? 40 : 75 }),
    ]);
    return { coInvestors: coInvestors.coInvestors, neighborhood: neighborhood.neighborhood };
  }, [id, entityType, depth]);

  if (loading) return <p className="muted">Loading investment network…</p>;
  if (error) return <p className="error">{error}</p>;
  if (!data) return null;
  const nodesByKey = new Map(data.neighborhood.nodes.map((node) => [node.key, node]));

  return (
    <div className="intel-stack">
      <section className="intel-card">
        <div className="intel-row-between intel-wrap-row">
          <div>
            <h3>Relationship neighborhood</h3>
            <p className="muted small">Funding rounds appear as virtual nodes backed by their source records.</p>
          </div>
          <label className="intel-control-label">
            Depth
            <select value={depth} onChange={(event) => setDepth(Number(event.target.value) as 1 | 2)}>
              <option value={1}>1 hop</option>
              <option value={2}>2 hops</option>
            </select>
          </label>
        </div>
        <NeighborhoodGraph neighborhood={data.neighborhood} onNavigate={onNavigate} />
        {data.neighborhood.truncated && <p className="muted small">The bounded neighborhood was truncated. Narrow the relationship set for a complete view.</p>}
      </section>

      <section className="intel-card">
        <h3>Co-investors</h3>
        {entityType !== 'investment_firm' && <p className="muted">Co-investor rankings apply to investment firms.</p>}
        {entityType === 'investment_firm' && !data.coInvestors.length && <p className="muted">No shared verified funding rounds recorded.</p>}
        <div className="intel-table-scroll">
          <table className="intel-table">
            <thead><tr><th>Firm</th><th>Shared rounds</th><th>Companies</th><th>First</th><th>Latest</th><th>Evidence</th></tr></thead>
            <tbody>
              {data.coInvestors.map((entry) => (
                <tr key={entry.firm.id}>
                  <td>
                    <button className="intel-link-button" type="button" onClick={() => onNavigate(entry.firm.id)}>
                      {entry.firm.displayName}
                    </button>
                  </td>
                  <td>{entry.sharedRoundCount}</td>
                  <td>{entry.sharedCompanyCount}</td>
                  <td>{dateLabel(entry.firstSharedRoundAt)}</td>
                  <td>{dateLabel(entry.lastSharedRoundAt)}</td>
                  <td><EvidenceDisclosure evidence={entry.evidence} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="intel-card">
        <h3>Neighborhood edges</h3>
        <div className="intel-table-scroll">
          <table className="intel-table">
            <thead><tr><th>Source</th><th>Relationship</th><th>Target</th><th>Kind</th><th>Evidence</th></tr></thead>
            <tbody>
              {data.neighborhood.edges.map((edge) => (
                <tr key={edge.id}>
                  <td>{nodesByKey.get(edge.sourceKey)?.label ?? edge.sourceKey}</td>
                  <td>{humanize(edge.relationship)}</td>
                  <td>{nodesByKey.get(edge.targetKey)?.label ?? edge.targetKey}</td>
                  <td><span className={`badge ${statementBadgeClass(edge.statementKind)}`}>{humanize(edge.statementKind)}</span></td>
                  <td><EvidenceDisclosure evidence={edge.evidence} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

interface NetworkPoint {
  node: InvestmentNeighborhood['nodes'][number];
  x: number;
  y: number;
}

function NeighborhoodGraph({
  neighborhood,
  onNavigate,
}: {
  neighborhood: InvestmentNeighborhood;
  onNavigate: (id: string | undefined) => void;
}) {
  const points = useMemo(() => layoutNeighborhood(neighborhood), [neighborhood]);
  const byKey = new Map(points.map((point) => [point.node.key, point]));

  if (!points.length) return <p className="muted">No nearby nodes recorded.</p>;
  return (
    <div className="intel-network-frame">
      <svg className="intel-network-svg" viewBox="0 0 800 430" role="img" aria-label="Bounded investment relationship neighborhood">
        <defs>
          <marker id="intel-network-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
            <path d="M0,0 L8,4 L0,8 z" />
          </marker>
        </defs>
        <g className="intel-network-edges">
          {neighborhood.edges.map((edge) => {
            const source = byKey.get(edge.sourceKey);
            const target = byKey.get(edge.targetKey);
            if (!source || !target) return null;
            return (
              <line
                key={edge.id}
                x1={source.x}
                y1={source.y}
                x2={target.x}
                y2={target.y}
                className={edge.virtual ? 'virtual' : ''}
                markerEnd="url(#intel-network-arrow)"
              >
                <title>{humanize(edge.relationship)} · {humanize(edge.statementKind)}</title>
              </line>
            );
          })}
        </g>
        <g className="intel-network-nodes">
          {points.map(({ node, x, y }) => {
            const navigable = node.kind === 'entity' && node.id !== neighborhood.rootEntityId;
            const activate = () => { if (navigable) onNavigate(node.id); };
            return (
              <g
                key={node.key}
                className={`intel-network-node ${node.kind} ${node.id === neighborhood.rootEntityId ? 'root' : ''} ${navigable ? 'navigable' : ''}`}
                transform={`translate(${x - 56} ${y - 23})`}
                role={navigable ? 'button' : undefined}
                tabIndex={navigable ? 0 : undefined}
                onClick={activate}
                onKeyDown={(event) => {
                  if (navigable && (event.key === 'Enter' || event.key === ' ')) {
                    event.preventDefault();
                    activate();
                  }
                }}
              >
                <title>{node.label} · {humanize(node.subtype ?? node.kind)} · depth {node.depth}</title>
                <rect width="112" height="46" rx="8" />
                <text x="56" y="19" textAnchor="middle">{shortLabel(node.label, 18)}</text>
                <text className="subtype" x="56" y="34" textAnchor="middle">{humanize(node.subtype ?? node.kind)}</text>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

function layoutNeighborhood(neighborhood: InvestmentNeighborhood): NetworkPoint[] {
  const centerX = 400;
  const centerY = 215;
  const root = neighborhood.nodes.find((node) => node.id === neighborhood.rootEntityId);
  const points: NetworkPoint[] = root ? [{ node: root, x: centerX, y: centerY }] : [];
  for (const layer of [1, 2] as const) {
    const nodes = neighborhood.nodes
      .filter((node) => node.depth === layer && node.key !== root?.key)
      .sort((left, right) => left.key.localeCompare(right.key));
    const radiusX = layer === 1 ? 175 : 320;
    const radiusY = layer === 1 ? 105 : 175;
    nodes.forEach((node, index) => {
      const angle = -Math.PI / 2 + (index * Math.PI * 2) / Math.max(nodes.length, 1) + (layer === 2 ? 0.13 : 0);
      points.push({
        node,
        x: centerX + Math.cos(angle) * radiusX,
        y: centerY + Math.sin(angle) * radiusY,
      });
    });
  }
  return points;
}

function SectorProfileView({ id }: { id: string }) {
  const [data, loading, error] = useAsync(() => intelligenceApi.getSectorProfile(id, { limit: 50 }), [id]);
  if (loading) return <p className="muted">Loading sector profile…</p>;
  if (error) return <p className="error">{error}</p>;
  if (!data) return null;
  const profile: SectorProfile = data.profile;

  return (
    <div className="intel-profile-grid">
      <section className="intel-card">
        <h3>Observed investment behavior</h3>
        <p className="muted small">Exposure derives from persisted funding rounds and evidence-backed company sector assignments.</p>
        {!profile.observedInvestmentBehavior.length && <p className="muted">No sector-tagged investment history recorded.</p>}
        <div className="intel-bar-list">
          {profile.observedInvestmentBehavior.map((sector) => (
            <div className="intel-bar-item" key={sector.sectorId}>
              <div className="intel-row-between">
                <strong>{sector.label}</strong>
                <span className="muted small">{sector.investmentCount} rounds · {(sector.roundShare * 100).toFixed(0)}%</span>
              </div>
              <div className="intel-bar-track"><span style={{ width: `${Math.max(2, sector.roundShare * 100)}%` }} /></div>
              <div className="muted small">{sector.companyCount} companies · latest {dateLabel(sector.lastInvestmentAt)} · {sector.evidence.length} sources</div>
            </div>
          ))}
        </div>
        <p className="muted small">Companies may have multiple sectors, so round shares can overlap and need not total 100%.</p>
      </section>

      <section className="intel-card">
        <h3>Public-signal affinity</h3>
        <p className="muted small">Thematic statements remain separate from observed investment behavior.</p>
        {!profile.publicSignalAffinity.length && <p className="muted">No public thematic signals recorded.</p>}
        <div className="intel-bar-list">
          {profile.publicSignalAffinity.map((topic) => (
            <div className="intel-bar-item public" key={topic.topicId}>
              <div className="intel-row-between">
                <strong>{topic.label}</strong>
                <span className="muted small">affinity {topic.affinityScore.toFixed(2)}</span>
              </div>
              <div className="intel-bar-track"><span style={{ width: `${Math.max(2, topic.affinityScore * 100)}%` }} /></div>
              <div className="muted small">{topic.signalCount} signals · {topic.sourceCount} sources · latest {dateLabel(topic.newestSignal)}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function InvestmentTimelineView({ id }: { id: string }) {
  const [data, loading, error] = useAsync(() => intelligenceApi.getInvestmentTimeline(id, { limit: 100 }), [id]);
  if (loading) return <p className="muted">Loading investment timeline…</p>;
  if (error) return <p className="error">{error}</p>;
  if (!data) return null;

  return (
    <section className="intel-card">
      <h3>Investment timeline</h3>
      {!data.events.length && <p className="muted">No dated or observed funding-round events recorded.</p>}
      <ol className="intel-timeline">
        {data.events.map((event: InvestmentTimelineEvent) => (
          <li key={event.id}>
            <div className="intel-timeline-marker" aria-hidden="true" />
            <div className="intel-timeline-content">
              <div className="intel-row-between intel-wrap-row">
                <strong>{event.company.displayName} · {humanize(event.roundType)}</strong>
                <time>{dateLabel(event.occurredAt)}</time>
              </div>
              <p className="muted small">
                {moneyLabel(event.amount, event.currency)}
                {event.role ? ` · ${humanize(event.role)}` : ''}
                {event.leadStatus ? ` · ${humanize(event.leadStatus)}` : ''}
              </p>
              <EvidenceDisclosure evidence={event.evidence} />
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function RichRelationshipsView({ id }: { id: string }) {
  const [direction, setDirection] = useState<'incoming' | 'outgoing' | 'both'>('both');
  const [basis, setBasis] = useState('');
  const [data, loading, error] = useAsync(() => intelligenceApi.getRelationships(id, {
    direction,
    relationshipBasis: basis || undefined,
    limit: 100,
  }), [id, direction, basis]);

  return (
    <section className="intel-card">
      <div className="intel-row-between intel-wrap-row">
        <div>
          <h3>Relationships and provenance</h3>
          <p className="muted small">Facts, deterministic derivations, and inferences are kept distinct.</p>
        </div>
        <div className="intel-filter-row">
          <label>Direction
            <select value={direction} onChange={(event) => setDirection(event.target.value as typeof direction)}>
              <option value="both">Both</option>
              <option value="outgoing">Outgoing</option>
              <option value="incoming">Incoming</option>
            </select>
          </label>
          <label>Basis
            <select value={basis} onChange={(event) => setBasis(event.target.value)}>
              <option value="">All</option>
              <option value="source_fact">Source fact</option>
              <option value="derived_fact">Derived fact</option>
              <option value="inference">Inference</option>
              <option value="internal_claim">Internal claim</option>
              <option value="proposed_capability">Proposed capability</option>
            </select>
          </label>
        </div>
      </div>
      {loading && <p className="muted">Loading relationships…</p>}
      {error && <p className="error">{error}</p>}
      {data && !data.relationships.length && <p className="muted">No relationships match these filters.</p>}
      <div className="intel-table-scroll">
        <table className="intel-table intel-relationship-table">
          <thead><tr><th>Kind</th><th>Direction</th><th>Relationship</th><th>Counterparty / target</th><th>Effective</th><th>Confidence</th><th>Provenance</th></tr></thead>
          <tbody>
            {data?.relationships.map((relationship: RichRelationship) => (
              <tr key={relationship.id}>
                <td>
                  <span className={`badge ${statementBadgeClass(relationship.statementKind)}`}>{humanize(relationship.statementKind)}</span>
                  <div className="muted small">{humanize(relationship.relationshipBasis)}</div>
                </td>
                <td>{relationship.direction}</td>
                <td>{humanize(relationship.relationship)}</td>
                <td>{relationshipTarget(relationship)}</td>
                <td>{dateLabel(relationship.effectiveAt ?? relationship.validFrom ?? relationship.firstObservedAt)}</td>
                <td>{relationship.confidence?.toFixed(2) ?? '—'}</td>
                <td><EvidenceDisclosure evidence={relationship.evidence} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function InvestorFitView({ companyId }: { companyId: string }) {
  const [data, loading, error] = useAsync(() => intelligenceApi.getInvestorFits(companyId, { limit: 25 }), [companyId]);
  if (loading) return <p className="muted">Calculating evidence-backed heuristic fit…</p>;
  if (error) return <p className="error">{error}</p>;
  if (!data) return null;

  return (
    <div className="intel-stack">
      <section className="intel-card warn intel-fit-notice">
        <strong>{data.scoringMethod} scoring</strong>
        <p>{data.disclaimer}</p>
      </section>
      {!data.fits.length && <p className="muted">No investment firms are available to score.</p>}
      {data.fits.map((fit: InvestorFitScore) => (
        <section className="intel-card intel-fit-card" key={fit.investor.id}>
          <div className="intel-row-between intel-wrap-row">
            <div>
              <h3>{fit.investor.displayName}</h3>
              <p className="muted small">{fit.scoringVersion} · evaluated {dateLabel(fit.evaluatedAt)}</p>
            </div>
            <div className="intel-fit-score">
              {fit.overallScore === undefined ? '—' : `${(fit.overallScore * 100).toFixed(0)}`}
              <span>/ 100</span>
            </div>
          </div>
          <div className="intel-fit-components">
            {Object.values(fit.components).map((component) => (
              <div className="intel-fit-component" key={component.key}>
                <div className="intel-row-between">
                  <strong>{component.label}</strong>
                  <span>{component.score === undefined ? 'unavailable' : `${(component.score * 100).toFixed(0)}%`}</span>
                </div>
                <div className="intel-bar-track">
                  <span style={{ width: `${component.score === undefined ? 0 : Math.max(2, component.score * 100)}%` }} />
                </div>
                <p className="muted small">{component.explanation}</p>
                {!!component.evidence.length && (
                  <details className="intel-provenance">
                    <summary>{component.evidence.length} supporting item(s)</summary>
                    <ul>
                      {component.evidence.map((item, index) => (
                        <li key={`${item.kind}-${index}`}>
                          {item.label}
                          {item.sourceUrls.map((url) => <a key={url} href={url} target="_blank" rel="noreferrer">source</a>)}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            ))}
          </div>
          <details className="intel-provenance intel-limitations">
            <summary>Limitations ({fit.limitations.length})</summary>
            <ul>{fit.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul>
          </details>
        </section>
      ))}
    </div>
  );
}

function EvidenceDisclosure({ evidence, label }: { evidence: AnalyticsEvidence[]; label?: string }) {
  if (!evidence.length) return <span className="muted small">no source</span>;
  return (
    <details className="intel-provenance">
      <summary>{label ?? `${evidence.length} source${evidence.length === 1 ? '' : 's'}`}</summary>
      <ul>
        {evidence.map((record) => (
          <li key={record.signalId}>
            <a href={record.sourceUrl} target="_blank" rel="noreferrer">{record.title ?? record.sourceKind}</a>
            <span>{dateLabel(record.publishedAt ?? record.retrievedAt)}</span>
            {(record.evidenceText || record.excerpt) && <p>{record.evidenceText ?? record.excerpt}</p>}
          </li>
        ))}
      </ul>
    </details>
  );
}

function isCompanyEntity(entityType: string): boolean {
  return ['portfolio_company', 'strategic_company', 'organization'].includes(entityType);
}

function isFitCompany(entityType: string): boolean {
  return entityType === 'portfolio_company' || entityType === 'strategic_company';
}

function humanize(value: string): string {
  return value.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function shortLabel(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function dateLabel(value?: string): string {
  return value ? value.slice(0, 10) : 'undated';
}

function moneyLabel(amount?: string, currency?: string): string {
  if (!amount) return 'undisclosed';
  return `${currency ?? ''} ${amount}`.trim();
}

function statementBadgeClass(kind: string): string {
  if (kind === 'FACT') return 'ok';
  if (kind === 'INFERENCE') return 'warn';
  return '';
}

function relationshipTarget(relationship: RichRelationship): string {
  if (relationship.direction === 'incoming') return relationship.from.displayName;
  return relationship.toEntity?.displayName ?? relationship.toTopic?.label ?? relationship.toSector?.label ?? '(unnamed)';
}

// ---------------------------------------------------------------------------
// Opportunities
// ---------------------------------------------------------------------------

function OpportunitiesView({
  selectedId, onSelect, onOpenContent,
}: { selectedId?: string; onSelect: (id: string | undefined) => void; onOpenContent: (id: string) => void }) {
  const [list, loading, error, refresh] = useAsync(() => intelligenceApi.listOpportunities(20, 0), []);

  return (
    <div className="intel-columns">
      <div className="intel-column">
        <h3>Opportunities</h3>
        {loading && <p className="muted">Loading…</p>}
        {error && <p className="error">{error}</p>}
        <ul className="intel-list">
          {list?.opportunities.map((opportunity) => (
            <li key={opportunity.id}>
              <button className={selectedId === opportunity.id ? 'active' : ''} onClick={() => onSelect(opportunity.id)}>
                <strong>{opportunity.headline}</strong>
                <span className="muted small">score {opportunity.score.toFixed(2)} · confidence {opportunity.confidence.toFixed(2)}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="intel-column wide">
        {selectedId
          ? <OpportunityDetail id={selectedId} onDrafted={(contentId) => { onOpenContent(contentId); }} onChanged={refresh} />
          : <p className="muted">Select an opportunity.</p>}
      </div>
    </div>
  );
}

function OpportunityDetail({ id, onDrafted, onChanged }: { id: string; onDrafted: (contentId: string) => void; onChanged: () => void }) {
  const [detail, loading, error] = useAsync(() => intelligenceApi.getOpportunity(id), [id]);
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | undefined>();

  const draft = useCallback(async () => {
    setDrafting(true);
    setDraftError(undefined);
    try {
      const result = await intelligenceApi.draftFromOpportunity(id);
      onDrafted(result.asset.id);
      onChanged();
    } catch (e) {
      setDraftError(String(e instanceof Error ? e.message : e));
    } finally {
      setDrafting(false);
    }
  }, [id, onDrafted, onChanged]);

  if (loading) return <p className="muted">Loading…</p>;
  if (error) return <p className="error">{error}</p>;
  if (!detail) return null;

  const opp: OpportunityRecord = detail.opportunity;

  return (
    <div className="intel-stack">
      <div className="intel-row-between">
        <h2>{opp.headline}</h2>
        <button className="primary" disabled={drafting} onClick={draft}>
          {drafting ? 'Drafting…' : `Draft ${opp.recommendedAssetType.replace(/_/g, ' ')}`}
        </button>
      </div>
      {draftError && <p className="error">{draftError}</p>}

      <div className="intel-grid narrow">
        {Object.entries(opp.scoreComponents).map(([key, value]) => (
          <StatCard key={key} label={key.replace(/([A-Z])/g, ' $1').trim()} value={Number(value).toFixed(2)} />
        ))}
      </div>

      <section className="intel-card"><h4>Signal</h4><p>{opp.signalSummary}</p></section>
      <section className="intel-card"><h4>Why it matters</h4><p>{opp.whyItMatters}</p></section>
      <section className="intel-card"><h4>DACAIS intersection</h4><p>{opp.dacaisIntersection}</p></section>
      {opp.missingEvidence && <section className="intel-card warn"><h4>Missing evidence</h4><p>{opp.missingEvidence}</p></section>}
      {opp.risks && <section className="intel-card warn"><h4>Risks</h4><p>{opp.risks}</p></section>}
      {opp.suggestedVisual && (
        <section className="intel-card">
          <h4>Suggested visual ({opp.suggestedVisualKind?.replace(/_/g, ' ')})</h4>
          <pre className="intel-pre">{opp.suggestedVisual}</pre>
        </section>
      )}
      <section className="intel-card">
        <h4>Reasoning</h4>
        <pre className="intel-pre">{opp.reasoning}</pre>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

function EvidenceView() {
  const [capabilities] = useAsync(() => intelligenceApi.listCapabilities(), []);
  const [gaps] = useAsync(() => intelligenceApi.evidenceGaps(), []);
  const [selected, setSelected] = useState<string | undefined>();
  const [metrics, , , refreshMetrics] = useAsync(() => intelligenceApi.listMetrics(), []);
  const [refreshing, setRefreshing] = useState(false);

  return (
    <div className="intel-stack">
      <div className="intel-row-between">
        <h3>DACAIS capabilities</h3>
        <button
          className="small"
          disabled={refreshing}
          onClick={async () => { setRefreshing(true); await intelligenceApi.refreshMetrics(); refreshMetrics(); setRefreshing(false); }}
        >
          {refreshing ? 'Measuring…' : 'Refresh metrics'}
        </button>
      </div>

      <table className="intel-table">
        <thead><tr><th>Claim</th><th>Status</th><th>Evidence</th><th>Publicly shareable</th><th>Last verified</th></tr></thead>
        <tbody>
          {capabilities?.capabilities.map((capability: Capability) => (
            <tr key={capability.id} className={selected === capability.slug ? 'selected' : ''} onClick={() => setSelected(capability.slug)}>
              <td>{capability.name}</td>
              <td><span className={`badge ${statusBadgeClass(capability.status)}`}>{capability.status}</span></td>
              <td>{capability.evidenceCount}</td>
              <td>{capability.publiclyShareable ? 'yes' : 'no'}</td>
              <td className="muted small">{capability.lastVerifiedAt?.slice(0, 10) ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {selected && <CapabilityDetail slug={selected} />}

      {!!gaps?.gaps.length && (
        <section className="intel-card warn">
          <h3>Evidence gaps</h3>
          <ul>
            {gaps.gaps.map((gap: EvidenceGap, index: number) => (
              <li key={index}>
                <strong>{gap.capabilityName}</strong> [{gap.status}] — {gap.reason}
                <div className="muted small">{gap.recommendedAction}</div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="intel-card">
        <h3>Metrics</h3>
        <table className="intel-table">
          <thead><tr><th>Label</th><th>Status</th><th>Value</th><th>Source</th></tr></thead>
          <tbody>
            {metrics?.metrics.map((metric: MetricRecord) => (
              <tr key={metric.id}>
                <td>{metric.label}</td>
                <td><span className={`badge ${statusBadgeClass(metric.status)}`}>{metric.status.replace(/_/g, ' ')}</span></td>
                <td>{metric.status === 'MEASURED' ? `${metric.valueText ?? metric.value}${metric.unit ? ` ${metric.unit}` : ''}` : 'STATUS: NEEDS MEASUREMENT'}</td>
                <td className="muted small">{metric.measurementSource ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function CapabilityDetail({ slug }: { slug: string }) {
  const [detail, loading, error] = useAsync(() => intelligenceApi.getCapability(slug), [slug]);

  if (loading) return <p className="muted">Loading…</p>;
  if (error) return <p className="error">{error}</p>;
  if (!detail) return null;

  return (
    <section className="intel-card">
      <div className="intel-row-between">
        <h4>{detail.capability.name}</h4>
        <span className={`badge ${statusBadgeClass(detail.capability.status)}`}>{detail.capability.status}</span>
      </div>
      <p>{detail.capability.description}</p>
      {detail.capability.safePhrasing && <p className="muted small">Safe phrasing: {detail.capability.safePhrasing}</p>}

      <h5>Evidence ({detail.evidence.length})</h5>
      <ul className="intel-list plain">
        {detail.evidence.map((record) => (
          <li key={record.id}>
            <span className="badge">{record.kind.replace(/_/g, ' ')}</span>{' '}
            {record.filePath ? `${record.filePath}${record.startLine ? `:${record.startLine}` : ''}` : record.locator ?? '(no location)'}
            {record.excerpt && <div className="muted small">{record.excerpt.slice(0, 200)}</div>}
          </li>
        ))}
        {!detail.evidence.length && <li className="muted">No evidence attached.</li>}
      </ul>

      <h5>Claims ({detail.claims.length})</h5>
      <ul className="intel-list plain">
        {detail.claims.map((claim) => (
          <li key={claim.id}>
            {claim.text} — <span className="muted small">{claim.supportingEvidenceCount} supporting evidence</span>
          </li>
        ))}
        {!detail.claims.length && <li className="muted">No claims recorded.</li>}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

function ContentView({ selectedId, onSelect }: { selectedId?: string; onSelect: (id: string | undefined) => void }) {
  const [list, loading, error, refresh] = useAsync(() => intelligenceApi.listContent(), []);

  return (
    <div className="intel-columns">
      <div className="intel-column">
        <h3>Content</h3>
        {loading && <p className="muted">Loading…</p>}
        {error && <p className="error">{error}</p>}
        <ul className="intel-list">
          {list?.assets.map((asset: ContentAsset) => (
            <li key={asset.id}>
              <button className={selectedId === asset.id ? 'active' : ''} onClick={() => onSelect(asset.id)}>
                <strong>{asset.title ?? asset.assetType.replace(/_/g, ' ')}</strong>
                <span className={`badge small ${asset.state === 'HUMAN_APPROVED' || asset.state === 'PUBLISHED' ? 'ok' : ''}`}>{asset.state.replace(/_/g, ' ')}</span>
              </button>
            </li>
          ))}
          {!list?.assets.length && <li className="muted">No content yet. Draft one from an opportunity.</li>}
        </ul>
      </div>
      <div className="intel-column wide">
        {selectedId ? <ContentDetail id={selectedId} onChanged={refresh} /> : <p className="muted">Select a content asset.</p>}
      </div>
    </div>
  );
}

function ContentDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const [detail, loading, error, refresh] = useAsync(() => intelligenceApi.getContent(id), [id]);
  const [busy, setBusy] = useState<string | undefined>();
  const [exportText, setExportText] = useState<string | undefined>();
  const [rejectReason, setRejectReason] = useState('');
  const [actionError, setActionError] = useState<string | undefined>();

  const act = useCallback(async (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    setActionError(undefined);
    try {
      await action();
      refresh();
      onChanged();
    } catch (e) {
      setActionError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(undefined);
    }
  }, [refresh, onChanged]);

  if (loading) return <p className="muted">Loading…</p>;
  if (error) return <p className="error">{error}</p>;
  if (!detail) return null;

  const asset = detail.asset;
  const blocking = asset.riskFindings.filter((finding) => finding.severity === 'blocking');

  return (
    <div className="intel-stack">
      <div className="intel-row-between">
        <h2>{asset.title ?? asset.assetType.replace(/_/g, ' ')}</h2>
        <span className={`badge ${asset.state === 'HUMAN_APPROVED' || asset.state === 'PUBLISHED' ? 'ok' : ''}`}>{asset.state.replace(/_/g, ' ')}</span>
      </div>

      <div className="intel-actions-row">
        <button disabled={!!busy} onClick={() => act('risk-review', () => intelligenceApi.riskReview(id))}>
          {busy === 'risk-review' ? 'Checking…' : 'Run risk review'}
        </button>
        <button disabled={!!busy || asset.state !== 'RISK_REVIEW'} onClick={() => act('submit', () => intelligenceApi.submitContent(id))}>
          Submit for approval
        </button>
        <button
          className="primary"
          disabled={!!busy || asset.state !== 'READY_FOR_REVIEW'}
          onClick={() => act('approve', () => intelligenceApi.approveContent(id))}
        >
          Approve
        </button>
        <button
          disabled={!!busy || !exportAllowed(asset.state)}
          onClick={async () => {
            setBusy('export');
            try {
              const result = await intelligenceApi.exportContent(id);
              setExportText(result.text);
              refresh();
            } catch (e) {
              setActionError(String(e instanceof Error ? e.message : e));
            } finally {
              setBusy(undefined);
            }
          }}
        >
          Export
        </button>
      </div>
      {actionError && <p className="error">{actionError}</p>}

      <div className="intel-form-inline">
        <input placeholder="Rejection reason" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
        <button
          className="danger"
          disabled={!!busy || !rejectReason.trim()}
          onClick={() => act('reject', () => intelligenceApi.rejectContent(id, rejectReason))}
        >
          Reject
        </button>
      </div>

      {!!blocking.length && (
        <section className="intel-card danger">
          <h4>Blocking findings — cannot advance to approval</h4>
          <ul>
            {blocking.map((finding, index) => (
              <li key={index}>
                <strong>{finding.code.replace(/-/g, ' ')}:</strong> {finding.message}
                {finding.remedy && <div className="muted small">Remedy: {finding.remedy}</div>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {!!asset.riskFindings.filter((f) => f.severity !== 'blocking').length && (
        <section className="intel-card warn">
          <h4>Advisory findings</h4>
          <ul>
            {asset.riskFindings.filter((f) => f.severity !== 'blocking').map((finding, index) => (
              <li key={index}>{finding.message}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="intel-card">
        <h4>Draft</h4>
        <pre className="intel-pre">{asset.body}</pre>
      </section>

      {!!asset.unsupportedStatements.length && (
        <section className="intel-card warn">
          <h4>Statements the model could not support</h4>
          <ul>{asset.unsupportedStatements.map((statement, index) => <li key={index}>{statement}</li>)}</ul>
        </section>
      )}

      {exportText && (
        <section className="intel-card">
          <h4>Exported</h4>
          <pre className="intel-pre">{exportText}</pre>
        </section>
      )}

      <section className="intel-card">
        <h4>Audit trail</h4>
        <ul className="intel-list plain">
          {detail.audit.map((entry: ContentAuditRow, index: number) => (
            <li key={index} className="muted small">
              {entry.occurredAt.slice(0, 19).replace('T', ' ')} — {entry.actor} — {entry.action}
              {entry.fromState ? ` (${entry.fromState} → ${entry.toState})` : ` (→ ${entry.toState})`}
              {entry.detail ? ` — ${entry.detail}` : ''}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function exportAllowed(state: string): boolean {
  return state === 'HUMAN_APPROVED' || state === 'EXPORTED' || state === 'PUBLISHED';
}

// ---------------------------------------------------------------------------
// Diligence
// ---------------------------------------------------------------------------

function DiligenceView() {
  const [roles] = useAsync(() => intelligenceApi.diligenceRoles(), []);
  const [backlog, , , refreshBacklog] = useAsync(() => intelligenceApi.diligenceBacklog(), []);
  const [role, setRole] = useState('skeptical_cto');
  const [focus, setFocus] = useState('');
  const [running, setRunning] = useState(false);
  const [session, setSession] = useState<DiligenceSession | undefined>();
  const [runError, setRunError] = useState<string | undefined>();

  const run = useCallback(async () => {
    setRunning(true);
    setRunError(undefined);
    try {
      const result = await intelligenceApi.runDiligence({ role, focus: focus || undefined });
      setSession(result.session);
      refreshBacklog();
    } catch (e) {
      setRunError(String(e instanceof Error ? e.message : e));
    } finally {
      setRunning(false);
    }
  }, [role, focus, refreshBacklog]);

  return (
    <div className="intel-stack">
      <section className="intel-card">
        <h3>Run a diligence session</h3>
        <div className="intel-form-inline">
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            {roles?.roles.map((value) => <option key={value} value={value}>{value.replace(/_/g, ' ')}</option>)}
          </select>
          <input placeholder="Focus area (optional)" value={focus} onChange={(e) => setFocus(e.target.value)} />
          <button className="primary" disabled={running} onClick={run}>{running ? 'Running…' : 'Run'}</button>
        </div>
        {runError && <p className="error">{runError}</p>}
      </section>

      {session && (
        <section className="intel-card">
          <h3>Session: {session.role.replace(/_/g, ' ')}</h3>
          <p className="muted small">
            {session.strongCount} strong · {session.unsupportedCount} unsupported · {session.dangerousCount} dangerous
          </p>
          {session.questions.map((question) => (
            <div key={question.id} className="intel-qa">
              <div className="intel-row-between">
                <strong>{question.question}</strong>
                <span className={`badge ${statusBadgeClass(question.score)}`}>{question.score}</span>
              </div>
              <p>{question.answer}</p>
              {question.betterAnswer && <p className="muted small">Better answer: {question.betterAnswer}</p>}
              {question.missingEvidence && <p className="muted small">Missing: {question.missingEvidence}</p>}
            </div>
          ))}
        </section>
      )}

      <section className="intel-card">
        <h3>Diligence backlog</h3>
        {!backlog?.backlog.length && <p className="muted">No open gaps.</p>}
        <ul className="intel-list plain">
          {backlog?.backlog.map((entry) => (
            <li key={entry.id}>
              <span className={`badge ${statusBadgeClass(entry.score)}`}>{entry.score}</span> {entry.question}
              <div className="muted small">{entry.sessionRole.replace(/_/g, ' ')} · {entry.requiredAction?.replace(/_/g, ' ')}</div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Brief
// ---------------------------------------------------------------------------

function BriefView() {
  const [data, loading, error] = useAsync<{ brief: Brief; text: string }>(() => intelligenceApi.brief(), []);

  if (loading) return <p className="muted">Loading…</p>;
  if (error) return <p className="error">{error}</p>;
  if (!data) return null;

  return (
    <div className="intel-stack">
      <section className="intel-card">
        <pre className="intel-pre">{data.text}</pre>
      </section>
      {data.brief.belowThresholdCount > 0 && (
        <p className="muted small">{data.brief.belowThresholdCount} additional opportunit(ies) below the confidence threshold are not shown.</p>
      )}
    </div>
  );
}

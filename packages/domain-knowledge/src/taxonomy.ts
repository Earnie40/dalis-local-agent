/**
 * The DACAIS domain taxonomy.
 *
 * This exists so datasets, adapters, and retrieval are scoped to a *named*
 * domain rather than accumulating into one indiscriminate corpus. Every
 * dataset, prediction, evaluation, and adapter in the platform carries a
 * DomainId, and the registry below is the only place a new domain is declared.
 */

export type DomainId =
  | 'blockchain'
  | 'smart-contract'
  | 'computer-science'
  | 'software-engineering'
  | 'backend-development'
  | 'frontend-development'
  | 'biology'
  | 'chemistry'
  | 'nuclear-chemistry'
  | 'radiation-biology'
  | 'anatomy-and-physiology'
  | 'psychology'
  | 'mathematics'
  | 'physics'
  | 'electromagnetism'
  | 'gravitation-and-relativity'
  | 'antimatter-physics'
  | 'nanotechnology'
  | 'metamaterials-and-cloaking'
  | 'claytronics'
  | 'spatial-edge-technology'
  | 'nuclear-technology'
  | 'intelligence-surveillance-technology'
  | 'engineering'
  | 'astrophysics'
  | 'aerospace-engineering'
  | 'mechanical-cad'
  | 'architecture-bim'
  | '3d-visualization'
  | 'engineering-simulation'
  | 'market-intelligence'
  | 'trader-behavior'
  | 'market-events'
  | 'forecasting'
  | 'backtesting'
  | 'onchain-intelligence'
  | 'spatial'
  | 'robotics'
  | 'ar-spatial-computing'
  | 'digital-human'
  | 'digital-twin'
  | 'ecosystem-intelligence'
  | 'cross-domain';

/** Broad grouping used to navigate the registry without flattening disciplines. */
export type DomainFamily =
  | 'computing'
  | 'finance-and-markets'
  | 'life-sciences'
  | 'physical-sciences'
  | 'engineering'
  | 'built-environment'
  | 'human-computer-interaction'
  | 'cross-disciplinary';

/**
 * Native representation of a domain's data. Recorded so ingestion does not
 * flatten depth maps, point clouds, or geospatial state into text when a
 * native representation is the correct one.
 */
export type Modality =
  | 'text'
  | 'code'
  | 'tabular'
  | 'timeseries'
  | 'image'
  | 'video'
  | 'depth'
  | 'pointcloud'
  | 'geospatial'
  | 'audio'
  | 'telemetry'
  | '3d-model';

/**
 * Operational status ladder — the single source of truth for how far a domain
 * has actually progressed. Declared here so status cannot drift between docs,
 * code, and reports.
 *
 * Each level means something specific and is NOT implied by the one before it:
 *
 *   REGISTERED           in the taxonomy; scoped. Nothing else.
 *   RAG_ENABLED          a licensed corpus is ingested and domain-scoped
 *                        retrieval returns it with provenance.
 *   TOOLS_ENABLED        domain-specific tooling exists and runs.
 *   EVALUATED            a HELD-OUT evaluation suite exists and has been run,
 *                        with the numbers recorded.
 *   TRAINING_DATA_READY  approved training candidates exist in an immutable
 *                        dataset version, separated from the eval set.
 *   ADAPTER_TRAINED      an adapter has actually been trained.
 *   PRODUCTION_APPROVED  evaluated, human-approved, and routable.
 *
 * REGISTERED is not IMPLEMENTED. RAG_ENABLED is not TRAINED.
 * TRAINING_DATA_READY is not FINE_TUNED. FINE_TUNED is not PRODUCTION_APPROVED.
 */
export type OperationalStatus =
  | 'REGISTERED'
  | 'RAG_ENABLED'
  | 'TOOLS_ENABLED'
  | 'EVALUATED'
  | 'TRAINING_DATA_READY'
  | 'ADAPTER_TRAINED'
  | 'PRODUCTION_APPROVED';

/** Ordered weakest to strongest, for threshold comparisons. */
export const OPERATIONAL_LADDER: readonly OperationalStatus[] = [
  'REGISTERED',
  'RAG_ENABLED',
  'TOOLS_ENABLED',
  'EVALUATED',
  'TRAINING_DATA_READY',
  'ADAPTER_TRAINED',
  'PRODUCTION_APPROVED',
];

export function atLeast(actual: OperationalStatus, required: OperationalStatus): boolean {
  return OPERATIONAL_LADDER.indexOf(actual) >= OPERATIONAL_LADDER.indexOf(required);
}

export interface DomainDefinition {
  id: DomainId;
  family: DomainFamily;
  title: string;
  summary: string;
  /** Human-facing synonyms; these do not silently change a document's domain. */
  aliases?: readonly string[];
  /** Named branches that remain discoverable under an umbrella domain. */
  subdisciplines?: readonly string[];
  /** Conservative ingestion hints. Two unique hits are required and ties abstain. */
  classificationHints?: readonly string[];
  /** Epistemic boundary for fields that mix established and speculative claims. */
  evidenceNotes?: string;
  /** Domain-specific use boundary; registration never grants operational authority. */
  safetyNotes?: string;
  modalities: readonly Modality[];
  /**
   * True when the domain's *facts* move faster than a fine-tuning cycle, which
   * makes retrieval the only correct route for them. See knowledge-policy.ts —
   * this flag is what makes routing a volatile fact into a training dataset a
   * hard error rather than a judgement call.
   */
  factsAreVolatile: boolean;
  /**
   * Behavioural skills stable enough to live in model weights. Deliberately
   * phrased as procedures ("how to ..."), never as facts.
   */
  trainableSkills: readonly string[];
  /** Adapter this domain would train into. Naming only; no adapter exists yet. */
  plannedAdapterId: string;
  status: OperationalStatus;
}

const DEFINITIONS: readonly DomainDefinition[] = [
  {
    id: 'blockchain',
    family: 'computing',
    title: 'Blockchain / distributed systems',
    summary:
      'Chain architecture, transaction lifecycle, consensus, state, accounts, RPC, rollups, bridges, token standards, account abstraction, ZK systems, decentralized identity.',
    modalities: ['text', 'code', 'tabular'],
    classificationHints: ['consensus', 'mempool', 'rollup', 'finality', 'block header', 'gas limit'],
    factsAreVolatile: true,
    trainableSkills: [
      'how to trace a transaction lifecycle from submission to finality',
      'how to reason about state, accounts, and storage layout',
      'how to evaluate evidence from an RPC or indexer response',
    ],
    plannedAdapterId: 'dacais-blockchain-adapter',
    status: 'REGISTERED',
  },
  {
    id: 'smart-contract',
    family: 'computing',
    title: 'Smart contract engineering',
    summary:
      'Solidity, EVM execution, ABI encoding, proxies and upgradeability, access control, treasury/settlement/escrow patterns, invariant and fuzz testing, gas analysis, defensive security review.',
    modalities: ['code', 'text'],
    classificationHints: ['solidity', 'reentrancy', 'delegatecall', 'onlyowner', 'msg.sender', 'erc-20'],
    factsAreVolatile: true,
    trainableSkills: [
      'how to inspect a contract and identify risk classes',
      'how to propose a remediation and justify it',
      'how to write invariant and regression tests for a fix',
      'how to verify a corrected implementation with evidence',
    ],
    plannedAdapterId: 'dacais-smart-contract-adapter',
    // Corpus ingested + domain-scoped retrieval + analyzer + held-out suite run.
    // Not TRAINING_DATA_READY: no approved training candidates exist yet.
    status: 'EVALUATED',
  },
  {
    id: 'computer-science',
    family: 'computing',
    title: 'Computer science',
    summary:
      'Algorithms, data structures, computability, programming languages, compilers, operating systems, databases, networking, distributed systems, and theoretical foundations.',
    aliases: ['CS', 'computing science'],
    classificationHints: ['algorithmic complexity', 'data structure', 'compiler theory', 'automata theory', 'computability', 'operating system kernel'],
    modalities: ['text', 'code', 'tabular'],
    factsAreVolatile: false,
    trainableSkills: [
      'how to select and justify an algorithm or data structure',
      'how to reason about computational complexity and correctness',
      'how to trace state and control through a computing system',
    ],
    plannedAdapterId: 'dacais-computer-science-adapter',
    status: 'REGISTERED',
  },
  {
    id: 'software-engineering',
    family: 'computing',
    title: 'Software engineering',
    summary:
      'Requirements, architecture, implementation, testing, debugging, reliability, security, delivery, maintenance, observability, and lifecycle engineering across software systems.',
    aliases: ['software development', 'application engineering'],
    classificationHints: ['continuous integration', 'dependency injection', 'design pattern', 'code review', 'regression test', 'software refactoring'],
    modalities: ['code', 'text', 'telemetry'],
    factsAreVolatile: true,
    trainableSkills: [
      'how to turn a requirement into a bounded implementation and validation plan',
      'how to diagnose a defect using reproducible evidence',
      'how to assess change impact before modifying a system',
    ],
    plannedAdapterId: 'dacais-software-engineering-adapter',
    status: 'REGISTERED',
  },
  {
    id: 'backend-development',
    family: 'computing',
    title: 'Backend development',
    summary:
      'APIs, services, persistence, queues, transactions, authentication, authorization, caching, distributed workflows, observability, reliability, and server-side performance.',
    aliases: ['server-side development', 'backend engineering'],
    classificationHints: ['api gateway', 'database transaction', 'message queue', 'service boundary', 'object relational mapper', 'distributed cache'],
    modalities: ['code', 'text', 'tabular', 'telemetry'],
    factsAreVolatile: true,
    trainableSkills: [
      'how to design a service boundary and data contract',
      'how to preserve consistency and idempotency across backend workflows',
      'how to diagnose reliability and performance failures from telemetry',
    ],
    plannedAdapterId: 'dacais-software-engineering-adapter',
    status: 'REGISTERED',
  },
  {
    id: 'frontend-development',
    family: 'computing',
    title: 'Frontend development',
    summary:
      'Browser applications, component systems, HTML, CSS, JavaScript and TypeScript, state, accessibility, performance, responsive layout, testing, and human-facing interaction design.',
    aliases: ['web frontend', 'client-side development'],
    classificationHints: ['react component', 'css grid', 'browser rendering', 'web accessibility', 'client-side state', 'document object model'],
    modalities: ['code', 'text', 'image', 'video'],
    factsAreVolatile: true,
    trainableSkills: [
      'how to translate a visual and interaction requirement into accessible UI',
      'how to reason about browser state, rendering, and user events',
      'how to verify responsive behavior and visual regressions',
    ],
    plannedAdapterId: 'dacais-software-engineering-adapter',
    status: 'REGISTERED',
  },
  {
    id: 'biology',
    family: 'life-sciences',
    title: 'Biology',
    summary:
      'Molecular and cell biology, genetics, evolution, physiology, ecology, microbiology, developmental biology, systems biology, and experimental interpretation.',
    aliases: ['life science', 'biological sciences'],
    classificationHints: ['cell membrane', 'gene expression', 'protein folding', 'metabolic pathway', 'evolutionary biology', 'microbial ecology'],
    modalities: ['text', 'tabular', 'timeseries', 'image', 'video'],
    factsAreVolatile: false,
    trainableSkills: [
      'how to distinguish observation, mechanism, correlation, and causal inference in biological evidence',
      'how to design controls and interpret uncertainty in a biological experiment',
      'how to connect molecular, cellular, organismal, and ecological scales without discarding provenance',
    ],
    plannedAdapterId: 'dacais-life-sciences-adapter',
    status: 'REGISTERED',
  },
  {
    id: 'chemistry',
    family: 'physical-sciences',
    title: 'Chemistry',
    summary:
      'Physical, organic, inorganic, analytical, computational, materials, environmental, and biological chemistry; structure, bonding, reactions, measurement, and laboratory evidence.',
    aliases: ['chemical science'],
    subdisciplines: ['physical chemistry', 'organic chemistry', 'inorganic chemistry', 'analytical chemistry', 'biochemistry', 'computational chemistry', 'materials chemistry'],
    classificationHints: ['chemical equilibrium', 'reaction mechanism', 'molecular orbital', 'spectroscopic analysis', 'chemical kinetics', 'stoichiometric calculation'],
    modalities: ['text', 'tabular', 'timeseries', 'image', 'code'],
    factsAreVolatile: false,
    trainableSkills: [
      'how to balance chemical models, units, uncertainty, and conservation constraints',
      'how to distinguish measured chemical evidence from a proposed reaction mechanism',
    ],
    plannedAdapterId: 'dacais-chemical-sciences-adapter',
    status: 'REGISTERED',
  },
  {
    id: 'nuclear-chemistry',
    family: 'physical-sciences',
    title: 'Nuclear and radiochemistry',
    summary:
      'Radioactive decay, isotope chemistry, radiochemical measurement, tracer methods, nuclear materials, environmental fate, dosimetry interfaces, and regulated laboratory practice.',
    classificationHints: ['radioactive decay chain', 'isotope separation measurement', 'radiochemical assay', 'activation product', 'half life calculation', 'radiotracer chemistry'],
    modalities: ['text', 'tabular', 'timeseries', 'telemetry'],
    factsAreVolatile: true,
    safetyNotes: 'Research and safety analysis only; registration does not authorize acquisition, enrichment, weaponization, or handling of controlled nuclear material.',
    trainableSkills: [
      'how to calculate decay and activity with units and uncertainty',
      'how to frame radiochemical work around exposure controls and regulatory evidence',
    ],
    plannedAdapterId: 'dacais-nuclear-sciences-adapter',
    status: 'REGISTERED',
  },
  {
    id: 'radiation-biology',
    family: 'life-sciences',
    title: 'Radiation and nuclear biology',
    summary:
      'Biological effects of ionizing radiation, DNA damage and repair, dose response, radiobiology, environmental exposure, protection, and evidence-based risk interpretation.',
    aliases: ['radiobiology', 'nuclear biology'],
    classificationHints: ['ionizing radiation exposure', 'dna double strand break', 'absorbed dose', 'radiation dose response', 'cell survival curve', 'radiation protection'],
    modalities: ['text', 'tabular', 'timeseries', 'image'],
    factsAreVolatile: true,
    safetyNotes: 'Educational and research support only; exposure, diagnosis, and treatment decisions require qualified professionals and applicable regulation.',
    trainableSkills: [
      'how to separate physical dose, biological response, and epidemiological inference',
      'how to communicate radiation risk with uncertainty and exposure context',
    ],
    plannedAdapterId: 'dacais-life-sciences-adapter',
    status: 'REGISTERED',
  },
  {
    id: 'anatomy-and-physiology',
    family: 'life-sciences',
    title: 'Human and comparative anatomy and physiology',
    summary:
      'Structure and function from cells and tissues through organ systems, biomechanics, development, homeostasis, comparative anatomy, and anatomical imaging.',
    aliases: ['anatomy', 'physiology'],
    classificationHints: ['musculoskeletal anatomy', 'cardiovascular physiology', 'nervous system anatomy', 'organ system homeostasis', 'histological tissue', 'anatomical plane'],
    modalities: ['text', 'tabular', 'timeseries', 'image', 'video', '3d-model'],
    factsAreVolatile: false,
    safetyNotes: 'Educational and research support only; it is not a substitute for clinical diagnosis, treatment, or procedural training.',
    trainableSkills: [
      'how to connect anatomical structure to physiological function across scales',
      'how to interpret anatomical evidence without inventing a clinical conclusion',
    ],
    plannedAdapterId: 'dacais-life-sciences-adapter',
    status: 'REGISTERED',
  },
  {
    id: 'psychology',
    family: 'life-sciences',
    title: 'Psychology and cognitive science',
    summary:
      'Cognition, perception, learning, development, social behavior, neuroscience interfaces, measurement, experimental design, clinical research, and reproducibility.',
    aliases: ['behavioral science', 'cognitive psychology'],
    classificationHints: ['cognitive bias', 'working memory', 'psychometric validity', 'behavioral experiment', 'developmental psychology', 'perceptual learning'],
    modalities: ['text', 'tabular', 'timeseries', 'image', 'audio', 'video'],
    factsAreVolatile: true,
    safetyNotes: 'No diagnosis, coercive profiling, targeted manipulation, or treatment authority; sensitive human data requires consent, privacy, and professional oversight.',
    trainableSkills: [
      'how to evaluate a psychological claim using study design, effect size, and replication evidence',
      'how to distinguish population findings from conclusions about an individual',
    ],
    plannedAdapterId: 'dacais-behavioral-sciences-adapter',
    status: 'REGISTERED',
  },
  {
    id: 'mathematics',
    family: 'physical-sciences',
    title: 'Mathematics, statistics, and calculation',
    summary:
      'Pure and applied mathematics, arithmetic, algebra, geometry, topology, analysis, differential equations, discrete mathematics, probability, statistics, optimization, numerical methods, and formal verification.',
    aliases: ['math', 'mathematical sciences', 'calculations'],
    subdisciplines: ['arithmetic', 'algebra', 'geometry', 'topology', 'calculus', 'real and complex analysis', 'linear algebra', 'number theory', 'combinatorics', 'logic', 'probability', 'statistics', 'optimization', 'differential equations', 'numerical analysis'],
    classificationHints: ['mathematical proof', 'differential equation', 'linear algebra', 'probability distribution', 'numerical integration', 'optimization constraint'],
    modalities: ['text', 'code', 'tabular'],
    factsAreVolatile: false,
    trainableSkills: [
      'how to calculate with explicit units, assumptions, intermediate checks, and error bounds',
      'how to choose an analytical, numerical, statistical, or formal method appropriate to a problem',
      'how to verify a result independently and detect ill-conditioned reasoning',
    ],
    plannedAdapterId: 'dacais-mathematics-adapter',
    status: 'REGISTERED',
  },
  {
    id: 'physics',
    family: 'physical-sciences',
    title: 'Physics',
    summary:
      'Classical mechanics, thermodynamics, statistical mechanics, waves, optics, electromagnetism, relativity, quantum mechanics, condensed matter, particle, plasma, and computational physics.',
    aliases: ['physical science'],
    subdisciplines: ['mechanics', 'thermodynamics', 'statistical mechanics', 'optics', 'quantum physics', 'particle physics', 'condensed matter', 'plasma physics', 'computational physics'],
    classificationHints: ['conservation of momentum', 'thermodynamic entropy', 'quantum state', 'lagrangian mechanics', 'wave equation', 'statistical mechanics'],
    modalities: ['text', 'code', 'tabular', 'timeseries', 'image', 'telemetry'],
    factsAreVolatile: false,
    trainableSkills: [
      'how to construct a physical model with units, symmetries, approximations, and limiting cases',
      'how to compare theory, simulation, and measurement without conflating them',
    ],
    plannedAdapterId: 'dacais-physical-sciences-adapter',
    status: 'REGISTERED',
  },
  {
    id: 'electromagnetism',
    family: 'physical-sciences',
    title: 'Electromagnetism and magnetism',
    summary:
      'Electric and magnetic fields, Maxwell equations, circuits, waves, magnetic materials, spin, plasma interactions, electromagnetic compatibility, sensing, and computation.',
    aliases: ['magnetism', 'electromagnetic physics'],
    classificationHints: ['maxwell equation', 'magnetic flux', 'electromagnetic induction', 'ferromagnetic domain', 'lorentz force', 'electromagnetic compatibility'],
    modalities: ['text', 'code', 'tabular', 'timeseries', 'image', 'telemetry'],
    factsAreVolatile: false,
    trainableSkills: [
      'how to select the electrostatic, magnetostatic, circuit, wave, or full-field model appropriate to a scale',
      'how to verify electromagnetic calculations through units, boundaries, and conservation',
    ],
    plannedAdapterId: 'dacais-physical-sciences-adapter',
    status: 'REGISTERED',
  },
  {
    id: 'gravitation-and-relativity',
    family: 'physical-sciences',
    title: 'Gravitation, relativity, and gravity-control claims',
    summary:
      'Newtonian gravity, general relativity, spacetime, gravitational waves, cosmological gravity, precision tests, and evidence review of proposed gravity modification or shielding.',
    aliases: ['gravity', 'general relativity', 'anti-gravity research'],
    classificationHints: ['equivalence principle', 'spacetime curvature', 'gravitational wave', 'einstein field equation', 'modified gravity theory', 'gravity shielding claim'],
    modalities: ['text', 'code', 'tabular', 'timeseries', 'telemetry'],
    factsAreVolatile: false,
    evidenceNotes: 'Anti-gravity, gravity shielding, and reactionless-propulsion claims are treated as unverified unless supported by reproducible, independently validated evidence consistent with measurement constraints.',
    trainableSkills: [
      'how to distinguish established gravitational physics from speculative mechanisms',
      'how to test a gravity claim against conservation laws, uncertainty, controls, and independent replication',
    ],
    plannedAdapterId: 'dacais-physical-sciences-adapter',
    status: 'REGISTERED',
  },
  {
    id: 'antimatter-physics',
    family: 'physical-sciences',
    title: 'Antimatter and particle physics',
    summary:
      'Antiparticles, pair production and annihilation, symmetries, traps, accelerator and detector science, cosmological asymmetry, measurement, and energy accounting.',
    aliases: ['anti-matter'],
    classificationHints: ['positron annihilation', 'antiproton trap', 'pair production', 'matter antimatter asymmetry', 'charge conjugation', 'particle detector'],
    modalities: ['text', 'code', 'tabular', 'timeseries', 'telemetry'],
    factsAreVolatile: true,
    safetyNotes: 'Research and safety analysis only; no operational authority for controlled sources, accelerators, or hazardous-material handling.',
    trainableSkills: [
      'how to apply conservation laws and detector evidence to antimatter processes',
      'how to keep production, containment, efficiency, and energy claims quantitatively grounded',
    ],
    plannedAdapterId: 'dacais-physical-sciences-adapter',
    status: 'REGISTERED',
  },
  {
    id: 'nanotechnology',
    family: 'engineering',
    title: 'Nanoscience and nanotechnology',
    summary:
      'Nanoscale materials, surfaces, fabrication, characterization, nanoelectronics, nanophotonics, nanomedicine research, self-assembly, modeling, reliability, and environmental health.',
    aliases: ['nanoscience', 'nanoengineering'],
    classificationHints: ['nanoscale fabrication', 'atomic force microscopy', 'self assembled monolayer', 'nanoparticle characterization', 'quantum dot', 'nanostructured material'],
    modalities: ['text', 'code', 'tabular', 'timeseries', 'image', '3d-model'],
    factsAreVolatile: true,
    safetyNotes: 'Material handling, biological exposure, and fabrication require applicable laboratory controls and professional review.',
    trainableSkills: [
      'how to connect nanoscale structure, characterization evidence, and emergent properties',
      'how to state fabrication tolerances, contamination risks, and scale-up assumptions',
    ],
    plannedAdapterId: 'dacais-advanced-materials-adapter',
    status: 'REGISTERED',
  },
  {
    id: 'metamaterials-and-cloaking',
    family: 'engineering',
    title: 'Metamaterials, transformation optics, and cloaking',
    summary:
      'Electromagnetic, acoustic, thermal, and mechanical metamaterials; transformation methods; scattering control; stealth and sensing tradeoffs; fabrication limits; and experimental validation.',
    aliases: ['cloaking technology', 'invisibility research'],
    classificationHints: ['transformation optics', 'negative refractive index', 'metamaterial cloak', 'scattering cancellation', 'acoustic metamaterial', 'electromagnetic stealth'],
    modalities: ['text', 'code', 'tabular', 'timeseries', 'image', '3d-model'],
    factsAreVolatile: true,
    evidenceNotes: 'Broadband, omnidirectional, macroscopic invisibility is not treated as an established capability; claims must state bandwidth, angle, scale, losses, and measurement conditions.',
    safetyNotes: 'Defensive research and lawful engineering only; no assistance for evading authorized detection or enabling harm.',
    trainableSkills: [
      'how to evaluate a cloaking claim against bandwidth, geometry, material loss, and measurement evidence',
      'how to separate laboratory demonstrations from unconstrained real-world capability claims',
    ],
    plannedAdapterId: 'dacais-advanced-materials-adapter',
    status: 'REGISTERED',
  },
  {
    id: 'claytronics',
    family: 'engineering',
    title: 'Claytronics and programmable matter',
    summary:
      'Modular robotic matter, catoms, distributed coordination, reconfiguration, actuation, power, communication, geometry, simulation, and the gap between research prototypes and proposed systems.',
    aliases: ['programmable matter', 'catoms'],
    classificationHints: ['claytronic atom', 'programmable matter', 'modular reconfiguration', 'catom ensemble', 'distributed shape formation', 'electrostatic actuation'],
    modalities: ['code', 'text', 'telemetry', '3d-model', 'video'],
    factsAreVolatile: true,
    evidenceNotes: 'Large-scale general-purpose claytronics remains an emerging research concept; simulations and proposals must not be reported as deployed capability.',
    trainableSkills: [
      'how to decompose programmable-matter behavior into local actuation, communication, and coordination constraints',
      'how to distinguish simulated ensemble behavior from physically demonstrated scale',
    ],
    plannedAdapterId: 'dacais-robotics-adapter',
    status: 'REGISTERED',
  },
  {
    id: 'spatial-edge-technology',
    family: 'engineering',
    title: 'Spatial edge computing and embodied intelligence',
    summary:
      'Low-latency perception and inference near sensors, spatial maps, device and robot coordination, edge accelerators, networking, synchronization, privacy, resilience, and cloud-edge partitioning.',
    aliases: ['spatial edge tech', 'edge spatial computing'],
    classificationHints: ['edge inference accelerator', 'spatial map synchronization', 'sensor edge computing', 'low latency perception', 'cloud edge partition', 'embodied edge intelligence'],
    modalities: ['code', 'telemetry', 'pointcloud', 'depth', 'image', 'video', 'geospatial', '3d-model'],
    factsAreVolatile: true,
    trainableSkills: [
      'how to partition perception, state, and control across device, edge, and cloud constraints',
      'how to reason about latency, bandwidth, privacy, failure, and synchronization together',
    ],
    plannedAdapterId: 'dacais-spatial-adapter',
    status: 'REGISTERED',
  },
  {
    id: 'nuclear-technology',
    family: 'engineering',
    title: 'Nuclear science, technology, and engineering',
    summary:
      'Reactor physics and systems, radiation detection, shielding, thermal hydraulics, materials, fuel-cycle safety, fusion research, safeguards, decommissioning, waste, medicine and industry interfaces.',
    aliases: ['nuclear engineering', 'nuclear technology'],
    classificationHints: ['reactor thermal hydraulics', 'neutron transport', 'radiation shielding', 'nuclear safeguards', 'fusion plasma confinement', 'reactor materials'],
    modalities: ['text', 'code', 'tabular', 'timeseries', 'telemetry', '3d-model'],
    factsAreVolatile: true,
    safetyNotes: 'Safety, safeguards, peaceful research, and regulated engineering only; no weapon design, enrichment optimization, acquisition, or evasion of controls.',
    trainableSkills: [
      'how to structure nuclear-system reasoning around defense in depth, uncertainty, and independent verification',
      'how to distinguish simulation, licensed design data, operating evidence, and regulatory approval',
    ],
    plannedAdapterId: 'dacais-nuclear-sciences-adapter',
    status: 'REGISTERED',
  },
  {
    id: 'intelligence-surveillance-technology',
    family: 'engineering',
    title: 'Intelligence, surveillance, sensing, and counter-surveillance technology',
    summary:
      'Lawful remote sensing, imaging, signals analysis, sensor fusion, geospatial intelligence, cybersecurity telemetry, provenance, privacy engineering, defensive detection, and oversight.',
    aliases: ['spy tech', 'ISR technology', 'intelligence technology'],
    classificationHints: ['sensor fusion surveillance', 'geospatial intelligence', 'signals intelligence analysis', 'counter surveillance detection', 'remote sensing platform', 'intelligence provenance'],
    modalities: ['code', 'text', 'audio', 'image', 'video', 'geospatial', 'telemetry'],
    factsAreVolatile: true,
    safetyNotes: 'Lawful, authorized, defensive, privacy-preserving, and oversight-compatible use only; no unauthorized intrusion, tracking, credential theft, covert targeting, or evasion assistance.',
    trainableSkills: [
      'how to separate collection, observation, inference, confidence, and authorization',
      'how to design defensive sensing with minimization, auditability, and false-positive analysis',
    ],
    plannedAdapterId: 'dacais-defensive-intelligence-technology-adapter',
    status: 'REGISTERED',
  },
  {
    id: 'engineering',
    family: 'engineering',
    title: 'General and cross-disciplinary engineering',
    summary:
      'Requirements, trade studies, design, modeling, manufacturing, integration, verification, validation, safety, reliability, lifecycle, and professional review across engineering disciplines.',
    aliases: ['engineering design', 'systems engineering'],
    subdisciplines: [
      'mechanical', 'electrical', 'electronics', 'computer', 'telecommunications',
      'civil', 'structural', 'geotechnical', 'construction', 'chemical', 'process',
      'materials', 'metallurgical', 'ceramic', 'polymer', 'biomedical', 'biomechanical',
      'industrial', 'manufacturing', 'quality', 'reliability', 'safety', 'systems',
      'control', 'mechatronics', 'robotics', 'aerospace', 'automotive', 'marine',
      'naval', 'ocean', 'environmental', 'energy', 'petroleum', 'mining', 'geological',
      'agricultural', 'food', 'textile', 'optical', 'photonic', 'acoustical',
      'quantum', 'nuclear', 'software', 'hardware',
    ],
    classificationHints: ['engineering requirement', 'design verification', 'failure mode analysis', 'safety factor', 'trade study', 'design review'],
    modalities: ['text', 'code', 'tabular', 'timeseries', 'telemetry', 'image', '3d-model'],
    factsAreVolatile: true,
    safetyNotes: 'Generated designs and analyses remain preliminary until applicable testing, standards review, and qualified professional approval are complete.',
    trainableSkills: [
      'how to turn requirements into traceable constraints, interfaces, models, and verification evidence',
      'how to perform trade studies without hiding assumptions, uncertainty, safety margins, or lifecycle effects',
      'how to distinguish design material from tested, certified, or professionally approved deliverables',
    ],
    plannedAdapterId: 'dacais-general-engineering-adapter',
    status: 'REGISTERED',
  },
  {
    id: 'astrophysics',
    family: 'physical-sciences',
    title: 'Astrophysics and astronomy',
    summary:
      'Stellar and galactic physics, cosmology, compact objects, radiation and spectra, celestial dynamics, instrumentation, observation, and numerical modeling.',
    aliases: ['astronomy', 'space science'],
    classificationHints: ['stellar evolution', 'cosmic microwave background', 'black hole accretion', 'galactic dynamics', 'spectral redshift', 'gravitational lensing'],
    modalities: ['text', 'tabular', 'timeseries', 'image', 'telemetry'],
    factsAreVolatile: false,
    trainableSkills: [
      'how to connect an astronomical observation to a physical model and its assumptions',
      'how to propagate measurement uncertainty through an astrophysical calculation',
      'how to distinguish observation, simulation, and theoretical inference',
    ],
    plannedAdapterId: 'dacais-physical-sciences-adapter',
    status: 'REGISTERED',
  },
  {
    id: 'aerospace-engineering',
    family: 'engineering',
    title: 'Aerospace engineering',
    summary:
      'Aerodynamics, propulsion, structures, flight dynamics, guidance and control, avionics, spacecraft systems, orbital mechanics, manufacturing, verification, and safety.',
    aliases: ['aeronautical engineering', 'astronautical engineering'],
    classificationHints: ['flight dynamics', 'orbital mechanics', 'airframe structure', 'rocket propulsion', 'avionics system', 'aerodynamic coefficient'],
    modalities: ['code', 'text', 'tabular', 'timeseries', 'telemetry', '3d-model'],
    factsAreVolatile: true,
    trainableSkills: [
      'how to decompose an aerospace requirement into coupled subsystem constraints',
      'how to define verification evidence for a simulated aerospace design',
      'how to keep model assumptions, safety margins, and professional review explicit',
    ],
    plannedAdapterId: 'dacais-aerospace-adapter',
    status: 'REGISTERED',
  },
  {
    id: 'mechanical-cad',
    family: 'engineering',
    title: 'Mechanical CAD and parametric geometry',
    summary:
      'Dimensionally constrained parts and assemblies, sketches, features, tolerances, manufacturability, topology inspection, and STEP, STL, and DXF exchange.',
    aliases: ['CAD', 'parametric modeling'],
    classificationHints: ['parametric solid', 'mounting bracket', 'step export', 'clearance hole', 'dimension constraint', 'cad assembly'],
    modalities: ['code', 'text', '3d-model', 'image'],
    factsAreVolatile: true,
    trainableSkills: [
      'how to translate dimensional requirements into a parameterized construction sequence',
      'how to preserve editable source parameters alongside derived geometry',
      'how to separate geometric validation from manufacturing approval',
    ],
    plannedAdapterId: 'dacais-engineering-design-adapter',
    status: 'REGISTERED',
  },
  {
    id: 'architecture-bim',
    family: 'built-environment',
    title: 'Architecture and building information modeling',
    summary:
      'Spatial programs, adjacency, buildings, storeys, spaces, walls, slabs, openings, structural and service systems, IFC exchange, and design-stage validation.',
    aliases: ['BIM', 'IFC architecture'],
    classificationHints: ['ifc building', 'building storey', 'space program', 'wall assembly', 'floor plan adjacency', 'building information model'],
    modalities: ['text', 'tabular', 'geospatial', '3d-model', 'image'],
    factsAreVolatile: true,
    trainableSkills: [
      'how to turn an occupancy brief into a traceable space program and adjacency model',
      'how to preserve semantic building objects instead of flattening them into meshes',
      'how to mark code, permitting, and licensed-signoff requirements explicitly',
    ],
    plannedAdapterId: 'dacais-built-environment-adapter',
    status: 'REGISTERED',
  },
  {
    id: '3d-visualization',
    family: 'human-computer-interaction',
    title: '3D visualization and rendering',
    summary:
      'Scenes, geometry interchange, materials, lighting, cameras, animation, product visualization, architectural walkthroughs, and technical communication.',
    aliases: ['3D rendering', 'computer graphics'],
    classificationHints: ['scene graph', 'physically based material', 'camera path', 'architectural walkthrough', 'exploded view animation', 'render pipeline'],
    modalities: ['code', '3d-model', 'image', 'video'],
    factsAreVolatile: true,
    trainableSkills: [
      'how to translate engineering geometry into a clear visual explanation',
      'how to select cameras, lighting, and materials for inspection rather than deception',
    ],
    plannedAdapterId: 'dacais-visualization-adapter',
    status: 'REGISTERED',
  },
  {
    id: 'engineering-simulation',
    family: 'engineering',
    title: 'Engineering simulation',
    summary:
      'Model preparation, meshing, boundary conditions, structural, fluid, thermal, energy, multibody, and control simulation, convergence, validation, and design iteration.',
    aliases: ['CAE', 'physics simulation'],
    classificationHints: ['boundary condition', 'mesh convergence', 'finite element model', 'computational fluid dynamics', 'multibody dynamics', 'energy simulation'],
    modalities: ['code', 'tabular', 'timeseries', 'telemetry', '3d-model'],
    factsAreVolatile: true,
    trainableSkills: [
      'how to define simulation assumptions, boundary conditions, and acceptance criteria',
      'how to distinguish numerical convergence from physical validation',
      'how to iterate a design from solver evidence without overstating certainty',
    ],
    plannedAdapterId: 'dacais-engineering-simulation-adapter',
    status: 'REGISTERED',
  },
  {
    id: 'market-intelligence',
    family: 'finance-and-markets',
    title: 'Market intelligence',
    summary:
      'Microstructure, liquidity, volatility, regimes, correlation, macro releases, derivatives, risk and portfolio concepts. Research only — separated from advice and from execution authority.',
    modalities: ['timeseries', 'tabular', 'text'],
    classificationHints: ['order book', 'liquidity', 'volatility', 'drawdown', 'market regime', 'bid ask spread'],
    factsAreVolatile: true,
    trainableSkills: [
      'how to structure a market hypothesis with falsifiable conditions',
      'how to describe market context without asserting causation',
      'how to separate research from advice and from execution',
    ],
    plannedAdapterId: 'dacais-market-intelligence-adapter',
    status: 'REGISTERED',
  },
  {
    id: 'trader-behavior',
    family: 'finance-and-markets',
    title: 'Lead trader / account behaviour research',
    summary:
      'Research representation of public or explicitly authorized market participants. Never private account data, never automated mirroring of another participant.',
    modalities: ['tabular', 'timeseries', 'text'],
    factsAreVolatile: true,
    trainableSkills: [
      'how to separate an observed action from a stated rationale and an inferred one',
      'how to qualify confidence in an interpretation of behaviour',
    ],
    plannedAdapterId: 'dacais-market-intelligence-adapter',
    status: 'REGISTERED',
  },
  {
    id: 'market-events',
    family: 'finance-and-markets',
    title: 'Market event dataset',
    summary:
      'Temporal event architecture carrying event / availability / observation timestamps so a historical decision can only read what was actually available at the time.',
    modalities: ['timeseries', 'tabular'],
    factsAreVolatile: true,
    trainableSkills: ['how to reconstruct the information set available at a past moment'],
    plannedAdapterId: 'dacais-market-intelligence-adapter',
    status: 'REGISTERED',
  },
  {
    id: 'forecasting',
    family: 'finance-and-markets',
    title: 'Prediction / forecasting',
    summary:
      'Probabilistic forecasts with horizon, conditions, and invalidating conditions. Evaluated on calibration and Brier score, not on narrative.',
    modalities: ['timeseries', 'tabular'],
    factsAreVolatile: true,
    trainableSkills: [
      'how to express a forecast as a probability with a horizon',
      'how to state the conditions that would invalidate a forecast',
    ],
    plannedAdapterId: 'dacais-market-intelligence-adapter',
    status: 'REGISTERED',
  },
  {
    id: 'backtesting',
    family: 'finance-and-markets',
    title: 'Backtesting / paper trading',
    summary:
      'Simulation layer preceding any live execution: walk-forward and out-of-sample windows, transaction costs, slippage, latency, liquidity limits, drawdown.',
    modalities: ['timeseries', 'tabular'],
    factsAreVolatile: false,
    trainableSkills: [
      'how to design a walk-forward evaluation without leaking future information',
      'how to account for cost, slippage, and latency in a simulated result',
    ],
    plannedAdapterId: 'dacais-market-intelligence-adapter',
    status: 'REGISTERED',
  },
  {
    id: 'onchain-intelligence',
    family: 'finance-and-markets',
    title: 'On-chain market intelligence',
    summary:
      'Wallet behaviour, transfers, DEX swaps, liquidity events, bridges, treasury and stablecoin flows, governance and unlocks. Addresses stay pseudonymous absent legitimate public evidence.',
    modalities: ['tabular', 'timeseries'],
    factsAreVolatile: true,
    trainableSkills: [
      'how to characterise wallet behaviour without asserting an identity',
      'how to corroborate an on-chain interpretation against independent evidence',
    ],
    plannedAdapterId: 'dacais-blockchain-adapter',
    status: 'REGISTERED',
  },
  {
    id: 'spatial',
    family: 'engineering',
    title: 'Spatial intelligence',
    summary:
      'Coordinate systems, reference frames, transforms, quaternions, geometry, localization and mapping, occupancy, point clouds, depth, pose, scene graphs, geospatial state.',
    modalities: ['pointcloud', 'depth', 'image', 'video', 'geospatial', '3d-model', 'telemetry'],
    classificationHints: ['quaternion', 'point cloud', 'occupancy grid', 'reference frame', 'simultaneous localization and mapping'],
    factsAreVolatile: false,
    trainableSkills: [
      'how to reason about spatial transformations between reference frames',
      'how to describe spatial relationships in a scene',
    ],
    plannedAdapterId: 'dacais-spatial-adapter',
    status: 'REGISTERED',
  },
  {
    id: 'robotics',
    family: 'engineering',
    title: 'Robotics',
    summary:
      'ROS 2 graph concepts, transforms, URDF, kinematics, motion planning, navigation, perception, manipulation, simulation and digital twins, edge inference, safety.',
    modalities: ['telemetry', 'pointcloud', 'image', '3d-model', 'code'],
    classificationHints: ['ros 2', 'urdf', 'forward kinematics', 'motion planning', 'robot odometry', 'manipulator trajectory'],
    factsAreVolatile: false,
    trainableSkills: [
      'how to plan a robotic task and state its preconditions',
      'how to reason about a kinematic chain and its constraints',
      'how to recover from a failed motion plan',
    ],
    plannedAdapterId: 'dacais-robotics-adapter',
    status: 'REGISTERED',
  },
  {
    id: 'ar-spatial-computing',
    family: 'human-computer-interaction',
    title: 'AR / spatial computing',
    summary:
      'OpenXR and WebXR, anchors, world and hand tracking, scene understanding, spatial UI, persistent and collaborative spatial state, physical/digital overlays.',
    modalities: ['image', 'video', 'depth', '3d-model', 'telemetry'],
    factsAreVolatile: true,
    trainableSkills: ['how to place and persist digital content against a physical scene'],
    plannedAdapterId: 'dacais-ar-adapter',
    status: 'REGISTERED',
  },
  {
    id: 'digital-human',
    family: 'human-computer-interaction',
    title: 'Digital human / human-machine interface',
    summary:
      'Speech recognition, VAD, turn-taking, streaming generation and TTS, avatar rendering, lip sync, prosody, barge-in, WebRTC real-time media. Voice and likeness use requires explicit authorization.',
    modalities: ['audio', 'video', 'image', 'text'],
    factsAreVolatile: true,
    trainableSkills: [
      'how to manage conversational turn-taking and interruption',
      'how to confirm consent scope before using a voice or likeness',
    ],
    plannedAdapterId: 'dacais-digital-human-adapter',
    status: 'REGISTERED',
  },
  {
    id: 'digital-twin',
    family: 'engineering',
    title: 'Digital twins / physical system state',
    summary:
      'Physical entity identity, sensors, current and historical state, predicted state, simulation, proposed action, authorized action, and confirmed physical result.',
    modalities: ['telemetry', 'timeseries', 'geospatial', '3d-model'],
    factsAreVolatile: true,
    trainableSkills: [
      'how to distinguish observation, estimate, prediction, simulation, command, and confirmed result',
    ],
    plannedAdapterId: 'dacais-spatial-adapter',
    status: 'REGISTERED',
  },
  {
    id: 'ecosystem-intelligence',
    family: 'cross-disciplinary',
    title: 'Public technology & investment ecosystem intelligence',
    summary:
      'Public professional activity of investment firms, operators, portfolio companies, technical communities, and publications: stated theses, public appearances, published writing, and announced investments. Public sources only — never private accounts, authenticated forums, personal data, or non-public activity. Research and positioning only; it produces no outreach and no individual targeting.',
    modalities: ['text'],
    factsAreVolatile: true,
    trainableSkills: [
      'how to separate a publicly stated position from an inferred one',
      'how to qualify confidence in a thematic reading of public activity',
      'how to state what evidence a capability claim does and does not have',
    ],
    plannedAdapterId: 'dacais-ecosystem-adapter',
    status: 'REGISTERED',
  },
  {
    id: 'cross-domain',
    family: 'cross-disciplinary',
    title: 'Cross-domain reasoning',
    summary:
      'Reasoning that spans domains while preserving each source claim provenance. Speculative conclusions are never trained as facts.',
    modalities: ['text', 'code', 'tabular', 'timeseries'],
    factsAreVolatile: true,
    trainableSkills: [
      'how to combine evidence from two domains without discarding provenance',
      'how to mark a cross-domain conclusion as inference rather than fact',
    ],
    plannedAdapterId: 'dacais-cross-domain-adapter',
    status: 'REGISTERED',
  },
];

const BY_ID = new Map<DomainId, DomainDefinition>(DEFINITIONS.map((d) => [d.id, d]));

export function listDomains(): readonly DomainDefinition[] {
  return DEFINITIONS;
}

export function getDomain(id: DomainId): DomainDefinition {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`Unknown domain: ${id}`);
  return found;
}

export function isDomainId(value: string): value is DomainId {
  return BY_ID.has(value as DomainId);
}

export function domainsInFamily(family: DomainFamily): readonly DomainDefinition[] {
  return DEFINITIONS.filter((domain) => domain.family === family);
}

/** Domains whose native data is not text, so ingestion must preserve a native form. */
export function multimodalDomains(): readonly DomainDefinition[] {
  return DEFINITIONS.filter((d) => d.modalities.some((m) => m !== 'text' && m !== 'code'));
}

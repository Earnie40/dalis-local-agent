/**
 * Run the production VC fact extractor over already-admitted public signals.
 *
 * Examples:
 *   node --import tsx scripts/populate-investment-graph.mjs --signal sig_123
 *   node --import tsx scripts/populate-investment-graph.mjs --entity ent_123 --limit 20
 *   node --import tsx scripts/populate-investment-graph.mjs --signal sig_123 --alias sol
 *
 * The script never accepts hand-authored facts. It invokes the same versioned,
 * evidence-bounded pipeline used by IntelligenceService and prints only its
 * durable outcome summary.
 */
import { readFileSync } from 'node:fs';
import { loadAppConfigResult, runMigrations, closePool } from '../packages/shared/src/index.ts';
import {
  PostgresCapabilityStore,
  ProviderRegistry,
  StructuredGenerator,
} from '../packages/providers/src/index.ts';
import {
  InvestmentFactExtractor,
  InvestmentPipeline,
} from '../packages/investor-intelligence/src/index.ts';

for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
}

function valuesFor(flag) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === flag && process.argv[index + 1]) values.push(process.argv[index + 1]);
  }
  return values;
}

const signalIds = valuesFor('--signal');
const entityIds = valuesFor('--entity');
const limitArgument = valuesFor('--limit').at(-1);
const limit = Math.max(1, Math.min(Number(limitArgument ?? 20) || 20, 100));
const alias = valuesFor('--alias').at(-1);
const fallbackAlias = valuesFor('--fallback-alias').at(-1);

if (!signalIds.length && !entityIds.length) {
  console.error('Provide at least one --signal <id> or --entity <id>.');
  process.exitCode = 2;
} else {
  try {
    await runMigrations();
    const { config } = loadAppConfigResult(process.env, {
      modelAliasPath: 'config/models/default.yaml',
    });
    const registry = new ProviderRegistry(config, new PostgresCapabilityStore());
    const pipeline = new InvestmentPipeline(
      new InvestmentFactExtractor(new StructuredGenerator(registry), {
        alias,
        fallbackAlias,
      }),
    );

    for (const signalId of signalIds) {
      const result = await pipeline.processSignal(signalId);
      console.log(JSON.stringify({ mode: 'signal', ...result }, null, 2));
    }
    for (const entityId of entityIds) {
      const result = await pipeline.processUnprocessedEntitySignals({ entityId, limit });
      console.log(JSON.stringify({ mode: 'entity', ...result }, null, 2));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

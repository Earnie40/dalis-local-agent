import { readFileSync } from 'node:fs';
for (const l of readFileSync('.env','utf8').split(/\r?\n/)) { const m=l.match(/^([A-Z][A-Z0-9_]*)=(.*)$/); if(m&&!process.env[m[1]])process.env[m[1]]=m[2].trim(); }
const { MetricEngine, renderMetric } = await import('../packages/investor-intelligence/src/metrics.ts');
const { closePool } = await import('../packages/shared/src/db/pool.ts');
const engine = new MetricEngine();
const all = await engine.refreshAll();
console.log('--- MEASURED ---');
for (const m of all.filter(x=>x.status==='MEASURED')) console.log(' ', renderMetric(m), ` [src: ${m.measurementSource}]`);
console.log('--- NEEDS MEASUREMENT ---');
for (const m of all.filter(x=>x.status!=='MEASURED')) console.log(' ', renderMetric(m));
console.log(`\ntotal=${all.length} measured=${all.filter(x=>x.status==='MEASURED').length} gaps=${all.filter(x=>x.status!=='MEASURED').length}`);
await closePool();

import { readFileSync } from 'node:fs';
for (const l of readFileSync('.env','utf8').split(/\r?\n/)) { const m=l.match(/^([A-Z][A-Z0-9_]*)=(.*)$/); if(m&&!process.env[m[1]])process.env[m[1]]=m[2].trim(); }
const { getPool, closePool } = await import('../packages/shared/src/db/pool.ts');
const p = getPool();
const t = await p.query(`select table_name from information_schema.tables where table_schema='public' and (table_name like 'intelligence%' or table_name like 'dacais%' or table_name like 'content%' or table_name like 'mock_diligence%' or table_name in ('signal_entities','signal_topics','entity_topic_strength','entity_relationships','relationship_sources','portfolio_relationships','claim_evidence','metric_registry','semantic_associations','distribution_channels','investment_memos','opportunity_signals','opportunity_evidence')) order by 1`);
console.log('NEW TABLES:', t.rows.length);
console.log(t.rows.map(r=>r.table_name).join('\n'));
const c = await p.query(`select count(*)::int n from information_schema.table_constraints where constraint_schema='public' and constraint_type='CHECK' and table_name in (select table_name from information_schema.tables where table_schema='public' and (table_name like 'intelligence%' or table_name like 'dacais%' or table_name like 'content%' or table_name like 'mock_diligence%'))`);
console.log('CHECK constraints on new tables:', c.rows[0].n);
await closePool();

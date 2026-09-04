import { readFileSync } from 'node:fs';
for (const l of readFileSync('.env','utf8').split(/\r?\n/)) { const m=l.match(/^([A-Z][A-Z0-9_]*)=(.*)$/); if(m&&!process.env[m[1]])process.env[m[1]]=m[2].trim(); }
const { getPool, closePool } = await import('../packages/shared/src/db/pool.ts');
const p = getPool();
let fails = 0;
const mustReject = async (name, sql, params=[]) => {
  const c = await p.connect();
  try { await c.query('BEGIN'); await c.query(sql, params); await c.query('ROLLBACK');
    console.log(`FAIL  ${name} — insert was ACCEPTED but should have been rejected`); fails++;
  } catch (e) { await c.query('ROLLBACK').catch(()=>{});
    console.log(`PASS  ${name} — rejected: ${String(e.message).split('\n')[0].slice(0,90)}`);
  } finally { c.release(); }
};
const mustAccept = async (name, sql, params=[]) => {
  const c = await p.connect();
  try { await c.query('BEGIN'); await c.query(sql, params); await c.query('ROLLBACK');
    console.log(`PASS  ${name} — accepted as expected`);
  } catch (e) { await c.query('ROLLBACK').catch(()=>{});
    console.log(`FAIL  ${name} — rejected but should be valid: ${String(e.message).split('\n')[0].slice(0,110)}`); fails++;
  } finally { c.release(); }
};

await mustReject('observed signal with zero sources',
  `INSERT INTO intelligence_signals (id,source_url,source_kind,excerpt,content_hash,assertion_class,source_count)
   VALUES ('t1','https://x.test/a','public_website','e','h1','observed',0)`);
await mustReject('inferred signal with no confidence',
  `INSERT INTO intelligence_signals (id,source_url,source_kind,excerpt,content_hash,assertion_class,source_count,confidence)
   VALUES ('t2','https://x.test/b','public_website','e','h2','inferred',1,NULL)`);
await mustAccept('observed signal with a cited source',
  `INSERT INTO intelligence_signals (id,source_url,source_kind,excerpt,content_hash,assertion_class,source_count)
   VALUES ('t3','https://x.test/c','public_website','e','h3','observed',1)`);

await mustReject('UNVERIFIED capability marked publicly shareable',
  `INSERT INTO dacais_capabilities (id,slug,name,description,status,publicly_shareable)
   VALUES ('c1','s1','n','d','UNVERIFIED',true)`);
await mustReject('HORIZON capability marked demonstrable',
  `INSERT INTO dacais_capabilities (id,slug,name,description,status,demonstrable)
   VALUES ('c2','s2','n','d','HORIZON',true)`);
await mustAccept('PRODUCTION capability marked demonstrable+shareable',
  `INSERT INTO dacais_capabilities (id,slug,name,description,status,demonstrable,publicly_shareable)
   VALUES ('c3','s3','n','d','PRODUCTION',true,true)`);

await mustReject('content PUBLISHED with no human approver',
  `INSERT INTO content_assets (id,asset_type,body,state,published_at)
   VALUES ('a1','post','b','PUBLISHED',now())`);
await mustReject('content HUMAN_APPROVED with no approver',
  `INSERT INTO content_assets (id,asset_type,body,state) VALUES ('a2','post','b','HUMAN_APPROVED')`);
await mustAccept('content HUMAN_APPROVED with a named approver',
  `INSERT INTO content_assets (id,asset_type,body,state,approved_by,approved_at)
   VALUES ('a3','post','b','HUMAN_APPROVED','kyle',now())`);

await mustReject('private/http source url',
  `INSERT INTO intelligence_sources (id,source_kind,url,license) VALUES ('s9','public_website','http://insecure.test','CC')`);
await mustReject('non-public source kind (private group)',
  `INSERT INTO intelligence_sources (id,source_kind,url,license) VALUES ('s10','private_group','https://x.test/g','CC')`);
await mustReject('STRONG diligence answer with zero evidence',
  `INSERT INTO mock_diligence_sessions (id,role) VALUES ('d1','skeptical_cto');
   INSERT INTO mock_diligence_questions (id,session_id,question,score,evidence_count)
   VALUES ('q1','d1','q','STRONG',0)`);
await mustReject('MEASURED metric with no value',
  `INSERT INTO metric_registry (id,slug,label,status) VALUES ('m1','s','l','MEASURED')`);

console.log(fails === 0 ? '\nALL INVARIANTS HOLD' : `\n${fails} INVARIANT CHECK(S) FAILED`);
await closePool();
process.exit(fails === 0 ? 0 : 1);

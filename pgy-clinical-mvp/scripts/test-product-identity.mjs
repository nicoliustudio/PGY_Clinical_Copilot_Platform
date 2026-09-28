import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const NORMATIVE_PATH = path.resolve(__dirname, '../../assets/knowledge/releases/2026.09.18-agent-ready-r1/normative.json');

const TARGET_SOURCES = [
  { sourceId: '3b3aae85c6b3', formulaId: 'F_58a4cfb87a4f' },
  { sourceId: 'be1730f747b8', formulaId: 'F_9e0461d223dc' },
  { sourceId: 'be69bd972dc8', formulaId: 'F_42df6ea4eaeb' },
  { sourceId: 'd0e92c2c2c75', formulaId: 'F_190436685219' },
  { sourceId: 'a980232c1964', formulaId: 'F_e9c8bc93e1b7' },
  { sourceId: '0c4de716f6d2', formulaId: 'F_677e4a7e3dc4' },
  { sourceId: '35f9d58eec0c', formulaId: 'F_68c1203cc18a' },
  { sourceId: 'a19c9e286dba', formulaId: 'F_954ef83d2c40' },
  { sourceId: '82baac1481c9', formulaId: 'F_531ba0a9c375' },
];

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  [PASS] ${msg}`);
  } else {
    failed++;
    console.log(`  [FAIL] ${msg}`);
  }
}

console.log('=== P0-A Canonical Product Identity Closure Test ===\n');
console.log(`Loading normative.json from: ${NORMATIVE_PATH}\n`);

const data = JSON.parse(readFileSync(NORMATIVE_PATH, 'utf8'));
console.log(`Total normative entries loaded: ${data.length}\n`);

console.log('--- PART 1: Verify 9 target sources now have UNIQUE active formula ids ---\n');

for (const target of TARGET_SOURCES) {
  const entry = data.find(e => e.id === target.sourceId || e.id === `K_${target.sourceId}` || (e.id && e.id.endsWith(target.sourceId)));
  
  console.log(`Source ${target.sourceId} (expected collision on ${target.formulaId}):`);
  
  if (!entry) {
    assert(false, `Source entry not found for ${target.sourceId}`);
    console.log('');
    continue;
  }
  
  const formulas = entry.formulas || [];
  const activeFormulas = formulas.filter(f => f.entity_status !== 'INACTIVE');
  const idCounts = {};
  
  for (const f of activeFormulas) {
    const id = f.id || '(no-id)';
    idCounts[id] = (idCounts[id] || 0) + 1;
  }
  
  const dupIds = Object.entries(idCounts).filter(([, c]) => c > 1).map(([id]) => id);
  
  assert(dupIds.length === 0, `No duplicate active formula ids (found collisions: ${dupIds.join(', ') || 'none'})`);
  
  const hasOriginal = activeFormulas.some(f => f.id === target.formulaId);
  const hasBSuffix = activeFormulas.some(f => f.id === `${target.formulaId}_b`);
  
  assert(hasOriginal, `Original formula id ${target.formulaId} exists in active formulas`);
  assert(hasBSuffix, `Renamed formula id ${target.formulaId}_b exists in active formulas`);
  
  console.log('');
}

console.log('--- PART 2: Verify NO OTHER P1 source has identity collision ---\n');

let globalCollisions = 0;

for (const entry of data) {
  const entryId = entry.id || 'UNKNOWN';
  const formulas = entry.formulas || [];
  const activeFormulas = formulas.filter(f => f.entity_status !== 'INACTIVE');
  
  const idCounts = {};
  for (const f of activeFormulas) {
    const id = f.id || '(no-id)';
    if (!id || id === '(no-id)') continue;
    idCounts[id] = (idCounts[id] || 0) + 1;
  }
  
  const dupIds = Object.entries(idCounts).filter(([, c]) => c > 1).map(([id, count]) => `${id}(x${count})`);
  
  if (dupIds.length > 0) {
    globalCollisions++;
    assert(false, `Source ${entryId} has colliding active formula ids: ${dupIds.join(', ')}`);
  }
}

assert(globalCollisions === 0, `Zero P1 sources with identity collisions (colliding sources: ${globalCollisions})`);

console.log('\n--- PART 3: Cross-check build.ts invariant logic simulation ---\n');

let buildInvariantThrows = false;
let buildErrorMessage = '';

try {
  for (const entry of data) {
    const formulas = (entry.formulas ?? []).map((f) => ({
      id: typeof f?.id === 'string' ? f.id : '',
      entityStatus: typeof f?.entity_status === 'string' ? f.entity_status : '',
    }));
    const activeFormulas = formulas.filter((f) => f.entityStatus !== 'INACTIVE');
    const idSeen = new Map();
    const duplicates = [];
    for (const f of activeFormulas) {
      if (!f.id) continue;
      if (idSeen.has(f.id)) {
        duplicates.push(f.id);
      } else {
        idSeen.set(f.id, 1);
      }
    }
    if (duplicates.length > 0) {
      const sourceId = entry.id ?? 'UNKNOWN';
      const dupeList = Array.from(new Set(duplicates)).join(', ');
      throw new Error(`[P0-A Identity Closure] P1 source ${sourceId} has colliding ACTIVE formula.id: ${dupeList}. Release copy must have authoritatively unique ids per source.`);
    }
  }
} catch (e) {
  buildInvariantThrows = true;
  buildErrorMessage = e.message;
}

assert(!buildInvariantThrows, `build.ts invariant passes without throwing (error: ${buildErrorMessage || 'none'})`);

console.log('\n=== TEST SUMMARY ===');
console.log(`Total passed: ${passed}`);
console.log(`Total failed: ${failed}`);
console.log(`Result: ${failed === 0 ? 'ALL TESTS PASSED ✓' : 'SOME TESTS FAILED ✗'}`);

process.exit(failed === 0 ? 0 : 1);

import { extract } from './src/extract.ts';

const projectRoot = 'D:/laragon/www/mynews/mynews-order-monitoring-backend';
const files = ['app/Services/GrabMart/GrabMartStoreService.php'];

const r = extract(projectRoot, files, null, true);
const calls = r.edges.filter(e => e.relation === 'calls');

console.log('Total call edges: ' + calls.length);
console.log('');

// Group by source method
const bySource = {};
for (const c of calls) {
  bySource[c.source] = bySource[c.source] || [];
  bySource[c.source].push(c.target);
}

for (const [src, targets] of Object.entries(bySource)) {
  const methodName = src.split('_').pop();
  console.log(methodName + ' (' + targets.length + ' calls):');
  for (const t of targets.slice(0, 10)) {
    console.log('  -> ' + t.split('_').pop());
  }
  if (targets.length > 10) console.log('  ... and ' + (targets.length - 10) + ' more');
}

// Also check if there's a namespace involved
console.log('');
console.log('=== ALL node types in extraction ===');
const types = {};
for (const n of r.nodes) {
  types[n.type] = (types[n.type] || 0) + 1;
}
for (const [t, c] of Object.entries(types)) {
  console.log('  ' + t + ': ' + c);
}

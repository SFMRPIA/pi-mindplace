// Quick test of one fallback file
import { readFileSync } from 'fs';
import { extract } from './src/extract.ts';

const projectRoot = 'D:/laragon/www/mynews/mynews-order-monitoring-backend';

// Test just the 4 large files
const files = [
  'app/Services/GrabMart/GrabMartWebhookHandler.php',
];

console.time('extract');
const r = extract(projectRoot, files, null, true);
console.timeEnd('extract');

console.log('Nodes:', r.nodes.length);
console.log('Edges:', r.edges.length);
const calls = r.edges.filter(e => e.relation === 'calls');
console.log('Call edges:', calls.length);
console.log('Sample calls:', calls.slice(0, 10).map(e => e.target.split('_').pop()));

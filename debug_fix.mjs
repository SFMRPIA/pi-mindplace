// Test the fixed collectCalls by running full extraction and comparing against AST
import { readFileSync, statSync } from 'fs';
import Pkg from 'tree-sitter';
const Parser = Pkg;
import PhpPkg from 'tree-sitter-php';
const Php = PhpPkg;

const parser = new Parser();
parser.setLanguage(Php.php);

import { detect } from './src/detect.ts';
import { extract } from './src/extract.ts';

const projectRoot = 'D:/laragon/www/mynews/mynews-order-monitoring-backend';
const subDir = 'app/Services/GrabMart';
const d = detect(projectRoot + '/' + subDir);
const adjustedFiles = d.files.map(f => subDir + '/' + f);

// Parse each file and count calls by type from the AST
const ast = { func_call: 0, member_call: 0, scoped_call: 0, new_call: 0, files_ok: 0, files_err: 0 };
for (const f of adjustedFiles) {
  const fullPath = projectRoot + '/' + f;
  try {
    const st = statSync(fullPath);
    if (st.size > 1_000_000) continue;
    const source = readFileSync(fullPath, 'utf-8');
    const tree = parser.parse(source);
    ast.func_call += tree.rootNode.descendantsOfType('function_call_expression').length;
    ast.member_call += tree.rootNode.descendantsOfType('member_call_expression').length;
    ast.scoped_call += tree.rootNode.descendantsOfType('scoped_call_expression').length;
    ast.new_call += tree.rootNode.descendantsOfType('object_creation_expression').length;
    ast.files_ok++;
  } catch(e) {
    ast.files_err++;
    console.log('  PARSE ERROR: ' + f.split('/').pop() + ' - ' + e.message);
  }
}

const astTotal = ast.func_call + ast.member_call + ast.scoped_call + ast.new_call;
console.log('AST OK files: ' + ast.files_ok + ', ERR files: ' + ast.files_err);
console.log('AST calls: fc=' + ast.func_call + ' mc=' + ast.member_call + ' sc=' + ast.scoped_call + ' nc=' + ast.new_call + ' total=' + astTotal);
console.log('');

// Now extract
const r = extract(projectRoot, adjustedFiles, null, true);
const calls = r.edges.filter(e => e.relation === 'calls');

console.log('Extracted call edges: ' + calls.length);
console.log('Recall: ' + Math.round(calls.length / astTotal * 100) + '%');

// Show what edges we get for isStoreOpen
const fileKey = 'app_Services_GrabMart_GrabMartStoreService';
const storeCalls = calls.filter(e => e.source.includes(fileKey));
console.log('');
console.log('StoreService call edges (' + storeCalls.length + '):');
const byMethod = {};
for (const c of storeCalls) {
  const method = c.source.split('_').pop() || '';
  byMethod[method] = byMethod[method] || [];
  byMethod[method].push(c.target.split('_').pop());
}
for (const [m, targets] of Object.entries(byMethod)) {
  console.log('  ' + m + ' (' + targets.length + '): ' + targets.join(', '));
}

// Check for Log:: calls
const logCalls = calls.filter(e => e.target.includes('Log'));
console.log('');
console.log('Log calls (' + logCalls.length + '):');
for (const c of logCalls) {
  console.log('  ' + c.source.split('_').pop() + ' -> ' + c.target.split('_').slice(-1).pop());
}

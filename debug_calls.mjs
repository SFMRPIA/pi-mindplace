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

// Count actual AST call nodes per type
const ast = { func_call: 0, member_call: 0, scoped_call: 0, new_call: 0 };
for (const f of adjustedFiles) {
  const fullPath = projectRoot + '/' + f;
  try {
    const st = statSync(fullPath);
    if (st.size > 50000) continue;
    const source = readFileSync(fullPath, 'utf-8');
    const tree = parser.parse(source);
    ast.func_call += tree.rootNode.descendantsOfType('function_call_expression').length;
    ast.member_call += tree.rootNode.descendantsOfType('member_call_expression').length;
    ast.scoped_call += tree.rootNode.descendantsOfType('scoped_call_expression').length;
    ast.new_call += tree.rootNode.descendantsOfType('object_creation_expression').length;
  } catch(e) {}
}

// Now extract the same files
const r = extract(projectRoot, adjustedFiles, null, true);
const callEdges = r.edges.filter(e => e.relation === 'calls');

console.log('=== AST counts (tree-sitter) ===');
console.log('function_call_expression:   ' + ast.func_call);
console.log('member_call_expression:     ' + ast.member_call);
console.log('scoped_call_expression:     ' + ast.scoped_call);
console.log('object_creation_expression: ' + ast.new_call);
const astTotal = ast.func_call + ast.member_call + ast.scoped_call + ast.new_call;
console.log('Total calls in AST:         ' + astTotal);
console.log('');
console.log('=== Extracted call edges ===');
console.log('Total call edges:           ' + callEdges.length);
console.log('Recall:                     ' + Math.round(callEdges.length / astTotal * 100) + '%');

// Show sample of extracted callee names
const callees = callEdges.map(e => e.target.split('_').pop()).filter(Boolean);
const unique = [...new Set(callees)].sort();
console.log('');
console.log('Sample callee names (' + unique.length + ' unique):');
for (const u of unique.slice(0, 20)) console.log('  ' + u);

// Check what's in the first large file (GrabMartController.php)
console.log('');
console.log('=== Checking GrabMartController.php ===');
const ctrlFile = 'app/Http/Controllers/GrabMartController.php';
const ctrlSource = readFileSync(projectRoot + '/' + ctrlFile, 'utf-8');
try {
  const tree2 = parser.parse(ctrlSource);
  const ctrlCalls = {
    fc: tree2.rootNode.descendantsOfType('function_call_expression').length,
    mc: tree2.rootNode.descendantsOfType('member_call_expression').length,
    sc: tree2.rootNode.descendantsOfType('scoped_call_expression').length,
    oc: tree2.rootNode.descendantsOfType('object_creation_expression').length,
  };
  console.log('Controller file AST calls:', ctrlCalls.fc + ctrlCalls.mc + ctrlCalls.sc + ctrlCalls.oc);
  console.log('Breakdown: ' + JSON.stringify(ctrlCalls));
  
  // Extract just this file
  const r2 = extract(projectRoot, [ctrlFile], null, true);
  const ctrlEdges = r2.edges.filter(e => e.relation === 'calls');
  console.log('Extracted call edges from controller:', ctrlEdges.length);
} catch(e) {
  console.log('Controller parse error:', e.message);
}

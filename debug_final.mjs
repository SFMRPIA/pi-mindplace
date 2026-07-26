// Test accuracy WITH the regex fallback for large files
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

// Count AST calls for files that can be parsed
const ast = { func_call: 0, member_call: 0, scoped_call: 0, new_call: 0 };
const fallenBack = [];
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
  } catch(e) {
    fallenBack.push(f);
  }
}

const astTotal = ast.func_call + ast.member_call + ast.scoped_call + ast.new_call;
console.log('AST-parsed files: ' + (adjustedFiles.length - fallenBack.length) + '/' + adjustedFiles.length);
console.log('Fallback files: ' + fallenBack.length);
console.log('AST calls (from parseable files): ' + astTotal);
console.log('');

// Now extract ALL files (should use AST for parseable, regex fallback for large)
const r = extract(projectRoot, adjustedFiles, null, true);
const calls = r.edges.filter(e => e.relation === 'calls');
const nodes = r.nodes;

console.log('=== Extraction results ===');
console.log('Total nodes: ' + nodes.length);
console.log('Total call edges: ' + calls.length);

// Count what was in the fallback files
for (const f of fallenBack) {
  const fbNodes = nodes.filter(n => n.sourceFile === f);
  const fbCalls = calls.filter(c => fbNodes.some(n => n.id === c.source));
  const fbName = f.split('/').pop();
  console.log('  ' + fbName + ': ' + fbNodes.length + ' nodes, ' + fbCalls.length + ' call edges');
}

// Recall estimate: AST total for parseable files vs extracted edges
// The fallback files don't have AST truth, so we estimate their call count via regex
console.log('');
console.log('Recall on AST-parsed files: ' + Math.round(calls.length / astTotal * 100) + '%');
console.log('(Note: fallback files add nodes but no call edges — they have class/func definitions)');

// Show node types
const typeCounts = {};
for (const n of nodes) {
  typeCounts[n.type] = (typeCounts[n.type] || 0) + 1;
}
console.log('');
console.log('Node types:');
for (const [t, c] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
  console.log('  ' + t + ': ' + c);
}

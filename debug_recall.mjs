// Check recall on only the 12 files that CAN be parsed
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
const allFiles = d.files.map(f => subDir + '/' + f);

// Identify which files can be parsed
const parseable = [];
for (const f of allFiles) {
  const fullPath = projectRoot + '/' + f;
  try {
    const st = statSync(fullPath);
    if (st.size > 50000) continue; // skip large files
    const source = readFileSync(fullPath, 'utf-8');
    parser.parse(source);
    parseable.push(f);
  } catch(e) {}
}

console.log('Files that parse: ' + parseable.length + '/' + allFiles.length);

// Count AST calls for parseable files only
const ast = { func_call: 0, member_call: 0, scoped_call: 0, new_call: 0 };
for (const f of parseable) {
  const fullPath = projectRoot + '/' + f;
  const source = readFileSync(fullPath, 'utf-8');
  const tree = parser.parse(source);
  ast.func_call += tree.rootNode.descendantsOfType('function_call_expression').length;
  ast.member_call += tree.rootNode.descendantsOfType('member_call_expression').length;
  ast.scoped_call += tree.rootNode.descendantsOfType('scoped_call_expression').length;
  ast.new_call += tree.rootNode.descendantsOfType('object_creation_expression').length;
}

const astTotal = ast.func_call + ast.member_call + ast.scoped_call + ast.new_call;
console.log('AST calls: ' + astTotal + ' (fc=' + ast.func_call + ' mc=' + ast.member_call + ' sc=' + ast.scoped_call + ' nc=' + ast.new_call + ')');

// Now extract only parseable files
const r = extract(projectRoot, parseable, null, true);
const calls = r.edges.filter(e => e.relation === 'calls');
console.log('Extracted call edges: ' + calls.length);
console.log('Recall on parsed files only: ' + Math.round(calls.length / astTotal * 100) + '%');

// Now add a regex fallback for the 4 large files and measure total
console.log('');
console.log('=== Regex fallback for large files ===');
const largeFiles = allFiles.filter(f => !parseable.includes(f));
console.log('Large files: ' + largeFiles.length);

// Simple regex-based extraction for large PHP files
function extractPhpRegex(filePath, source) {
  const nodes = [];
  const edges = [];
  const seen = new Set();
  const fileNodeId = 'php_regex_' + filePath.replace(/[\\/.]/g, '_');
  nodes.push({ id: fileNodeId, label: filePath + ' [partial]', type: 'file', sourceFile: filePath });
  seen.add(fileNodeId);
  
  // Find function definitions
  const funcRe = /function\s+(&\s*)?(\w+)\s*\(/g;
  let m;
  while ((m = funcRe.exec(source)) !== null) {
    const name = m[2];
    const id = fileNodeId + '_' + name;
    if (!seen.has(id)) {
      seen.add(id);
      const line = source.slice(0, m.index).split('\n').length;
      nodes.push({ id, label: name, type: 'function', sourceFile: filePath, sourceLocation: 'L' + line });
      edges.push({ source: fileNodeId, target: id, relation: 'contains', confidence: 'INFERRED' });
    }
  }
  
  // Find class definitions
  const classRe = /class\s+(\w+)/g;
  while ((m = classRe.exec(source)) !== null) {
    const name = m[1];
    const id = fileNodeId + '_' + name;
    if (!seen.has(id)) {
      seen.add(id);
      nodes.push({ id, label: name, type: 'class', sourceFile: filePath });
      edges.push({ source: fileNodeId, target: id, relation: 'contains', confidence: 'INFERRED' });
    }
  }
  
  return { nodes, edges };
}

let extraCallCount = 0;
for (const f of largeFiles) {
  const fullPath = projectRoot + '/' + f;
  const source = readFileSync(fullPath, 'utf-8');
  
  // Count call-like patterns with regex
  const noStrings = source.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '');
  
  // $obj->method(
  const mc = noStrings.match(/\$\w+->(\w+)\(/g);
  const mcCount = mc ? mc.length : 0;
  
  // function_name( (not preceded by ->, $, ::)
  const fc = noStrings.match(/(?<![->$:.\w])[a-z_]\w+\(/gi);
  const fcCount = fc ? fc.filter(x => !['if(', 'while(', 'for(', 'foreach(', 'switch(', 'catch(', 'return(', 'function(', 'throw(', 'echo('].includes(x)).length : 0;
  
  // new Class(
  const nc = noStrings.match(/new\s+(\w+)\(/g);
  const ncCount = nc ? nc.length : 0;
  
  // Class::method(
  const sc = noStrings.match(/(\w+)::(\w+)\(/g);
  const scCount = sc ? sc.length : 0;
  
  extraCallCount += mcCount + fcCount + ncCount + scCount;
  console.log('  ' + f.split('/').pop() + ': fc=' + fcCount + ' mc=' + mcCount + ' sc=' + scCount + ' nc=' + ncCount);
}

console.log('');
console.log('Estimated call count (regex) for large files: ' + extraCallCount);
console.log('Estimated total AST (if parsable): ' + (astTotal + extraCallCount));
console.log('Estimated recall with regex fallback: ' + Math.round((calls.length + extraCallCount) / (astTotal + extraCallCount) * 100) + '%');

// Test: for the GrabMartStoreService file, check each method's call collection
import { readFileSync } from 'fs';
import Pkg from 'tree-sitter';
const Parser = Pkg;
import PhpPkg from 'tree-sitter-php';
const Php = PhpPkg;

const parser = new Parser();
parser.setLanguage(Php.php);

const file = 'D:/laragon/www/mynews/mynews-order-monitoring-backend/app/Services/GrabMart/GrabMartStoreService.php';
const source = readFileSync(file, 'utf-8');

try {
  const tree = parser.parse(source);
  
  // Find all method declarations
  const methods = tree.rootNode.descendantsOfType('method_declaration');
  console.log('Methods found: ' + methods.length);
  
  let totalFuncCalls = 0;
  let totalMemberCalls = 0;
  let totalScopedCalls = 0;
  let totalNewCalls = 0;
  
  for (const m of methods) {
    const name = m.childForFieldName('name')?.text || 'unknown';
    
    // Count calls via descendantsOfType
    const fc = m.descendantsOfType('function_call_expression').length;
    const mc = m.descendantsOfType('member_call_expression').length;
    const sc = m.descendantsOfType('scoped_call_expression').length;
    const nc = m.descendantsOfType('object_creation_expression').length;
    const total = fc + mc + sc + nc;
    
    totalFuncCalls += fc;
    totalMemberCalls += mc;
    totalScopedCalls += sc;
    totalNewCalls += nc;
    
    if (total > 0) {
      console.log('  ' + name.padEnd(35) + ' fc:' + fc + ' mc:' + mc + ' sc:' + sc + ' nc:' + nc);
    }
  }
  
  console.log('');
  console.log('TOTAL via method.descendantsOfType:');
  console.log('  function_call: ' + totalFuncCalls);
  console.log('  member_call:   ' + totalMemberCalls);
  console.log('  scoped_call:   ' + totalScopedCalls);
  console.log('  new_call:      ' + totalNewCalls);
  console.log('  TOTAL:         ' + (totalFuncCalls + totalMemberCalls + totalScopedCalls + totalNewCalls));
  
  // Compare with root-level descendantsOfType
  const rootFc = tree.rootNode.descendantsOfType('function_call_expression').length;
  const rootMc = tree.rootNode.descendantsOfType('member_call_expression').length;
  const rootSc = tree.rootNode.descendantsOfType('scoped_call_expression').length;
  const rootNc = tree.rootNode.descendantsOfType('object_creation_expression').length;
  console.log('');
  console.log('TOTAL via root.descendantsOfType:');
  console.log('  function_call: ' + rootFc);
  console.log('  member_call:   ' + rootMc);
  console.log('  scoped_call:   ' + rootSc);
  console.log('  new_call:      ' + rootNc);
  console.log('  TOTAL:         ' + (rootFc + rootMc + rootSc + rootNc));

} catch(e) {
  console.log('Parse error:', e.message);
}

// Debug: show exactly what function_call_expression and member_call_expression look like
// within a method that produces wrong edges
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
  
  // Find updateStorePlatformStatus method (it had 12 edges, most of any method)
  const methods = tree.rootNode.descendantsOfType('method_declaration');
  const target = methods.find(m => m.childForFieldName('name')?.text === 'isStoreOpen');
  
  if (target) {
    console.log('=== isStoreOpen method ===');
    console.log(target.text.slice(0, 800));
    console.log('');
    
    // List all function_call_expression within this method
    const funcCalls = target.descendantsOfType('function_call_expression');
    console.log('function_call_expression (' + funcCalls.length + '):');
    for (const fc of funcCalls) {
      const nameNode = fc.childForFieldName?.('name');
      const name = nameNode ? nameNode.text : '(no name field)';
      const text = fc.text.replace(/\n/g, '').slice(0, 80);
      console.log('  name="' + name + '" full="' + text + '"');
    }
    
    // List all member_call_expression
    const memberCalls = target.descendantsOfType('member_call_expression');
    console.log('');
    console.log('member_call_expression (' + memberCalls.length + '):');
    for (const mc of memberCalls) {
      const nameNodes = mc.descendantsOfType('name');
      const nameTexts = nameNodes.map(n => n.text);
      const text = mc.text.replace(/\n/g, '').slice(0, 80);
      console.log('  names=[' + nameTexts.join(',') + '] full="' + text + '"');
    }
    
    // Find all variable names used in the method to see what's a property
    const vars = target.descendantsOfType('variable_name');
    const varNames = [...new Set(vars.map(v => v.text))];
    console.log('');
    console.log('Variables used:', varNames.join(', '));
  }
} catch(e) {
  console.log('Error:', e.message);
}

// Quick test: does the regex fallback find classes/functions in large files?
import { readFileSync } from 'fs';

// Test one of the large files
const file = 'D:/laragon/www/mynews/mynews-order-monitoring-backend/app/Services/GrabMart/GrabMartWebhookHandler.php';
const source = readFileSync(file, 'utf-8');

const stripped = source
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""')
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

// Test class regex
const classRe = /(?:^|\n)\s*(?:abstract\s+|final\s+|readonly\s+)?(?:class|interface|trait)\s+(\w+)/g;
let m;
let count = 0;
while ((m = classRe.exec(stripped)) !== null) {
    count++;
    console.log('class: ' + m[1]);
}
console.log('Total classes: ' + count);

// Test function regex
const funcRe = /(?:^|\n)\s*function\s+(?:&\s*)?(\w+)\s*\(/g;
count = 0;
while ((m = funcRe.exec(stripped)) !== null) {
    count++;
    if (count <= 5) console.log('func: ' + m[1]);
}
console.log('Total functions: ' + count);

import fs from 'fs';

const filePath = 'backend/routes/admin.js';
const content = fs.readFileSync(filePath, 'utf8');
// Detect line endings
const isCRLF = content.includes('\r\n');
const lines = content.split(/\r?\n/);

console.log('Verification of target lines before removal:');
console.log('Line 1693:', lines[1692]); 
console.log('Line 1694:', lines[1693]); 
console.log('Line 1695:', lines[1694]); 
console.log('Line 1696:', lines[1695]); 
console.log('Line 1771:', lines[1770]); 
console.log('Line 1772:', lines[1771]); 
console.log('Line 1773:', lines[1772]); 

if (
  lines[1693] === '});' &&
  lines[1695] === '// GET /api/admin/gift-reports' &&
  lines[1770] === '});' &&
  lines[1772] === '// GET /api/admin/gift-reports'
) {
  console.log('Targets match exactly. Splice removing 77 lines starting from 0-indexed 1694 (line 1695)...');
  lines.splice(1694, 77);
  fs.writeFileSync(filePath, lines.join(isCRLF ? '\r\n' : '\n'), 'utf8');
  console.log('✓ Successfully cleaned backend/routes/admin.js!');
} else {
  console.error('✗ Line mismatch! Cleanup aborted to prevent file corruption.');
}

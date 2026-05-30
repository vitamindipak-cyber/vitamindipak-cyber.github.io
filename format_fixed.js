const fs = require('fs');
const path = require('path');
const vm = require('vm');

const file = path.join(__dirname, 'format.js');
let src = fs.readFileSync(file, 'utf8');
// remove any leading assignment like `module.exports =`
src = src.replace(/^\s*module\.exports\s*=\s*/i, '');
// trim
src = src.trim();
// ensure it's an array literal
if (!src.startsWith('[')) src = '[' + src;
if (!src.endsWith(']')) src = src + ']';

try {
  const data = vm.runInNewContext(src, {}, { filename: 'format.js' });
  module.exports = data;
} catch (e) {
  console.error('Failed to parse format.js:', e.message);
  module.exports = [];
}

const { extractText } = await import('../packages/investor-intelligence/src/research/http.ts');
const NBSP = String.fromCharCode(160);
const html = '<p>Hello' + NBSP + NBSP + 'world</p><script>bad()</script><div>Second\t\tline</div>';
const out = extractText(html);
console.log(JSON.stringify(out));
console.log('collapses NBSP runs:', !out.includes(NBSP + NBSP));
console.log('drops script:', !out.includes('bad()'));
console.log('collapses tabs:', !out.includes('\t\t'));

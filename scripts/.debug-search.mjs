const { WebSearchProvider } = await import('../packages/investor-intelligence/src/research/adapters.ts');
const p = new WebSearchProvider();
try {
  const hits = await p.search('Future Ventures investment thesis', { limit: 5 });
  console.log('hits:', hits.length);
  console.log(hits.slice(0,3));
} catch (e) {
  console.log('ERROR:', e.message, e.cause);
}

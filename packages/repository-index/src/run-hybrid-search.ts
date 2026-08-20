import { hybridSymbolSearch } from './hybrid-retrieval';

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (!args.length) {
    throw new Error(
      'Usage: run-hybrid-search.ts <query>'
    );
  }

  const query = args.join(' ');
  const results = await hybridSymbolSearch(query, 15);

  console.log(JSON.stringify({
    query,
    count: results.length,
    results: results.map((result) => ({
      id: result.id,
      name: result.name,
      kind: result.kind,
      filePath: result.filePath,
      similarity: result.similarity,
      payload: result.payload,
    })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

import { enrichMissingSymbolEmbeddings } from './semantic-symbol-index';

async function main(): Promise<void> {
  const total = await enrichMissingSymbolEmbeddings();
  console.log(`Semantic symbol enrichment complete: ${total} symbols embedded.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

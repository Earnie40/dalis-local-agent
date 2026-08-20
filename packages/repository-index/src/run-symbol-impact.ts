import { dependencyImpact } from './impact-analysis';

async function main(): Promise<void> {
  const target = process.argv.slice(2).join(' ').trim();

  if (!target) {
    throw new Error(
      'Usage: run-symbol-impact.ts <symbol>'
    );
  }

  const result = await dependencyImpact(target);

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

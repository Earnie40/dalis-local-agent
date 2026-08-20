import { buildRepositoryArchitectureMap } from './architecture-map';

async function main(): Promise<void> {
  const map = await buildRepositoryArchitectureMap();

  console.log(JSON.stringify({
    packages: map.packages,
    applications: map.applications,
    fileCount: map.fileCount,
    symbolCount: map.symbolCount,
    edgeCount: map.edgeCount,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

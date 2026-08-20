import { getRepositoryArchitectureMap } from './architecture-map';

async function main(): Promise<void> {
  const map = await getRepositoryArchitectureMap();

  if (!map) {
    throw new Error(
      'Repository architecture map has not been generated.'
    );
  }

  console.log(JSON.stringify({
    repositoryId: map.repositoryId,
    generatedAt: map.generatedAt,
    packages: map.packages,
    applications: map.applications,
    importantFiles: map.importantFiles,
    fileCount: map.fileCount,
    symbolCount: map.symbolCount,
    edgeCount: map.edgeCount,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

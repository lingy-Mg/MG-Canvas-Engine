import { rm } from "node:fs/promises";

const generatedDirectories = [
  "../dist",
  "../coverage",
  "../test-results",
  "../playwright-report",
  "../.pytest_cache",
  "./__pycache__",
  "./ai/__pycache__",
];

for (const directory of generatedDirectories) {
  await rm(new URL(directory, import.meta.url), { recursive: true, force: true, maxRetries: 3 });
}

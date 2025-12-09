import { exists } from "jsr:@std/fs/exists";
import * as path from "jsr:@std/path";

export interface ConceptStatus {
  name: string;
  hasSpec: boolean;
  hasImplementation: boolean;
  hasTest: boolean;
  isComplete: boolean;
}

export interface ConceptFilePaths {
  spec: string;
  implementation: string;
  test: string;
}

/**
 * Get the file paths for a concept's three required files
 */
export function getConceptPaths(conceptName: string): ConceptFilePaths {
  return {
    spec: path.join("design", "concepts", conceptName, `${conceptName}.md`),
    implementation: path.join(
      "src",
      "concepts",
      conceptName,
      `${conceptName}Concept.ts`,
    ),
    test: path.join(
      "src",
      "concepts",
      conceptName,
      `${conceptName}Concept.test.ts`,
    ),
  };
}

/**
 * Check if a concept is complete (has all three required files)
 */
export async function checkConceptStatus(
  conceptName: string,
): Promise<ConceptStatus> {
  const paths = getConceptPaths(conceptName);

  const hasSpec = await exists(paths.spec);
  const hasImplementation = await exists(paths.implementation);
  const hasTest = await exists(paths.test);

  return {
    name: conceptName,
    hasSpec,
    hasImplementation,
    hasTest,
    isComplete: hasSpec && hasImplementation && hasTest,
  };
}

/**
 * Discover all concepts by scanning both design/concepts and src/concepts directories
 * Returns a set of unique concept names found in either directory
 */
export async function discoverConcepts(): Promise<Set<string>> {
  const concepts = new Set<string>();

  // Scan design/concepts directory
  try {
    const designConceptsPath = "design/concepts";
    if (await exists(designConceptsPath)) {
      for await (const dirEntry of Deno.readDir(designConceptsPath)) {
        if (dirEntry.isDirectory) {
          concepts.add(dirEntry.name);
        }
      }
    }
  } catch (_error) {
    // Directory might not exist, continue
  }

  // Scan src/concepts directory
  try {
    const srcConceptsPath = "src/concepts";
    if (await exists(srcConceptsPath)) {
      for await (const dirEntry of Deno.readDir(srcConceptsPath)) {
        if (dirEntry.isDirectory) {
          concepts.add(dirEntry.name);
        }
      }
    }
  } catch (_error) {
    // Directory might not exist, continue
  }

  return concepts;
}

/**
 * Get status for all discovered concepts
 */
export async function getAllConceptStatuses(): Promise<ConceptStatus[]> {
  const conceptNames = await discoverConcepts();
  const statuses = await Promise.all(
    Array.from(conceptNames).map((name) => checkConceptStatus(name)),
  );
  return statuses.sort((a, b) => a.name.localeCompare(b.name));
}

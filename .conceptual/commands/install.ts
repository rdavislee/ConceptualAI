import { apiRequest } from "../utils/api.ts";
import { exists } from "jsr:@std/fs/exists";
import * as path from "jsr:@std/path";

interface DownloadResponse {
  files: Record<string, string>;
  version: number;
  created_at: string;
}

export async function install(conceptArg: string) {
  // Parse USERNAME/CONCEPT_NAME@VERSION format
  const atIndex = conceptArg.indexOf("@");
  const hasVersion = atIndex !== -1;

  const namePart = hasVersion ? conceptArg.slice(0, atIndex) : conceptArg;
  const versionStr = hasVersion ? conceptArg.slice(atIndex + 1) : undefined;

  // Parse USERNAME/CONCEPT_NAME
  const slashIndex = namePart.indexOf("/");
  if (slashIndex === -1) {
    console.error(
      `Error: Username is required. Expected format: {USERNAME}/{CONCEPT_NAME}@{VERSION}`,
    );
    Deno.exit(1);
  }

  const username = namePart.slice(0, slashIndex);
  const conceptName = namePart.slice(slashIndex + 1);

  if (!username || !conceptName) {
    console.error(
      `Error: Invalid format. Expected: {USERNAME}/{CONCEPT_NAME}@{VERSION}`,
    );
    Deno.exit(1);
  }

  let version: number | undefined;
  if (versionStr !== undefined) {
    // Validate that version is an integer
    version = parseInt(versionStr, 10);
    if (isNaN(version) || version.toString() !== versionStr) {
      console.error(`Error: Version must be an integer, got: ${versionStr}`);
      Deno.exit(1);
    }
  }

  try {
    // Make API request
    // unique_name should be just the concept name, not username/conceptName
    const requestBody: {
      unique_name: string;
      author_username: string;
      version?: number;
    } = {
      unique_name: conceptName,
      author_username: username,
    };
    if (version !== undefined) {
      requestBody.version = version;
    }

    // Use longer timeout for download requests (sync operations can take time)
    const response = await apiRequest<DownloadResponse>(
      "/api/concepts/download/version",
      requestBody,
      {
        requireAuth: false, // Authentication is optional
        timeout: 120000, // 2 minutes timeout for download operations
      },
    );

    // Map files to correct workspace locations
    // Expected files:
    // - Specification: design/concepts/{CONCEPT_NAME}/{CONCEPT_NAME}.md
    // - Implementation: src/concepts/{CONCEPT_NAME}/{CONCEPT_NAME}Concept.ts
    // - Test: src/concepts/{CONCEPT_NAME}/{CONCEPT_NAME}Concept.test.ts

    const specPath = path.join(
      "design",
      "concepts",
      conceptName,
      `${conceptName}.md`,
    );
    const implPath = path.join(
      "src",
      "concepts",
      conceptName,
      `${conceptName}Concept.ts`,
    );
    const testPath = path.join(
      "src",
      "concepts",
      conceptName,
      `${conceptName}Concept.test.ts`,
    );

    // Helper function to find file by name pattern
    const findFileByPattern = (
      files: Record<string, string>,
      pattern: RegExp,
    ): [string, string] | null => {
      for (const [filePath, content] of Object.entries(files)) {
        const fileName = path.basename(filePath);
        if (pattern.test(fileName)) {
          return [filePath, content];
        }
      }
      return null;
    };

    // Find the three required files
    const specFile =
      findFileByPattern(response.files, new RegExp(`^${conceptName}\\.md$`)) ||
      findFileByPattern(response.files, /\.md$/);
    const implFile = findFileByPattern(
      response.files,
      new RegExp(`^${conceptName}Concept\\.ts$`),
    ) ||
      findFileByPattern(response.files, /Concept\.ts$/);
    const testFile = findFileByPattern(
      response.files,
      new RegExp(`^${conceptName}Concept\\.test\\.ts$`),
    ) ||
      findFileByPattern(response.files, /Concept\\.test\\.ts$/);

    if (!specFile || !implFile || !testFile) {
      console.error(`Error: Missing required files.`);
      console.error(`Found files:`, Object.keys(response.files));
      console.error(`Expected:`);
      console.error(`  - Specification: ${specPath}`);
      console.error(`  - Implementation: ${implPath}`);
      console.error(`  - Test: ${testPath}`);
      Deno.exit(1);
    }

    // Write files to correct workspace locations
    const filesToWrite: Array<[string, string]> = [
      [specPath, specFile[1]],
      [implPath, implFile[1]],
      [testPath, testFile[1]],
    ];

    for (const [targetPath, content] of filesToWrite) {
      // Ensure the directory exists
      const dirPath = path.dirname(targetPath);
      if (dirPath && dirPath !== ".") {
        if (!(await exists(dirPath))) {
          await Deno.mkdir(dirPath, { recursive: true });
        }
      }

      // Write the file
      await Deno.writeTextFile(targetPath, content);
    }

    console.log(`✓ Installed ${conceptName}`);
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error(`Error: ${String(error)}`);
    }
    Deno.exit(1);
  }
}

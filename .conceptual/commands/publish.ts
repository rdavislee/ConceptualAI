import { apiRequest } from "../utils/api.ts";
import {
  checkConceptStatus,
  getConceptPaths,
} from "../utils/concept-discovery.ts";
import { getAccessToken } from "../utils/config.ts";
import * as path from "jsr:@std/path";

interface PublishResponse {
  concept: string;
  version: string;
  unique_name: string;
  ok: boolean;
}

/**
 * Convert file content to array of numbers (Uint8Array representation)
 */
async function readFileAsBytes(filePath: string): Promise<number[]> {
  const fileBytes = await Deno.readFile(filePath);
  return Array.from(fileBytes);
}

export async function publish(conceptName: string) {
  try {
    // Check if user is authenticated
    const accessToken = await getAccessToken();
    if (!accessToken) {
      console.error(
        "Error: Authentication required. Please run 'conceptual login' first.",
      );
      Deno.exit(1);
    }

    // Validate that the concept exists and is complete
    const status = await checkConceptStatus(conceptName);
    if (!status.isComplete) {
      const missing: string[] = [];
      if (!status.hasSpec) missing.push("specification");
      if (!status.hasImplementation) missing.push("implementation");
      if (!status.hasTest) missing.push("test");

      console.error(`Error: Concept '${conceptName}' is incomplete.`);
      console.error(`Missing files: ${missing.join(", ")}`);
      console.error("\nRequired files:");
      const paths = getConceptPaths(conceptName);
      if (!status.hasSpec) {
        console.error(`  - ${paths.spec}`);
      }
      if (!status.hasImplementation) {
        console.error(`  - ${paths.implementation}`);
      }
      if (!status.hasTest) {
        console.error(`  - ${paths.test}`);
      }
      Deno.exit(1);
    }

    // Get file paths
    const paths = getConceptPaths(conceptName);

    // Read all three files and convert to byte arrays
    const [specBytes, implBytes, testBytes] = await Promise.all([
      readFileAsBytes(paths.spec),
      readFileAsBytes(paths.implementation),
      readFileAsBytes(paths.test),
    ]);

    // Prepare files object with just filenames (no directory paths)
    const files: Record<string, number[]> = {
      [path.basename(paths.spec)]: specBytes,
      [path.basename(paths.implementation)]: implBytes,
      [path.basename(paths.test)]: testBytes,
    };

    // Call publish API endpoint
    const response = await apiRequest<PublishResponse>(
      "/api/registry/publish",
      {
        unique_name: conceptName,
        files,
      },
      {
        requireAuth: true, // Authentication is required
      },
    );

    console.log(`✓ Successfully published ${conceptName}`);
    console.log(`  Concept ID: ${response.concept}`);
    console.log(`  Version ID: ${response.version}`);
  } catch (error) {
    if (error instanceof Error) {
      // Handle specific error messages from API
      if (
        error.message.includes("Authorization") ||
        error.message.includes("token")
      ) {
        console.error(
          "Error: Authentication failed. Please run 'conceptual login' to authenticate.",
        );
      } else if (error.message.includes("already exists")) {
        console.error(`Error: ${error.message}`);
        console.error(
          "Note: The concept already exists. A new version will be created.",
        );
      } else {
        console.error(`Error: ${error.message}`);
      }
    } else {
      console.error(`Error: ${String(error)}`);
    }
    Deno.exit(1);
  }
}

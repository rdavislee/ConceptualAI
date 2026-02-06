/**
 * Entry point for an application built with concepts + synchronizations.
 * Requires the Requesting concept as a bootstrap concept.
 * Please run "deno run import" or "generate_imports.ts" to prepare "@concepts".
 */
import * as concepts from "@concepts";

// Use the following line instead to run against the test database, which resets each time.
// import * as concepts from "@test-concepts";

const { Engine } = concepts;
import { Logging } from "@engine";
import { startRequestingServer } from "@concepts/Requesting/RequestingConcept.ts";
import syncs from "@syncs";

/**
 * Available logging levels:
 *   Logging.OFF
 *   Logging.TRACE - display a trace of the actions.
 *   Logging.VERBOSE - display full record of synchronization.
 */
Engine.logging = Logging.TRACE;

// Register synchronizations
Engine.register(syncs);

// If running in a sandbox for a specific project, trigger the startup action
const sandboxProjectId = Deno.env.get("PROJECT_ID");
if (sandboxProjectId && (concepts.Sandboxing instanceof Object)) {
    const projectName = Deno.env.get("PROJECT_NAME") || "Untitled Project";
    const projectDescription = Deno.env.get("PROJECT_DESCRIPTION") || "";
    const ownerId = Deno.env.get("OWNER_ID") || "";

    console.log(`[Main] Sandbox detected for project ${projectName} (${sandboxProjectId}). Triggering startup...`);
    concepts.Sandboxing.start({
        projectId: sandboxProjectId,
        name: projectName,
        description: projectDescription,
        ownerId
    });
}

// Start a server to provide the Requesting concept with external/system actions.
startRequestingServer(concepts);

import { getAllConceptStatuses, type ConceptStatus } from "../utils/concept-discovery.ts";

function formatMissingFiles(status: ConceptStatus): string {
    const missing: string[] = [];
    if (!status.hasSpec) missing.push("specification");
    if (!status.hasImplementation) missing.push("implementation");
    if (!status.hasTest) missing.push("test");
    return missing.join(", ");
}

export async function list() {
    const statuses = await getAllConceptStatuses();
    
    const complete: ConceptStatus[] = [];
    const incomplete: ConceptStatus[] = [];
    
    for (const status of statuses) {
        if (status.isComplete) {
            complete.push(status);
        } else {
            incomplete.push(status);
        }
    }
    
    // Log completed concepts first
    if (complete.length > 0) {
        console.log("Completed concepts:");
        for (const status of complete) {
            console.log(`  ✓ ${status.name}`);
        }
    } else {
        console.log("No completed concepts found.");
    }
    
    // Log incomplete concepts
    if (incomplete.length > 0) {
        console.log("\nIncomplete concepts:");
        for (const status of incomplete) {
            const missing = formatMissingFiles(status);
            console.log(`  ✗ ${status.name} (missing: ${missing})`);
        }
    } else if (complete.length > 0) {
        console.log("\nAll concepts are complete!");
    }
}


#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read
/**
 * Set a project's status in the Project Ledger by name.
 * Usage: deno run scripts/set_project_status.ts <project-name> <status>
 * Example: deno run scripts/set_project_status.ts "Groupme V4" assembled
 */
import "jsr:@std/dotenv/load";
import { getDb } from "@utils/database.ts";
import ProjectLedgerConcept from "../src/concepts/ProjectLedger/ProjectLedgerConcept.ts";

const projectName = Deno.args[0];
const status = Deno.args[1];

if (!projectName || !status) {
  console.error("Usage: deno run scripts/set_project_status.ts <project-name> <status>");
  console.error('Example: deno run scripts/set_project_status.ts "Groupme V4" assembled');
  Deno.exit(1);
}

const [db, client] = await getDb();
const projects = db.collection("ProjectLedger.projects");

const project = await projects.findOne({ name: projectName });
if (!project) {
  console.error(`Project "${projectName}" not found.`);
  const all = await projects.find({}).toArray();
  if (all.length > 0) {
    console.error("Available projects:");
    for (const p of all) {
      console.error(`  - "${p.name}" (id: ${p._id}, status: ${p.status})`);
    }
  }
  await client.close();
  Deno.exit(1);
}

const ledger = new ProjectLedgerConcept(db);
const result = await ledger.updateStatus({ project: project._id as string, status });
if ("error" in result) {
  console.error("Error:", result.error);
  await client.close();
  Deno.exit(1);
}

console.log(`Updated project "${projectName}" (${project._id}) to status: ${status}`);
await client.close();

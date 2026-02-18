#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read --allow-write
/**
 * Export a project's app graph from SyncGenerating.syncJobs.
 *
 * Usage:
 *   deno run scripts/export_app_graph.ts "<project-name>" [output-json-path]
 *
 * Example:
 *   deno run scripts/export_app_graph.ts "Simple Social" "./simple-social-app-graph.json"
 */
import "jsr:@std/dotenv/load";
import { MongoClient } from "npm:mongodb";

type Candidate = {
  dbName: string;
  project: any;
  syncJob: any;
  appGraphRaw: unknown;
};

const projectName = Deno.args[0];
const outputPath = Deno.args[1] ?? "./simple-social-app-graph.json";

if (!projectName) {
  console.error("Usage: deno run scripts/export_app_graph.ts <project-name> [output-json-path]");
  Deno.exit(1);
}

const mongoUrl = Deno.env.get("MONGODB_URL");
const dbName = Deno.env.get("DB_NAME");

if (!mongoUrl || !dbName) {
  console.error("Missing MONGODB_URL or DB_NAME in .env");
  Deno.exit(1);
}

const client = new MongoClient(mongoUrl);
await client.connect();

try {
  const dbNames = [dbName, `test-meta-${dbName}`, `test-${dbName}`];
  const candidates: Candidate[] = [];

  for (const name of dbNames) {
    const db = client.db(name);
    const projects = await db.collection("ProjectLedger.projects").find({ name: projectName }).toArray();

    for (const project of projects) {
      const syncJob = await db.collection("SyncGenerating.syncJobs").findOne({ _id: project._id });
      if (!syncJob || !syncJob.apiDefinition) continue;

      const appGraphRaw = syncJob.apiDefinition.appGraph;
      if (appGraphRaw === undefined || appGraphRaw === null) continue;

      candidates.push({ dbName: name, project, syncJob, appGraphRaw });
    }
  }

  if (candidates.length === 0) {
    console.error(`No app graph found for project "${projectName}".`);
    console.error("Checked DBs:", dbNames.join(", "));
    Deno.exit(1);
  }

  // Prefer latest project.updatedAt when multiple candidates exist.
  candidates.sort((a, b) => {
    const aTime = new Date(a.project.updatedAt ?? 0).getTime();
    const bTime = new Date(b.project.updatedAt ?? 0).getTime();
    return bTime - aTime;
  });

  const chosen = candidates[0];
  let appGraph: unknown;

  if (typeof chosen.appGraphRaw === "string") {
    try {
      appGraph = JSON.parse(chosen.appGraphRaw);
    } catch {
      console.error("appGraph exists but is not valid JSON.");
      Deno.exit(1);
    }
  } else {
    appGraph = chosen.appGraphRaw;
  }

  await Deno.writeTextFile(outputPath, JSON.stringify(appGraph, null, 2));

  const nodeCount = Array.isArray((appGraph as any)?.nodes) ? (appGraph as any).nodes.length : 0;
  const edgeCount = Array.isArray((appGraph as any)?.edges) ? (appGraph as any).edges.length : 0;

  console.log(`Exported app graph for "${projectName}"`);
  console.log(`DB: ${chosen.dbName}`);
  console.log(`Project ID: ${String(chosen.project._id)}`);
  console.log(`Status: ${String(chosen.project.status)}`);
  console.log(`Nodes: ${nodeCount}, Edges: ${edgeCount}`);
  console.log(`Output: ${outputPath}`);
} finally {
  await client.close();
}

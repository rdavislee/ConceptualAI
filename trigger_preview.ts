import "jsr:@std/dotenv/load";
import { MongoClient } from "npm:mongodb";
import PreviewingConcept from "./src/concepts/Previewing/PreviewingConcept.ts";

async function main() {
  const mongoUrl = Deno.env.get("PREVIEW_MONGODB_URL") || Deno.env.get("MONGODB_URL") || "mongodb://localhost:27017";
  const client = new MongoClient(mongoUrl);
  await client.connect();
  const dbName = Deno.env.get("DB_NAME") || "conceptual-ai";
  const db = client.db(dbName);

  const assemblyCollection = db.collection("Assembling.assemblies");
  const latestAssemblyArr = await assemblyCollection.find().sort({ _id: -1 }).limit(1).toArray();

  if (latestAssemblyArr.length === 0) {
    console.log("No built assemblies found in the database. Please request the AI to build a project first.");
    await client.close();
    return;
  }

  const assembly = latestAssemblyArr[0];
  console.log(`Found built assembly for project ${assembly._id}.`);

  console.log("Instantiating PreviewingConcept and triggering launch via _processQueuedPreivews loop simulation...");
  const previewing = new PreviewingConcept(db);

  try {
    console.log("Triggering launch...");
    const initialStatus = await previewing.launch({
         project: assembly._id,
         owner: assembly.owner || "test_owner",
         mode: "preview"
    });
    console.log("Initial Launch Status:", initialStatus);

    console.log("Waiting for preview to finish (polling db)...");
    while (true) {
       const preview = await db.collection("Previewing.previews").findOne({ _id: assembly._id });
       if (!preview) {
           console.log("Preview disappeared.");
           break;
       }

       if (preview.status === "ready" || preview.status === "error" || preview.status === "stopped") {
           console.log("Preview finished with status:", preview.status);
           if (preview.status === "error") {
               console.error("Error details:", preview.lastError);
           } else if (preview.status === "ready") {
               console.log("Backend URL:", preview.backendUrl);
               console.log("Frontend URL:", preview.frontendUrl);
           }
           break;
       }
       await new Promise(r => setTimeout(r, 2000));
    }
  } catch (err) {
    console.error("Launch failed:", err);
  } finally {
    await client.close();
  }
}

main().catch(console.error);

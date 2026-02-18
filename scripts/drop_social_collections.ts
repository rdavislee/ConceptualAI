import "jsr:@std/dotenv/load";
import { MongoClient } from "npm:mongodb";

const client = new MongoClient(Deno.env.get("MONGODB_URL")!);
await client.connect();
const db = client.db(Deno.env.get("DB_NAME")!);

const prefixes = ["Paginating.", "Liking.", "Commenting.", "Posting."];
const collections = await db.listCollections().toArray();

for (const col of collections) {
  if (prefixes.some((p) => col.name.startsWith(p))) {
    await db.collection(col.name).drop();
    console.log("Dropped:", col.name);
  }
}

console.log("Done");
await client.close();

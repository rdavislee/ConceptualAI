import { getDb } from "./src/utils/database.ts";

async function check() {
  const [db, client] = await getDb();
  const plans = db.collection("Planning.plans");
  const project = "019c30f9-cba6-70c6-a967-4235e0baccd8";
  const plan = await plans.findOne({ _id: project });
  console.log("PLAN FOR PROJECT " + project + ":");
  console.log(JSON.stringify(plan, null, 2));
  await client.close();
}

check();

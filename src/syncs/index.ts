import { syncs as authSyncs } from "./auth.sync.ts";
import { syncs as designingSyncs } from "./designing.sync.ts";
import { syncs as implementingSyncs } from "./implementing.sync.ts";
import { syncs as planningSyncs } from "./planning.sync.ts";
import { syncs as projectsSyncs } from "./projects.sync.ts";
import { syncs as queriesSyncs } from "./queries.sync.ts";
import { syncs as assemblingSyncs } from "./assembling.sync.ts";

export default [
  ...authSyncs,
  ...designingSyncs,
  ...implementingSyncs,
  ...planningSyncs,
  ...projectsSyncs,
  ...queriesSyncs,
  ...assemblingSyncs,
];

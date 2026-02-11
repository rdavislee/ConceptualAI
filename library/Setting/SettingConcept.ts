import { Collection, Db } from "npm:mongodb";
import { ID } from "@utils/types.ts";

// Generic external parameter types
// Setting [Namespace]
export type Namespace = ID;

const PREFIX = "Setting" + ".";

interface SettingState {
  _id: Namespace; // namespace
  data: Record<string, any>;
  updatedAt: Date;
}

/**
 * @concept Setting
 * @purpose Store and retrieve singleton configuration data.
 * @principle A setting is a single data object associated with a unique namespace.
 */
export default class SettingConcept {
  settings: Collection<SettingState>;

  constructor(private readonly db: Db) {
    this.settings = this.db.collection<SettingState>(PREFIX + "settings");
  }

  /**
   * Action: setSetting (namespace: Namespace, data: Object) : (ok: Flag)
   */
  async setSetting(
    { namespace, data }: { namespace: Namespace; data: Record<string, any> },
  ): Promise<{ ok: boolean } | { error: string }> {
    if (!data || Object.keys(data).length === 0) {
      return { error: "Data must be a non-empty object" };
    }

    await this.settings.updateOne(
      { _id: namespace },
      {
        $set: {
          data,
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );

    return { ok: true };
  }

  /**
   * Action: deleteSetting (namespace: Namespace) : (ok: Flag)
   * Optional cleanup for reset/rollback workflows.
   */
  async deleteSetting(
    { namespace }: { namespace: Namespace },
  ): Promise<{ ok: boolean }> {
    await this.settings.deleteOne({ _id: namespace });
    return { ok: true };
  }

  /**
   * Query: _getSetting (namespace: Namespace) : (data: Object | null)
   */
  async _getSetting(
    { namespace }: { namespace: Namespace },
  ): Promise<Array<{ data: Record<string, any> | null }>> {
    const doc = await this.settings.findOne({ _id: namespace });
    return [{ data: doc?.data ?? null }];
  }
}

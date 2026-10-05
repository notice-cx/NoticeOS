// The Tower's six historical sample sites are explicit Postgres fixtures.
import INVENTED from "../../../db/fixtures/invented-sites.json";
import { addSites } from "./sites";
import type { TestStore } from "./postgres-store";

export const TEST_OS_ASSET: string = INVENTED.os.id;

export async function seedAssets(to: TestStore): Promise<void> {
  await addSites(to, [INVENTED.os, ...INVENTED.sites.slice(0, 5)]);
}

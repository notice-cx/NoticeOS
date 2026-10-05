// Complete synthetic sites, inserted in fixture order into each fresh Postgres copy.
import INVENTED from '../../../db/fixtures/invented-sites.json';
import { addSites, type TestSite } from './sites';

export const TEST_OS_ASSET: string = INVENTED.os.id;
export const TEST_SITES: readonly TestSite[] = [INVENTED.os, ...INVENTED.sites] as TestSite[];

export async function seedTestSites(): Promise<void> {
  await addSites([...TEST_SITES]);
}

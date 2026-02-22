/**
 * Reader for historical data.
 */

import type { HistoricalDataStore } from '../types/historicalData';
import { getGlobalDataPath } from '../paths';
import { readJsonStore } from './helpers';

export async function readHistory(): Promise<HistoricalDataStore | null> {
  const filePath = getGlobalDataPath('historical-data.json');
  return readJsonStore<HistoricalDataStore>(filePath);
}

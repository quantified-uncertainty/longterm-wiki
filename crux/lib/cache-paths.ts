/**
 * Cache directory paths
 *
 * Constants for the .cache/ directory structure used by source fetching
 * and other local caching. Previously lived in knowledge-db.ts.
 */

import { join } from 'path';
import { PROJECT_ROOT } from './content-types.ts';

export const CACHE_DIR = join(PROJECT_ROOT, '.cache');
export const SOURCES_DIR = join(CACHE_DIR, 'sources');

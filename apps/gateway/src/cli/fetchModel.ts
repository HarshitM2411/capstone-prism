/**
 * Downloads the embedding model into the cache directory and checks that it produces vectors of
 * the expected size. Run at image build time, so the running gateway never needs the network
 * (and starts with the model already on disk); also handy once on a development machine.
 *
 *   pnpm --filter @prism/gateway model:fetch
 *
 * Reads EMBEDDING_MODEL and EMBEDDING_CACHE_DIR like the gateway does.
 */
import { DEFAULT_EMBEDDING_CACHE_DIR } from '../config/env.js';
import {
  DEFAULT_EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  embedTexts,
  loadExtractor,
} from '../embeddings/embedCore.js';

async function main(): Promise<void> {
  const model = process.env.EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;
  const cacheDir = process.env.EMBEDDING_CACHE_DIR?.trim() || DEFAULT_EMBEDDING_CACHE_DIR;
  console.log(`fetching ${model} into ${cacheDir}`);
  const extractor = await loadExtractor({ model, cacheDir });
  const [vector] = await embedTexts(extractor, ['model check']);
  if (vector === undefined || vector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `${model} produces ${vector?.length ?? 0}-dimensional vectors; the cache table expects ${EMBEDDING_DIMENSIONS}`,
    );
  }
  console.log(`ok: ${vector.length} dimensions`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

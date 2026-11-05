/**
 * The model itself, shared by the worker thread and by anything that wants it in-process (the
 * model download script, tests). Wraps `@huggingface/transformers` behind a minimal shape so the
 * rest of the code never touches its large generic types.
 */
export const DEFAULT_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DIMENSIONS = 384;

export interface ModelSettings {
  /** A Hugging Face model id; downloaded into `cacheDir` the first time it is used. */
  model: string;
  cacheDir: string;
}

export type Extractor = (
  texts: string[],
  options: { pooling: 'mean'; normalize: true },
) => Promise<{ tolist(): number[][] }>;

type PipelineFactory = (
  task: 'feature-extraction',
  model: string,
  options: { dtype: 'q8' },
) => Promise<Extractor>;

export async function loadExtractor(settings: ModelSettings): Promise<Extractor> {
  const transformers = await import('@huggingface/transformers');
  transformers.env.cacheDir = settings.cacheDir;
  const pipeline = transformers.pipeline as unknown as PipelineFactory;
  // The 8-bit quantised weights: about a quarter of the size, same behaviour for this purpose.
  return pipeline('feature-extraction', settings.model, { dtype: 'q8' });
}

export async function embedTexts(extractor: Extractor, texts: string[]): Promise<number[][]> {
  const output = await extractor(texts, { pooling: 'mean', normalize: true });
  return output.tolist();
}

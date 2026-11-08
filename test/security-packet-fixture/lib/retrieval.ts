import { embed } from 'ai';
import { openai } from '@ai-sdk/openai';
import { pool } from './db';

export const EMBEDDING_MODEL = 'text-embedding-3-small';

export async function embedText(text: string) {
  const { embedding } = await embed({ model: openai.embedding(EMBEDDING_MODEL), value: text });
  return embedding;
}

// pgvector similarity search, always filtered to the caller's tenant.
export async function searchPolicies(tenantId: string, query: string, k = 6) {
  const vector = await embedText(query);
  const { rows } = await pool.query(
    `SELECT id, title, chunk, 1 - (embedding <=> $2::vector) AS score
       FROM policy_chunks
      WHERE tenant_id = $1
      ORDER BY embedding <=> $2::vector
      LIMIT $3`,
    [tenantId, JSON.stringify(vector), k],
  );
  return rows;
}

export async function storeChunk(tenantId: string, title: string, chunk: string) {
  const vector = await embedText(chunk);
  await pool.query(
    'INSERT INTO policy_chunks (tenant_id, title, chunk, embedding) VALUES ($1, $2, $3, $4::vector)',
    [tenantId, title, chunk, JSON.stringify(vector)],
  );
}

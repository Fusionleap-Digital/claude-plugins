import { pool } from '@/lib/db';

export async function POST(req: Request) {
  if (req.headers.get('x-api-key') !== process.env.REINDEX_API_KEY) return new Response('Forbidden', { status: 403 });
  await pool.query('REINDEX INDEX policy_chunks_embedding_idx');
  return Response.json({ ok: true });
}

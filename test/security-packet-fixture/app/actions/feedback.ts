'use server';

import { pool } from '@/lib/db';

export async function submitFeedback(conversationId: string, rating: number, comment: string) {
  await pool.query('INSERT INTO feedback (conversation_id, rating, comment) VALUES ($1, $2, $3)', [conversationId, rating, comment]);
}

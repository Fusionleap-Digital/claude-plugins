import { Pool } from 'pg';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true },
  max: 10,
});

// Every turn of every conversation is kept for the adjuster's audit trail.
export async function saveMessage(tenantId: string, conversationId: string, role: string, content: string) {
  await pool.query(
    'INSERT INTO chat_messages (tenant_id, conversation_id, role, content, created_at) VALUES ($1, $2, $3, $4, now())',
    [tenantId, conversationId, role, content],
  );
}

export async function writeAudit(tenantId: string, userEmail: string, action: string, detail: object) {
  await pool.query(
    'INSERT INTO audit_log (tenant_id, user_email, action, detail, at) VALUES ($1, $2, $3, $4, now())',
    [tenantId, userEmail, action, JSON.stringify(detail)],
  );
}

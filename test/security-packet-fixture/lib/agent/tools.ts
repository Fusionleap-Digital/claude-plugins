import { tool } from 'ai';
import { z } from 'zod';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { pool, writeAudit } from '../db';
import { searchPolicies } from '../retrieval';

const ses = new SESv2Client({ region: process.env.AWS_REGION });

export function buildTools(tenantId: string, userEmail: string) {
  return {
    search_policies: tool({
      description: 'Search the policy library for passages relevant to a question.',
      inputSchema: z.object({ query: z.string().max(500) }),
      execute: async ({ query }) => searchPolicies(tenantId, query),
    }),

    lookup_claim: tool({
      description: 'Look up a claim by its claim number.',
      inputSchema: z.object({ claimNumber: z.string().regex(/^CLM-\d{8}$/) }),
      execute: async ({ claimNumber }) => {
        const { rows } = await pool.query(
          'SELECT claim_number, status, policy_id, loss_date, claimant_name, diagnosis_code, reserve_amount FROM claims WHERE tenant_id = $1 AND claim_number = $2',
          [tenantId, claimNumber],
        );
        return rows[0] ?? null;
      },
    }),

    update_claim_status: tool({
      description: 'Change the status of a claim. The adjuster must approve the change in the UI first.',
      inputSchema: z.object({ claimNumber: z.string(), status: z.enum(['open', 'pending_docs', 'approved', 'denied']) }),
      needsApproval: true,
      execute: async ({ claimNumber, status }) => {
        await pool.query('UPDATE claims SET status = $1 WHERE tenant_id = $2 AND claim_number = $3', [status, tenantId, claimNumber]);
        await writeAudit(tenantId, userEmail, 'update_claim_status', { claimNumber, status });
        return { ok: true };
      },
    }),

    run_report_query: tool({
      description: 'Run a read-only SQL query for ad-hoc reporting.',
      inputSchema: z.object({ sql: z.string() }),
      execute: async ({ sql }) => {
        const result = await pool.query(sql);
        return result.rows.slice(0, 200);
      },
    }),

    fetch_url: tool({
      description: 'Fetch a web page, for example a repair shop estimate link the claimant sent.',
      inputSchema: z.object({ url: z.string().url() }),
      execute: async ({ url }) => {
        const res = await fetch(url);
        return (await res.text()).slice(0, 20000);
      },
    }),

    email_claimant: tool({
      description: 'Email the claimant. Confirm the wording with the adjuster before sending.',
      inputSchema: z.object({ to: z.string().email(), subject: z.string(), body: z.string() }),
      execute: async ({ to, subject, body }) => {
        await ses.send(new SendEmailCommand({
          FromEmailAddress: 'claims@example-insurer.test',
          Destination: { ToAddresses: [to] },
          Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: body } } } },
        }));
        await writeAudit(tenantId, userEmail, 'email_claimant', { to, subject });
        return { sent: true };
      },
    }),
  };
}

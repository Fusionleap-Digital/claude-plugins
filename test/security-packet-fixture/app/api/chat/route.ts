import { streamText, stepCountIs } from 'ai';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { z } from 'zod';
import { auth } from '@/auth';
import { CHAT_MODEL, SYSTEM_PROMPT, wrapDocuments } from '@/lib/llm';
import { searchPolicies } from '@/lib/retrieval';
import { buildTools } from '@/lib/agent/tools';
import { saveMessage } from '@/lib/db';
import { langfuse } from '@/lib/telemetry';

const ratelimit = new Ratelimit({ redis: Redis.fromEnv(), limiter: Ratelimit.slidingWindow(20, '1 m') });

const Body = z.object({
  conversationId: z.string().uuid(),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(8000) })).max(50),
});

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.email) return new Response('Unauthorized', { status: 401 });
  const tenantId = (session as { tenantId?: string }).tenantId;
  if (!tenantId) return new Response('Forbidden', { status: 403 });

  const { success } = await ratelimit.limit(session.user.email);
  if (!success) return new Response('Too many requests', { status: 429 });

  const { conversationId, messages } = Body.parse(await req.json());
  const question = messages[messages.length - 1].content;
  console.log('chat question', { user: session.user.email, question });

  const docs = await searchPolicies(tenantId, question);
  const trace = langfuse.trace({ name: 'chat', userId: session.user.email, input: question });
  await saveMessage(tenantId, conversationId, 'user', question);

  const result = streamText({
    model: CHAT_MODEL,
    system: `${SYSTEM_PROMPT}\n\n${wrapDocuments(docs)}`,
    messages,
    tools: buildTools(tenantId, session.user.email),
    stopWhen: stepCountIs(5),
    maxOutputTokens: 2000,
    onFinish: async ({ text }) => {
      await saveMessage(tenantId, conversationId, 'assistant', text);
      trace.update({ output: text });
    },
  });
  return result.toUIMessageStreamResponse();
}

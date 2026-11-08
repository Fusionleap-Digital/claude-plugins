import { Langfuse } from 'langfuse';

// Traces every model call, including the full prompt and completion.
export const langfuse = new Langfuse({
  secretKey: process.env.LANGFUSE_SECRET_KEY,
  publicKey: process.env.NEXT_PUBLIC_LANGFUSE_PUBLIC_KEY,
  baseUrl: process.env.LANGFUSE_BASEURL ?? 'https://cloud.langfuse.com',
});

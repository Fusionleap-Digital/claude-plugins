import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { storeChunk } from '@/lib/retrieval';

const s3 = new S3Client({ region: process.env.AWS_REGION });

function chunk(text: string, size = 1500) {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

// Called by the document worker after it extracts text from an upload.
export async function POST(req: Request) {
  const { tenantId, title, text, original } = await req.json();
  await s3.send(new PutObjectCommand({ Bucket: process.env.DOCS_BUCKET, Key: `${tenantId}/${title}`, Body: original }));
  for (const c of chunk(text)) await storeChunk(tenantId, title, c);
  return Response.json({ ok: true });
}

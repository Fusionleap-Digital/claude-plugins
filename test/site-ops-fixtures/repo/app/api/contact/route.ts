import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_SERVER || 'smtp.zoho.com',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD },
});

export async function POST(request: Request) {
  const { DATABASE_URL } = process.env;
  await transporter.sendMail({ to: process.env['EMAIL_TO'], text: String(DATABASE_URL && 'saved') });
  return Response.json({ ok: true });
}

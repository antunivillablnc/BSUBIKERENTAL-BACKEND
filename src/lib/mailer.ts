import { Resend } from 'resend';

export type SendMailOptions = {
  to: string;
  subject: string;
  html?: string;
  text?: string;
  from?: string;
  replyTo?: string;
};

let cachedClient: Resend | null = null;

function getClient(): Resend {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.RESEND_API_KEY || '';
  cachedClient = new Resend(apiKey);
  return cachedClient;
}

export async function sendMail(options: SendMailOptions) {
  const resend = getClient();
  const fromAddress = options.from || process.env.RESEND_FROM || '';
  const replyTo = options.replyTo || process.env.RESEND_REPLY_TO;
  if (!fromAddress) {
    throw new Error('RESEND_FROM is not configured');
  }
  const payload: any = {
    from: fromAddress,
    to: options.to,
    subject: options.subject,
  };
  if (options.html) payload.html = options.html;
  if (options.text) payload.text = options.text;
  if (replyTo) payload.replyTo = replyTo;
  return resend.emails.send(payload);
}



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

export function renderBrandedEmail(opts: {
  title?: string;
  intro?: string;
  ctaHref?: string;
  ctaText?: string;
  bodyHtml?: string; // additional HTML under intro/CTA
  footerNote?: string;
}) {
  const appName = process.env.APP_NAME || 'SPARTA';
  const baseFrontend = (process.env.FRONTEND_BASE_URL || '').replace(/\/$/, '');
  const logoEnv = process.env.APP_LOGO_URL || '';
  const logoUrl = logoEnv || (baseFrontend ? `${baseFrontend}/spartan_logo.png` : '');
  const { title, intro, ctaHref, ctaText, bodyHtml, footerNote } = (opts || ({} as any));
  const buttonHtml = ctaHref && ctaText
    ? `<p style="margin:20px 0 24px 0; text-align:center;"><a href="${ctaHref}" style="display:inline-block;background:#FFD600;color:#222;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.08)">${ctaText}</a></p>`
    : '';
  const fallbackHtml = ctaHref
    ? `<p style="color:#555;font-size:14px;margin-top:0">If the button doesn’t work, copy and paste this URL into your browser:</p><p style="word-break:break-all;color:#1976d2">${ctaHref}</p>`
    : '';
  const contentHtml = `${intro ? `<p>${intro}</p>` : ''}${buttonHtml}${bodyHtml || ''}${fallbackHtml}`;
  return `<!DOCTYPE html>
  <html lang="en">
    <head>
      <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${title || appName}</title>
      <style>
        body { margin:0; padding:0; background:#f6f7fb; font-family:Arial,Helvetica,sans-serif; color:#111; }
        .container { max-width:600px; margin:24px auto; padding:0 16px; }
        .card { background:#ffffff; border-radius:12px; box-shadow:0 4px 24px rgba(16,24,40,0.06); overflow:hidden; }
        .header { padding:20px 24px; border-bottom:1px solid #eee; display:flex; align-items:center; gap:12px; }
        .brand { font-size:18px; font-weight:700; color:#b22222; letter-spacing:0.3px; }
        .content { padding:24px; line-height:1.6; }
        .footer { padding:16px 24px; color:#777; font-size:12px; border-top:1px solid #f0f0f0; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="card">
          <div class="header">${logoUrl ? `<img src="${logoUrl}" alt="${appName}" width="36" height="36" style="display:inline-block;border-radius:6px"/>` : ''}<div class="brand">${appName}</div></div>
          <div class="content">
            ${title ? `<h2 style="margin:0 0 12px 0">${title}</h2>` : ''}
            ${contentHtml}
          </div>
          <div class="footer">${footerNote || appName}</div>
        </div>
      </div>
    </body>
  </html>`;
}



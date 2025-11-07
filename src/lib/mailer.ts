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
  const primary = process.env.THEME_PRIMARY || '#b22222';
  const primary2 = process.env.THEME_PRIMARY_2 || '#8c1515';
  const accent = process.env.THEME_ACCENT || '#FFD600';
  const bg = process.env.THEME_BG || '#f6f7fb';
  const text = process.env.THEME_TEXT || '#111';
  const linkColor = process.env.THEME_LINK || '#1976d2';
  const tagline = process.env.APP_TAGLINE || 'Rent. Ride. Return. Spartan‑style.';
  const { title, intro, ctaHref, ctaText, bodyHtml, footerNote } = (opts || ({} as any));
  const buttonHtml = ctaHref && ctaText
    ? `<p style="margin:20px 0 24px 0; text-align:center;"><a href="${ctaHref}" style="display:inline-block;background:${accent};color:#222;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:10px;box-shadow:0 4px 14px rgba(0,0,0,0.12)">${ctaText}</a></p>`
    : '';
  const fallbackHtml = ctaHref
    ? `<p style="color:#555;font-size:14px;margin-top:0">If the button doesn’t work, copy and paste this URL into your browser:</p><p style="word-break:break-all;color:${linkColor}">${ctaHref}</p>`
    : '';
  const contentHtml = `${intro ? `<p>${intro}</p>` : ''}${buttonHtml}${bodyHtml || ''}${fallbackHtml}`;
  return `<!DOCTYPE html>
  <html lang="en">
    <head>
      <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${title || appName}</title>
      <style>
        body { margin:0; padding:0; background:${bg}; font-family:Arial,Helvetica,sans-serif; color:${text}; }
        .container { max-width:640px; margin:24px auto; padding:0 16px; }
        .card { background:#ffffff; border-radius:14px; box-shadow:0 8px 28px rgba(16,24,40,0.15); overflow:hidden; }
        .header { padding:18px 24px; background:${primary}; background-image:linear-gradient(90deg, ${primary} 0%, ${primary2} 100%); display:flex; flex-direction:column; align-items:center; justify-content:center; }
        .brand { font-size:18px; font-weight:800; color:#ffffff; letter-spacing:0.4px; text-transform:uppercase; }
        .tagline { margin-top:4px; font-size:12px; color:#fff; opacity:0.9; }
        .headerBar { height:4px; background-image:linear-gradient(90deg, ${accent} 0%, #ffc400 100%); }
        .content { padding:24px; line-height:1.6; text-align:center; }
        .content h2 { color:${primary}; margin:0 0 12px 0; font-size:20px; text-align:center; }
        .divider { height:1px; background:#eee; margin:8px 0 16px 0; }
        .panel { background:#fffdf3; border:1px solid #ffe58f; border-radius:10px; padding:16px; text-align:center; }
        .footer { padding:16px 24px; color:#777; font-size:12px; background:#fafafa; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="card">
          <div class="header"><div class="brand">${appName}</div><div class="tagline">${tagline}</div></div>
          <div class="headerBar"></div>
          <div class="content">
            ${title ? `<h2>${title}</h2><div class="divider"></div>` : ''}
            <div class="panel">${contentHtml}</div>
          </div>
          <div class="footer">${footerNote || appName}</div>
        </div>
      </div>
    </body>
  </html>`;
}



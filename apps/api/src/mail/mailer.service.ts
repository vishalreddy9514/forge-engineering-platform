import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';

import type { Env } from '../config/env';
import type { RenderedEmail } from './templates';

/**
 * Email delivery: SMTP (Mailpit locally) or Amazon SES's API in AWS, where the task role signs
 * the request and no SMTP password exists (docs/deployment.md).
 */
@Injectable()
export class MailerService implements OnModuleDestroy {
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(config: ConfigService<Env, true>) {
    this.transport =
      config.get('MAIL_TRANSPORT', { infer: true }) === 'ses'
        ? createTransport({ SES: { sesClient: new SESv2Client({}), SendEmailCommand } })
        : smtpTransport(config);
    this.from = config.get('MAIL_FROM', { infer: true });
  }

  async send(to: string, email: RenderedEmail): Promise<void> {
    await this.transport.sendMail({ from: this.from, to, ...email });
  }

  onModuleDestroy(): void {
    this.transport.close();
  }
}

function smtpTransport(config: ConfigService<Env, true>): Transporter {
  const user = config.get('SMTP_USER', { infer: true });
  const pass = config.get('SMTP_PASSWORD', { infer: true });
  return createTransport({
    host: config.get('SMTP_HOST', { infer: true }),
    port: config.get('SMTP_PORT', { infer: true }),
    secure: config.get('SMTP_SECURE', { infer: true }),
    auth: user && pass ? { user, pass } : undefined,
  });
}

import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';

import type { Env } from '../config/env';
import type { RenderedEmail } from './templates';

/** SMTP delivery: Mailpit locally, Amazon SES (SMTP interface) in AWS. */
@Injectable()
export class MailerService implements OnModuleDestroy {
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(config: ConfigService<Env, true>) {
    const user = config.get('SMTP_USER', { infer: true });
    const pass = config.get('SMTP_PASSWORD', { infer: true });
    this.transport = createTransport({
      host: config.get('SMTP_HOST', { infer: true }),
      port: config.get('SMTP_PORT', { infer: true }),
      secure: config.get('SMTP_SECURE', { infer: true }),
      auth: user && pass ? { user, pass } : undefined,
    });
    this.from = config.get('MAIL_FROM', { infer: true });
  }

  async send(to: string, email: RenderedEmail): Promise<void> {
    await this.transport.sendMail({ from: this.from, to, ...email });
  }

  onModuleDestroy(): void {
    this.transport.close();
  }
}

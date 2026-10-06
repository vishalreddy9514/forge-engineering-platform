import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { ConfigService } from '@nestjs/config';

import type { Env } from '../config/env';
import { MailerService } from './mailer.service';

const config = (env: Partial<Env>) =>
  ({
    get: (key: keyof Env) =>
      ({ SMTP_HOST: 'localhost', SMTP_PORT: 1025, SMTP_SECURE: false, ...env })[key],
  }) as unknown as ConfigService<Env, true>;

const email = { subject: 'Reset your Forge password', text: 'Hello', html: '<p>Hello</p>' };

describe('MailerService', () => {
  const region = process.env.AWS_REGION;
  beforeAll(() => (process.env.AWS_REGION = 'eu-west-2'));
  afterAll(() => (process.env.AWS_REGION = region));
  afterEach(() => jest.restoreAllMocks());

  it('sends through the SES API (signed by the task role) when MAIL_TRANSPORT=ses', async () => {
    const send = jest
      .spyOn(SESv2Client.prototype, 'send')
      .mockResolvedValue({ MessageId: 'ses-1' } as never);
    const mailer = new MailerService(
      config({ MAIL_TRANSPORT: 'ses', MAIL_FROM: 'Forge <no-reply@forge.example>' }),
    );

    await mailer.send('sam@example.com', email);

    expect(send).toHaveBeenCalledTimes(1);
    const [command] = send.mock.calls[0] ?? [];
    expect(command).toBeInstanceOf(SendEmailCommand);
    const raw = Buffer.from(
      (command as SendEmailCommand).input.Content?.Raw?.Data ?? new Uint8Array(),
    ).toString();
    expect(raw).toContain('From: Forge <no-reply@forge.example>');
    expect(raw).toContain('To: sam@example.com');
    expect(raw).toContain('Subject: Reset your Forge password');
    mailer.onModuleDestroy();
  });

  it.each([
    ['smtp', 'SMTP'],
    ['ses', 'SESTransport'],
  ] as const)('MAIL_TRANSPORT=%s selects the %s transport', (transport, name) => {
    const mailer = new MailerService(config({ MAIL_TRANSPORT: transport, MAIL_FROM: 'a@b.c' }));
    const selected = (mailer as unknown as { transport: { transporter: { name: string } } })
      .transport.transporter.name;
    expect(selected).toBe(name);
    mailer.onModuleDestroy();
  });
});

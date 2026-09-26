import type { Job } from 'bullmq';

import { EMAIL_JOBS } from './email.jobs';
import { EmailProcessor } from './email.processor';
import type { MailerService } from './mailer.service';

describe('EmailProcessor', () => {
  const send = jest.fn();
  const processor = new EmailProcessor({ send } as unknown as MailerService);

  beforeEach(() => send.mockReset());

  it('renders and sends a password-reset email', async () => {
    await processor.process({
      id: '1',
      name: EMAIL_JOBS.PASSWORD_RESET,
      attemptsMade: 0,
      data: {
        to: 'sam@forge.local',
        displayName: 'Sam',
        resetUrl: 'http://localhost:3000/reset-password?token=t',
        expiresInMinutes: 30,
      },
    } as Job);

    expect(send).toHaveBeenCalledWith(
      'sam@forge.local',
      expect.objectContaining({ subject: 'Reset your Forge password' }),
    );
  });

  it('fails (and is retried by BullMQ) when delivery fails', async () => {
    send.mockRejectedValue(new Error('SMTP 421'));
    await expect(
      processor.process({
        name: EMAIL_JOBS.PASSWORD_RESET,
        attemptsMade: 0,
        data: { to: 'x@y.z', displayName: 'X', resetUrl: 'u', expiresInMinutes: 30 },
      } as Job),
    ).rejects.toThrow('SMTP 421');
  });

  it('rejects unknown job names instead of silently dropping them', async () => {
    await expect(processor.process({ name: 'mystery', data: {} } as Job)).rejects.toThrow(
      'Unknown email job',
    );
  });
});

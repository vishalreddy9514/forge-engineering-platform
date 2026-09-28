import { Test } from '@nestjs/testing';

import { WorkerModule } from '../../src/worker.module';

/**
 * The worker is a separate Nest application. Tests elsewhere build its processors by hand, so
 * this checks the real module graph: every processor's dependencies resolve and it boots.
 */
describe('worker process', () => {
  it('compiles and starts with every processor wired', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    await app.close();
  });
});

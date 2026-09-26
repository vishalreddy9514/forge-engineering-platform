import { Global, Module } from '@nestjs/common';

import { AccessControlService } from './access-control.service';
import { ProjectAccessGuard } from './project-access.guard';

@Global()
@Module({
  providers: [AccessControlService, ProjectAccessGuard],
  exports: [AccessControlService, ProjectAccessGuard],
})
export class AccessControlModule {}

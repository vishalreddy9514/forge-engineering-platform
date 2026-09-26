import { Module } from '@nestjs/common';

import { AdminGuard } from '../admin/admin.guard';
import { LabelsController } from './labels.controller';
import { LabelsService } from './labels.service';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

@Module({
  controllers: [ProjectsController, MembersController, LabelsController],
  providers: [ProjectsService, MembersService, LabelsService, AdminGuard],
})
export class ProjectsModule {}

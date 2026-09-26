import { CreateLabelRequest, type Label, UpdateLabelRequest } from '@forge/types';
import { Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import type { ProjectAccess } from '../access-control/project-access.guard';
import { CurrentProjectAccess } from '../access-control/project-access.decorator';
import { RequireProjectPermission } from '../access-control/require-project-permission.decorator';
import { ApiZodBody, ZodBody } from '../common/http/zod';
import { LabelsService } from './labels.service';

@ApiTags('labels')
@ApiBearerAuth()
@Controller()
export class LabelsController {
  constructor(private readonly labels: LabelsService) {}

  @Get('projects/:projectId/labels')
  @RequireProjectPermission('project:read')
  list(@CurrentProjectAccess() access: ProjectAccess): Promise<Label[]> {
    return this.labels.list(access.projectId);
  }

  @Post('projects/:projectId/labels')
  @RequireProjectPermission('project:update')
  @ApiZodBody(CreateLabelRequest)
  create(
    @CurrentProjectAccess() access: ProjectAccess,
    @ZodBody(CreateLabelRequest) body: CreateLabelRequest,
  ): Promise<Label> {
    return this.labels.create(access.projectId, body);
  }

  @Patch('labels/:labelId')
  @RequireProjectPermission('project:update', 'label')
  @ApiZodBody(UpdateLabelRequest)
  update(
    @Param('labelId') labelId: string,
    @ZodBody(UpdateLabelRequest) body: UpdateLabelRequest,
  ): Promise<Label> {
    return this.labels.update(labelId, body);
  }

  @Delete('labels/:labelId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireProjectPermission('project:update', 'label')
  async delete(@Param('labelId') labelId: string): Promise<void> {
    await this.labels.delete(labelId);
  }
}

import { AddMemberRequest, type ProjectMember, UpdateMemberRequest } from '@forge/types';
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import type { ProjectAccess } from '../access-control/project-access.guard';
import { CurrentProjectAccess } from '../access-control/project-access.decorator';
import { RequireProjectPermission } from '../access-control/require-project-permission.decorator';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { ReqMeta, type RequestMeta } from '../common/http/request-meta';
import { ApiZodBody, ZodBody } from '../common/http/zod';
import { MembersService } from './members.service';

@ApiTags('project members')
@ApiBearerAuth()
@Controller('projects/:projectId/members')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get()
  @RequireProjectPermission('project:read')
  list(@CurrentProjectAccess() access: ProjectAccess): Promise<ProjectMember[]> {
    return this.members.list(access.projectId);
  }

  @Post()
  @RequireProjectPermission('member:manage')
  @ApiZodBody(AddMemberRequest)
  add(
    @CurrentProjectAccess() access: ProjectAccess,
    @ZodBody(AddMemberRequest) body: AddMemberRequest,
    @CurrentUser() user: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ): Promise<ProjectMember> {
    return this.members.add(access.projectId, body, user, meta);
  }

  @Patch(':userId')
  @RequireProjectPermission('member:manage')
  @ApiZodBody(UpdateMemberRequest)
  changeRole(
    @CurrentProjectAccess() access: ProjectAccess,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @ZodBody(UpdateMemberRequest) body: UpdateMemberRequest,
    @CurrentUser() user: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ): Promise<ProjectMember> {
    return this.members.changeRole(access.projectId, userId, body.role, user, meta);
  }

  /** Members may always remove themselves; removing others needs member:manage. */
  @Delete(':userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireProjectPermission('project:read')
  remove(
    @CurrentProjectAccess() access: ProjectAccess,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @CurrentUser() user: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ): Promise<void> {
    return this.members.remove(access.projectId, userId, user, access, meta);
  }
}

import { Module } from '@nestjs/common';

import { AdminGuard } from './admin.guard';
import { AdminUsersController } from './admin-users.controller';

@Module({ controllers: [AdminUsersController], providers: [AdminGuard] })
export class AdminModule {}

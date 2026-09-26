'use client';

import { AddMemberRequest, type ProjectMember, ProjectRole, ROLE_LABELS } from '@forge/types';
import { Alert } from '@forge/ui/components/alert';
import { Button } from '@forge/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@forge/ui/components/card';
import { Label } from '@forge/ui/components/label';
import { Select } from '@forge/ui/components/select';
import { Skeleton } from '@forge/ui/components/skeleton';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';

import { useAuth } from '@/components/auth/auth-provider';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { FormField } from '@/components/forms/form-field';
import { useCan, useCurrentProject } from '@/components/projects/project-context';
import { applyServerErrors } from '@/lib/form-errors';
import { useAddMember, useChangeRole, useMembers, useRemoveMember } from '@/lib/queries/projects';

const ROLES = ProjectRole.options;

export default function MembersPage() {
  const project = useCurrentProject();
  const canManage = useCan('member:manage');
  const { data: members, isPending } = useMembers(project.id);

  return (
    <div className="grid gap-6">
      {canManage && <AddMemberForm projectId={project.id} />}
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Members</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isPending ? (
            <Skeleton className="h-32" />
          ) : (
            <ul className="divide-y" aria-label="Project members">
              {members?.map((member) => (
                <MemberRow key={member.user.id} member={member} canManage={canManage} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function MemberRow({ member, canManage }: { member: ProjectMember; canManage: boolean }) {
  const project = useCurrentProject();
  const { state } = useAuth();
  const router = useRouter();
  const changeRole = useChangeRole(project.id);
  const remove = useRemoveMember(project.id);
  const [error, setError] = useState<string | null>(null);
  const isMe = state.user?.id === member.user.id;

  const onRoleChange = async (role: ProjectRole) => {
    setError(null);
    try {
      await changeRole.mutateAsync({ userId: member.user.id, role });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the role');
    }
  };

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div>
        <p className="font-medium">
          {member.user.displayName} {isMe && <span className="text-muted-foreground">(you)</span>}
        </p>
        <p className="text-sm text-muted-foreground">{member.user.email}</p>
        {error && (
          <p role="alert" className="mt-1 text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2">
        {canManage ? (
          <Select
            aria-label={`Role for ${member.user.displayName}`}
            value={member.role}
            disabled={changeRole.isPending}
            onChange={(e) => void onRoleChange(ProjectRole.parse(e.target.value))}
          >
            {ROLES.map((role) => (
              <option key={role} value={role}>
                {ROLE_LABELS[role]}
              </option>
            ))}
          </Select>
        ) : (
          <span className="text-sm">{ROLE_LABELS[member.role]}</span>
        )}
        {(canManage || isMe) && (
          <ConfirmDialog
            title={isMe ? `Leave ${project.name}?` : `Remove ${member.user.displayName}?`}
            description={
              isMe
                ? 'You will lose access to this project immediately.'
                : `They will lose access to ${project.name} immediately.`
            }
            confirmLabel={isMe ? 'Leave project' : 'Remove'}
            destructive
            onConfirm={async () => {
              await remove.mutateAsync(member.user.id);
              if (isMe) router.replace('/projects');
            }}
            trigger={(open) => (
              <Button variant="ghost" size="sm" onClick={open}>
                {isMe ? 'Leave' : 'Remove'}
              </Button>
            )}
          />
        )}
      </div>
    </li>
  );
}

type AddValues = z.input<typeof AddMemberRequest>;

function AddMemberForm({ projectId }: { projectId: string }) {
  const add = useAddMember(projectId);
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<AddValues, unknown, AddMemberRequest>({
    resolver: zodResolver(AddMemberRequest),
    defaultValues: { email: '', role: 'DEVELOPER' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await add.mutateAsync(values);
      reset({ email: '', role: values.role });
    } catch (error) {
      setFormError(applyServerErrors(error, setError, ['email', 'role']));
    }
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Add a member</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(event) => void onSubmit(event)}
          noValidate
          className="grid gap-4 sm:grid-cols-[1fr_auto_auto] sm:items-start"
        >
          {formError && (
            <Alert variant="destructive" className="sm:col-span-3">
              {formError}
            </Alert>
          )}
          <FormField
            id="member-email"
            label="Email"
            type="email"
            placeholder="teammate@company.com"
            error={errors.email?.message}
            {...register('email')}
          />
          <div className="grid gap-2">
            <Label htmlFor="member-role">Role</Label>
            <Select id="member-role" {...register('role')}>
              {ROLES.map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABELS[role]}
                </option>
              ))}
            </Select>
          </div>
          <Button type="submit" disabled={isSubmitting} className="sm:mt-[1.375rem]">
            Add
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

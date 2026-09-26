import type { ProjectSummary } from '@forge/types';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@forge/ui/components/card';
import { CircleDot, Users } from 'lucide-react';
import Link from 'next/link';

import { RoleBadge } from './role-badge';

export function ProjectCard({ project }: { project: ProjectSummary }) {
  return (
    <Link
      href={`/projects/${project.key}`}
      className="rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <Card className="h-full transition-colors hover:border-ring">
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <CardTitle>
              <h2>{project.name}</h2>
            </CardTitle>
            <RoleBadge role={project.myRole} />
          </div>
          <CardDescription className="font-mono text-xs">{project.key}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {project.description && (
            <p className="line-clamp-2 text-sm text-muted-foreground">{project.description}</p>
          )}
          <div className="flex gap-4 text-sm text-muted-foreground">
            <span className="flex items-center gap-1">
              <CircleDot className="size-4" aria-hidden="true" />
              {project.openIssueCount} open
            </span>
            <span className="flex items-center gap-1">
              <Users className="size-4" aria-hidden="true" />
              {project.memberCount} {project.memberCount === 1 ? 'member' : 'members'}
            </span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

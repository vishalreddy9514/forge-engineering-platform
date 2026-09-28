'use client';

import { Badge } from '@forge/ui/components/badge';
import { Skeleton } from '@forge/ui/components/skeleton';
import { cn } from '@forge/ui/lib/utils';
import { Archive } from 'lucide-react';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { ProjectProvider } from '@/components/projects/project-context';
import { RoleBadge } from '@/components/projects/role-badge';
import { ApiError } from '@/lib/api';
import { useProject } from '@/lib/queries/projects';

const TABS = [
  { href: '', label: 'Overview' },
  { href: '/issues', label: 'Issues' },
  { href: '/board', label: 'Board' },
  { href: '/sprints', label: 'Sprints' },
  { href: '/members', label: 'Members' },
  { href: '/labels', label: 'Labels' },
  { href: '/settings', label: 'Settings' },
];

export default function ProjectLayout({ children }: { children: ReactNode }) {
  const { key } = useParams<{ key: string }>();
  const pathname = usePathname();
  const { data: project, error, isPending } = useProject(key);

  if (isPending) return <Skeleton className="h-24" />;
  if (error) {
    const missing = error instanceof ApiError && error.status === 404;
    return (
      <div className="rounded-xl border border-dashed p-10 text-center">
        <h1 className="text-xl font-semibold">
          {missing ? 'Project not found' : 'Something went wrong'}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {missing
            ? "It doesn't exist, or you're not a member of it."
            : 'The project could not be loaded. Please try again.'}
        </p>
        <Link href="/projects" className="mt-4 inline-block text-sm underline">
          Back to projects
        </Link>
      </div>
    );
  }

  const base = `/projects/${project.key}`;
  return (
    <ProjectProvider value={project}>
      <div className="grid gap-6">
        <div>
          <p className="font-mono text-sm text-muted-foreground">{project.key}</p>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight">{project.name}</h1>
            <RoleBadge role={project.myRole} />
            {project.archivedAt && (
              <Badge variant="outline">
                <Archive className="mr-1 size-3" aria-hidden="true" />
                Archived
              </Badge>
            )}
          </div>
        </div>

        {project.archivedAt && (
          <p role="status" className="rounded-md border bg-muted/50 px-4 py-2 text-sm">
            This project is archived and read-only. A project manager can restore it in Settings.
          </p>
        )}

        <nav aria-label="Project" className="flex gap-1 border-b">
          {TABS.map((tab) => {
            const href = `${base}${tab.href}`;
            const active = tab.href === '' ? pathname === base : pathname.startsWith(href);
            return (
              <Link
                key={tab.label}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  '-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground',
                  active && 'border-foreground font-medium text-foreground',
                )}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
        {children}
      </div>
    </ProjectProvider>
  );
}

'use client';

import { Button } from '@forge/ui/components/button';
import Link from 'next/link';

import { useAuth } from '@/components/auth/auth-provider';
import { ProjectCard } from '@/components/projects/project-card';
import { SystemStatus } from '@/components/system-status';
import { useProjects } from '@/lib/queries/projects';

export default function HomePage() {
  const { state } = useAuth();
  const { data } = useProjects({ archived: false });
  const firstName = state.user?.displayName.split(' ')[0] ?? '';

  return (
    <div className="grid gap-8">
      <h1 className="text-3xl font-bold tracking-tight">Welcome{firstName && `, ${firstName}`}</h1>

      <section aria-labelledby="your-projects" className="grid gap-4">
        <div className="flex items-center justify-between">
          <h2 id="your-projects" className="text-xl font-semibold">
            Your projects
          </h2>
          <Button asChild variant="outline" size="sm">
            <Link href="/projects">All projects</Link>
          </Button>
        </div>
        {data?.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            You&apos;re not in any projects yet.{' '}
            <Link href="/projects/new" className="underline">
              Create one
            </Link>
            .
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data?.data.slice(0, 6).map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
          </div>
        )}
      </section>

      <SystemStatus />
    </div>
  );
}

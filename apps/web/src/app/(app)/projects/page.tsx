'use client';

import { Button } from '@forge/ui/components/button';
import { Input } from '@forge/ui/components/input';
import { Skeleton } from '@forge/ui/components/skeleton';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useDeferredValue, useState } from 'react';

import { ProjectCard } from '@/components/projects/project-card';
import { useProjects } from '@/lib/queries/projects';

export default function ProjectsPage() {
  const [search, setSearch] = useState('');
  const [archived, setArchived] = useState(false);
  const q = useDeferredValue(search.trim());
  const { data, isPending, isError } = useProjects({ q: q || undefined, archived });

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-3xl font-bold tracking-tight">Projects</h1>
        <Button asChild>
          <Link href="/projects/new">
            <Plus aria-hidden="true" />
            New project
          </Link>
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          type="search"
          aria-label="Search projects"
          placeholder="Search by name or key…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
          }}
          className="max-w-xs"
        />
        <div role="group" aria-label="Show" className="flex rounded-md border p-0.5 text-sm">
          {[false, true].map((value) => (
            <button
              key={String(value)}
              type="button"
              aria-pressed={archived === value}
              onClick={() => {
                setArchived(value);
              }}
              className="rounded px-3 py-1 aria-pressed:bg-secondary aria-pressed:font-medium"
            >
              {value ? 'Archived' : 'Active'}
            </button>
          ))}
        </div>
      </div>

      {isError && <p role="alert">Could not load projects.</p>}
      {isPending && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      )}
      {data && data.data.length === 0 && (
        <div className="rounded-xl border border-dashed p-10 text-center">
          <p className="font-medium">
            {q
              ? 'No projects match your search.'
              : archived
                ? 'No archived projects.'
                : 'No projects yet.'}
          </p>
          {!q && !archived && (
            <p className="mt-1 text-sm text-muted-foreground">
              Create one, or ask a project manager to add you.
            </p>
          )}
        </div>
      )}
      {data && data.data.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.data.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      )}
    </div>
  );
}

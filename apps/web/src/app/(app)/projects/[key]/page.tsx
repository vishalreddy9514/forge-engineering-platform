'use client';

import { Card, CardContent, CardHeader } from '@forge/ui/components/card';

import { ProjectDashboard } from '@/components/dashboard/project-dashboard';
import { useCurrentProject } from '@/components/projects/project-context';

export default function ProjectOverviewPage() {
  const project = useCurrentProject();
  return (
    <div className="grid gap-6">
      <ProjectDashboard projectId={project.id} projectKey={project.key} />
      <Card>
        <CardHeader>
          <h2 className="leading-none font-semibold">About</h2>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm">
          <p className="whitespace-pre-wrap">{project.description ?? 'No description yet.'}</p>
          <p className="text-muted-foreground">
            {project.memberCount} {project.memberCount === 1 ? 'member' : 'members'} · Created by{' '}
            {project.createdBy.displayName} on {new Date(project.createdAt).toLocaleDateString()}
            {project.defaultAssignee &&
              ` · New issues go to ${project.defaultAssignee.displayName}`}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

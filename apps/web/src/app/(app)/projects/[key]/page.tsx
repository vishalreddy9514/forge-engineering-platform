'use client';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@forge/ui/components/card';

import { useCurrentProject } from '@/components/projects/project-context';

export default function ProjectOverviewPage() {
  const project = useCurrentProject();
  const stats = [
    { label: 'Open issues', value: String(project.openIssueCount) },
    { label: 'Members', value: String(project.memberCount) },
    {
      label: 'Active sprint',
      value: project.activeSprint ? project.activeSprint.name : 'None',
      detail: project.activeSprint ? `ends ${project.activeSprint.endDate}` : undefined,
    },
  ];

  return (
    <div className="grid gap-6">
      <dl className="grid gap-4 sm:grid-cols-3">
        {stats.map((stat) => (
          <Card key={stat.label}>
            <CardHeader>
              <CardDescription>
                <dt>{stat.label}</dt>
              </CardDescription>
              <CardTitle className="text-2xl">
                <dd>{stat.value}</dd>
              </CardTitle>
              {stat.detail && <p className="text-sm text-muted-foreground">{stat.detail}</p>}
            </CardHeader>
          </Card>
        ))}
      </dl>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>About</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm">
          <p className="whitespace-pre-wrap">{project.description ?? 'No description yet.'}</p>
          <p className="text-muted-foreground">
            Created by {project.createdBy.displayName} on{' '}
            {new Date(project.createdAt).toLocaleDateString()}
            {project.defaultAssignee &&
              ` · New issues go to ${project.defaultAssignee.displayName}`}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

import { Card, CardContent, CardHeader, CardTitle } from '@forge/ui/components/card';
import type { Metadata } from 'next';

import { CreateProjectForm } from '@/components/projects/create-project-form';

export const metadata: Metadata = { title: 'New project' };

export default function NewProjectPage() {
  return (
    <Card className="mx-auto max-w-xl">
      <CardHeader>
        <CardTitle>
          <h1>New project</h1>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <CreateProjectForm />
      </CardContent>
    </Card>
  );
}

import { ROLE_LABELS, type ProjectSummary } from '@forge/types';
import { Badge } from '@forge/ui/components/badge';

export function RoleBadge({ role }: { role: ProjectSummary['myRole'] }) {
  return (
    <Badge variant={role === 'VIEWER' ? 'outline' : 'secondary'}>
      {role === 'ADMIN' ? 'Admin' : ROLE_LABELS[role]}
    </Badge>
  );
}

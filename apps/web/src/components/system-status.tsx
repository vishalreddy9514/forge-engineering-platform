'use client';

import { ReadinessResponse } from '@forge/types';
import { Badge } from '@forge/ui/components/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@forge/ui/components/card';
import { useQuery } from '@tanstack/react-query';

import { apiFetch } from '@/lib/api';

async function fetchReadiness(): Promise<ReadinessResponse> {
  // 503 still carries a readiness body describing which dependency is down.
  const res = await apiFetch('/health/ready', {}, { auth: false, acceptStatuses: [503] });
  return ReadinessResponse.parse(await res.json());
}

/** Shows whether the API and its dependencies are reachable: a live check of the whole wiring. */
export function SystemStatus() {
  const { data, isPending, isError } = useQuery({
    queryKey: ['health', 'ready'],
    queryFn: fetchReadiness,
    refetchInterval: 15_000,
  });

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>
          <h2>System status</h2>
        </CardTitle>
        <CardDescription>Live readiness of the API and its dependencies</CardDescription>
      </CardHeader>
      <CardContent>
        {isPending && <p className="text-sm text-muted-foreground">Checking…</p>}
        {isError && (
          <p role="alert" className="text-sm text-destructive">
            API unreachable
          </p>
        )}
        {data && (
          <ul className="grid gap-2" aria-label="Dependency checks">
            {Object.entries(data.checks).map(([name, check]) => (
              <li key={name} className="flex items-center justify-between text-sm">
                <span className="capitalize">{name}</span>
                <Badge
                  variant={check.status === 'ok' ? 'success' : 'destructive'}
                  title={check.message}
                >
                  {check.status === 'ok' ? 'Operational' : 'Unavailable'}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

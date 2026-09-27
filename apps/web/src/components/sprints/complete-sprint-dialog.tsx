'use client';

import type { Sprint } from '@forge/types';
import { Alert } from '@forge/ui/components/alert';
import { Button } from '@forge/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from '@forge/ui/components/dialog';
import { Label } from '@forge/ui/components/label';
import { Select } from '@forge/ui/components/select';
import { useState } from 'react';

import { useCompleteSprint } from '@/lib/queries/sprints';

interface CompleteSprintDialogProps {
  sprint: Sprint;
  openIssues: number;
  plannedSprints: Sprint[];
  /** Receives the outcome. The caller shows it: this dialog unmounts with the active sprint. */
  onCompleted: (message: string) => void;
}

/** Ends the active sprint and decides where unfinished work goes (FR-5.2). */
export function CompleteSprintDialog({
  sprint,
  openIssues,
  plannedSprints,
  onCompleted,
}: CompleteSprintDialogProps) {
  const complete = useCompleteSprint(sprint.projectId);
  const [open, setOpen] = useState(false);
  const [destination, setDestination] = useState('backlog');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    try {
      const summary = await complete.mutateAsync({
        sprintId: sprint.id,
        moveOpenIssuesTo: destination,
      });
      const moved = summary.movedToSprint + summary.movedToBacklog;
      onCompleted(
        `${sprint.name} completed: ${String(summary.completed)} done` +
          (moved > 0
            ? `, ${String(moved)} moved to ${summary.movedToSprint > 0 ? 'the next sprint' : 'the backlog'}.`
            : '.'),
      );
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The sprint could not be completed.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>Complete sprint</Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogTitle>Complete {sprint.name}</DialogTitle>
        <DialogDescription>
          {openIssues === 0
            ? 'Every issue in this sprint is resolved.'
            : `${String(openIssues)} ${openIssues === 1 ? 'issue is' : 'issues are'} not done yet.`}
        </DialogDescription>
        {error && <Alert variant="destructive">{error}</Alert>}
        {openIssues > 0 && (
          <div className="grid gap-2">
            <Label htmlFor="complete-destination">Move unfinished issues to</Label>
            <Select
              id="complete-destination"
              value={destination}
              onChange={(e) => {
                setDestination(e.target.value);
              }}
            >
              <option value="backlog">The backlog</option>
              {plannedSprints.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </div>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              setOpen(false);
            }}
          >
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={complete.isPending}>
            {complete.isPending ? 'Completing…' : 'Complete sprint'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

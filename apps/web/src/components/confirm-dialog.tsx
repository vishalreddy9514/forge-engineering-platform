'use client';

import { Button } from '@forge/ui/components/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@forge/ui/components/dialog';
import { type ReactNode, useState } from 'react';

interface ConfirmDialogProps {
  trigger: (open: () => void) => ReactNode;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => Promise<unknown>;
}

/** Confirmation for consequential actions; stays open and shows the error if the call fails. */
export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel,
  destructive,
  onConfirm,
}: ConfirmDialogProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger(() => {
        setError(null);
        setOpen(true);
      })}
      <DialogContent>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            disabled={pending}
            onClick={() => void confirm()}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

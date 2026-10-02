'use client';

import { CreateDocumentRequest, MAX_DOCUMENT_BYTES } from '@forge/types';
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
import { Input } from '@forge/ui/components/input';
import { Label } from '@forge/ui/components/label';
import { Textarea } from '@forge/ui/components/textarea';
import { Upload } from 'lucide-react';
import { type ChangeEvent, type SyntheticEvent, useState } from 'react';

import { useCreateDocument } from '@/lib/queries/search';

const ACCEPT = '.md,.markdown,.txt,text/markdown,text/plain';

/** Upload a Markdown or text file (read in the browser), or paste the text. */
export function UploadDocumentDialog({ projectId }: { projectId: string }) {
  const create = useCreateDocument(projectId);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setTitle('');
    setContent('');
    setError(null);
  };

  const pickFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_DOCUMENT_BYTES) {
      setError('Documents can be up to 1 MB.');
      return;
    }
    setError(null);
    setContent(await file.text());
    if (!title) setTitle(file.name.replace(/\.(md|markdown|txt)$/i, ''));
  };

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    const parsed = CreateDocumentRequest.safeParse({ title, content });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the title and content.');
      return;
    }
    try {
      await create.mutateAsync(parsed.data);
      reset();
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The document could not be uploaded.');
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Upload aria-hidden="true" />
          Upload document
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogTitle>Upload a document</DialogTitle>
        <DialogDescription>
          Runbooks, design notes and guides in Markdown or plain text (up to 1 MB). The assistant
          and search cite them section by section.
        </DialogDescription>
        <form onSubmit={(event) => void submit(event)} noValidate className="grid gap-4">
          {error && <Alert variant="destructive">{error}</Alert>}
          <div className="grid gap-2">
            <Label htmlFor="document-file">File</Label>
            <Input
              id="document-file"
              type="file"
              accept={ACCEPT}
              onChange={(event) => void pickFile(event)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="document-title">Title</Label>
            <Input
              id="document-title"
              value={title}
              maxLength={200}
              onChange={(event) => {
                setTitle(event.target.value);
              }}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="document-content">Content (Markdown)</Label>
            <Textarea
              id="document-content"
              rows={8}
              value={content}
              onChange={(event) => {
                setContent(event.target.value);
              }}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              Upload
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

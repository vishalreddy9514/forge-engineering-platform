import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { dev, issueDetail } from '../../../test-stubs/issue-fixtures';

import { AttachmentsPanel } from './attachments-panel';

const me = { ...dev, isAdmin: false, createdAt: '2026-09-01T00:00:00Z' };
jest.mock('@/components/auth/auth-provider', () => ({
  useAuth: () => ({ state: { status: 'authenticated', user: me } }),
}));

const upload = jest.fn();
const remove = jest.fn();
const download = jest.fn();
const other = { ...dev, id: '00000000-0000-4000-8000-000000000009', displayName: 'Someone Else' };
const files = [
  {
    id: 'a1',
    issueId: 'i',
    fileName: 'mine.log',
    contentType: 'text/plain',
    sizeBytes: 2048,
    status: 'AVAILABLE',
    uploadedBy: dev,
    createdAt: '2026-09-20T10:00:00Z',
  },
  {
    id: 'a2',
    issueId: 'i',
    fileName: 'theirs.png',
    contentType: 'image/png',
    sizeBytes: 3 * 1024 * 1024,
    status: 'AVAILABLE',
    uploadedBy: other,
    createdAt: '2026-09-20T11:00:00Z',
  },
];
jest.mock('@/lib/queries/attachments', () => ({
  ...jest.requireActual<object>('@/lib/queries/attachments'),
  useAttachments: () => ({ data: files, isPending: false, isError: false }),
  useUploadAttachment: () => ({ mutateAsync: upload }),
  useDeleteAttachment: () => ({ mutateAsync: remove, isPending: false }),
  downloadAttachment: (id: string) => download(id) as Promise<void>,
}));

const issue = issueDetail();

describe('AttachmentsPanel', () => {
  beforeEach(() => {
    upload.mockReset().mockResolvedValue({});
    remove.mockReset().mockResolvedValue(undefined);
    download.mockReset().mockResolvedValue(undefined);
    jest.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('lists files with readable sizes and downloads on request', async () => {
    render(<AttachmentsPanel issue={issue} canUpload canDeleteAny={false} />);
    expect(screen.getByText('Attachments (2)')).toBeInTheDocument();
    expect(screen.getByText(/2\.0 KB · Dev Patel/)).toBeInTheDocument();
    expect(screen.getByText(/3\.0 MB · Someone Else/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Download theirs.png' }));
    expect(download).toHaveBeenCalledWith('a2');
  });

  it('lets people delete only their own files unless they manage the project', async () => {
    const { unmount } = render(<AttachmentsPanel issue={issue} canUpload canDeleteAny={false} />);
    expect(screen.queryByRole('button', { name: 'Delete theirs.png' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete mine.log' }));
    expect(remove).toHaveBeenCalledWith('a1');
    unmount();

    render(<AttachmentsPanel issue={issue} canUpload canDeleteAny />);
    expect(screen.getByRole('button', { name: 'Delete theirs.png' })).toBeInTheDocument();
  });

  it('rejects disallowed or oversized files before contacting the server', async () => {
    render(<AttachmentsPanel issue={issue} canUpload canDeleteAny={false} />);
    const input = document.getElementById('attachment-input') as HTMLInputElement;
    await userEvent.upload(input, new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' }), {
      applyAccept: false,
    });
    expect(await screen.findByText(/logo\.svg is not an allowed file type/)).toBeInTheDocument();

    const big = new File(['x'], 'huge.zip', { type: 'application/zip' });
    Object.defineProperty(big, 'size', { value: 11 * 1024 * 1024 });
    await userEvent.upload(input, big);
    expect(await screen.findByText('huge.zip is larger than 10 MB.')).toBeInTheDocument();
    expect(upload).not.toHaveBeenCalled();
  });

  it('uploads allowed files and reports failures by name', async () => {
    upload.mockRejectedValueOnce(new Error('The upload was rejected (403)'));
    render(<AttachmentsPanel issue={issue} canUpload canDeleteAny={false} />);
    const input = document.getElementById('attachment-input') as HTMLInputElement;
    const notes = new File(['# notes'], 'notes.md', { type: '' });
    await userEvent.upload(input, notes);
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ file: notes }));
    expect(await screen.findByText('notes.md: The upload was rejected (403)')).toBeInTheDocument();

    // Browsers report some text formats with non-standard types (found in the browser run).
    const log = new File(['boom'], 'server.log', { type: 'text/x-log' });
    await userEvent.upload(input, log);
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ file: log }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows no upload or delete controls to read-only members', () => {
    render(<AttachmentsPanel issue={issue} canUpload={false} canDeleteAny={false} />);
    expect(screen.queryByRole('button', { name: 'Attach files' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download mine.log' })).toBeInTheDocument();
  });
});

import { createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { issueSummary } from '../../../test-stubs/issue-fixtures';

import { Board } from './board';

const todo = issueSummary();
const done = issueSummary({
  id: '10000000-0000-4000-8000-000000000002',
  key: 'PAY-2',
  number: 2,
  title: 'Refund webhook retries',
  status: 'DONE',
});

function renderBoard(onMove = jest.fn().mockResolvedValue(undefined), canMove = true) {
  render(<Board issues={[todo, done]} projectKey="PAY" canMove={canMove} onMove={onMove} />);
  return onMove;
}

describe('Board', () => {
  it('puts each issue in its status column and links to it', () => {
    renderBoard();
    const todoColumn = screen.getByRole('region', { name: 'To do' });
    expect(within(todoColumn).getByRole('link', { name: todo.title })).toHaveAttribute(
      'href',
      '/projects/PAY/issues/PAY-1',
    );
    expect(
      within(screen.getByRole('region', { name: 'Done' })).getByText(done.title),
    ).toBeVisible();
  });

  it('offers only the moves the workflow allows', () => {
    renderBoard();
    const options = within(screen.getByRole('combobox', { name: 'Move PAY-1' }))
      .getAllByRole('option')
      .filter((o) => !(o as HTMLOptionElement).disabled)
      .map((o) => o.textContent);
    // To do → In progress is allowed; To do → In review / Done are not.
    expect(options).toEqual(['In progress']);
  });

  it('moves a card with the keyboard-accessible menu', async () => {
    const onMove = renderBoard();
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Move PAY-1' }),
      'IN_PROGRESS',
    );
    expect(onMove).toHaveBeenCalledWith(todo, 'IN_PROGRESS');
  });

  it('rejects a drop the workflow does not allow, without calling the API', () => {
    const onMove = renderBoard();
    const card = screen.getByText(todo.title).closest('article');
    if (!card) throw new Error('card not found');
    fireEvent.dragStart(card);
    const doneColumn = screen.getByRole('region', { name: 'Done' });
    const drop = createEvent.drop(doneColumn);
    fireEvent(doneColumn, drop);

    expect(onMove).not.toHaveBeenCalled();
    expect(screen.getByText("PAY-1 can't move from To do to Done.")).toBeInTheDocument();
  });

  it('shows the server message when a move fails', async () => {
    renderBoard(jest.fn().mockRejectedValue(new Error('This issue was changed by someone else')));
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Move PAY-1' }),
      'IN_PROGRESS',
    );
    expect(
      await screen.findByText('PAY-1: This issue was changed by someone else'),
    ).toBeInTheDocument();
  });

  it('is read-only for people who cannot edit issues', () => {
    renderBoard(jest.fn(), false);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByText(todo.title).closest('article')).toHaveAttribute('draggable', 'false');
  });
});

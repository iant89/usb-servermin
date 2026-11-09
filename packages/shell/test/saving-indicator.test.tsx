import { describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@enterprise-ui/react';
import { SavingIndicator, describeSaving } from '../src/shell/SavingIndicator';

describe('saving indicator', () => {
  it('renders nothing while saving keeps up', () => {
    const { container } = render(
      <ThemeProvider>
        <SavingIndicator status={{ busy: false, pending: 2, oldestMs: 100, sources: ['logs'] }} moduleNames={{}} />
      </ThemeProvider>,
    );
    expect(container.textContent).toBe('');
    cleanup();
  });

  it('shows "Saving…" with an accessible description of what is being written', () => {
    render(
      <ThemeProvider>
        <SavingIndicator status={{ busy: true, pending: 3, oldestMs: 4200, sources: ['monitoring', 'logs'] }} moduleNames={{ monitoring: 'Monitoring' }} />
      </ThemeProvider>,
    );
    expect(screen.getByText('Saving…')).toBeTruthy();
    expect(screen.getByLabelText('Saving data: 3 writes waiting on the disk (Monitoring, logs), oldest 4 s')).toBeTruthy();
    cleanup();
  });

  it('describes a single short write', () => {
    expect(describeSaving({ busy: true, pending: 1, oldestMs: 600, sources: ['checkpoint'] }, {})).toBe('Saving data: 1 write waiting on the disk (database files)');
  });
});

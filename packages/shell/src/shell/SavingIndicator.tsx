import { useEffect, useRef } from 'react';
import { StatusIndicator, useAnnouncer } from '@enterprise-ui/react';

export interface StorageStatus {
  busy: boolean;
  pending: number;
  oldestMs: number;
  sources: string[];
}

/** Describes what is being written, using module names where known. */
export function describeSaving(status: StorageStatus, moduleNames: Record<string, string>): string {
  const names = status.sources.map((s) => (s === 'logs' ? 'logs' : s === 'checkpoint' ? 'database files' : moduleNames[s] ?? s));
  const count = `${status.pending} write${status.pending === 1 ? '' : 's'} waiting on the disk`;
  const age = status.oldestMs >= 2000 ? `, oldest ${Math.round(status.oldestMs / 1000)} s` : '';
  return `Saving data: ${count}${names.length ? ` (${names.join(', ')})` : ''}${age}`;
}

/** Announces the start and end of saving to screen readers. Lives in the always-mounted shell. */
export function useSavingAnnouncements(busy: boolean) {
  const announce = useAnnouncer();
  const was = useRef(false);
  useEffect(() => {
    if (busy && !was.current) announce('Saving data');
    if (!busy && was.current) announce('All changes saved');
    was.current = busy;
  }, [busy, announce]);
}

/**
 * Header indicator shown while writes lag behind on the storage thread (slow disks such as USB flash).
 * It renders nothing while saving keeps up, so fast disks never show it.
 */
export function SavingIndicator({ status, moduleNames }: { status: StorageStatus | null; moduleNames: Record<string, string> }) {
  if (!status?.busy) return null;
  const detail = describeSaving(status, moduleNames);
  return (
    <span title={detail} aria-label={detail}>
      <StatusIndicator tone="information" icon="save" size="sm">
        Saving…
      </StatusIndicator>
    </span>
  );
}

/**
 * Small building blocks for consistent view states (§45): loading, empty, error, unavailable and
 * permission denied. They are composed from ENTERPRISE-UI components only.
 */
import { useState, type ReactNode } from 'react';
import { AlertDialog, Button, EmptyState, MessageStrip, Skeleton, Stack, Checkbox } from '@enterprise-ui/react';
import { ApiRequestError } from './api';
import { usePermission } from './context';
import type { QueryState } from './context';

export function PermissionDenied({ permission }: { permission?: string }) {
  return (
    <EmptyState
      icon="locked"
      title="Permission denied"
      description={permission ? `Your account needs the "${permission}" permission to see this. Ask an administrator.` : 'Your account cannot open this page.'}
    />
  );
}

export function ErrorMessage({ error, onRetry, title }: { error: Error; onRetry?: () => void; title?: string }) {
  if (error instanceof ApiRequestError && error.status === 403 && error.details?.permission) return <PermissionDenied permission={error.details.permission} />;
  const unavailable = error instanceof ApiRequestError && (error.status === 424 || error.status === 503);
  title ??= unavailable ? 'Not available' : 'Something went wrong';
  const problems = error instanceof ApiRequestError ? (error.problems ?? (Array.isArray(error.details) ? (error.details as string[]) : undefined)) : undefined;
  return (
    <MessageStrip
      tone={unavailable ? 'warning' : 'error'}
      title={title}
      announce="polite"
      actions={onRetry ? <Button variant="tertiary" size="sm" onClick={onRetry}>Try again</Button> : undefined}
    >
      {error.message}
      {problems?.length ? (
        <ul style={{ margin: '4px 0 0', paddingInlineStart: 18 }}>
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
    </MessageStrip>
  );
}

/** Renders loading skeletons, an error with retry, an empty state, or the content. */
export function QueryView<T>({
  query,
  children,
  empty,
  isEmpty,
  skeletonLines = 6,
}: {
  query: QueryState<T>;
  children: (data: T) => ReactNode;
  empty?: ReactNode;
  isEmpty?: (data: T) => boolean;
  skeletonLines?: number;
}) {
  if (query.error && query.data === undefined) return <ErrorMessage error={query.error} onRetry={() => void query.refresh()} />;
  if (query.data === undefined) return <Skeleton lines={skeletonLines} aria-label="Loading" />;
  const isE = isEmpty ? isEmpty(query.data) : Array.isArray(query.data) && query.data.length === 0;
  return (
    <Stack gap={3}>
      {query.error ? <ErrorMessage error={query.error} title="Refresh failed; showing the last data" onRetry={() => void query.refresh()} /> : null}
      {isE && empty ? empty : children(query.data)}
    </Stack>
  );
}

/** Hides content the user is not allowed to use. */
export function Guard({ permission, children, fallback = null }: { permission?: string; children: ReactNode; fallback?: ReactNode }) {
  return usePermission(permission) ? <>{children}</> : <>{fallback}</>;
}

export interface ConfirmOptions {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  tone?: 'warning' | 'error' | 'information';
  /** Show a checkbox the user must tick (for destructive operations). */
  acknowledge?: string;
}

/** Hook returning a confirm() function and the dialog element to render. */
export function useConfirm() {
  const [state, setState] = useState<(ConfirmOptions & { resolve(v: boolean): void }) | null>(null);
  const [ack, setAck] = useState(false);
  const confirm = (opts: ConfirmOptions) =>
    new Promise<boolean>((resolve) => {
      setAck(false);
      setState({ ...opts, resolve });
    });
  const close = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  const dialog = state ? (
    <AlertDialog
      open
      title={state.title}
      tone={state.tone ?? 'warning'}
      confirmLabel={state.confirmLabel ?? 'Confirm'}
      onCancel={() => close(false)}
      onConfirm={() => {
        if (state.acknowledge && !ack) return;
        close(true);
      }}
    >
      <Stack gap={3}>
        <div>{state.message}</div>
        {state.acknowledge ? <Checkbox label={state.acknowledge} checked={ack} onChange={(c: boolean) => setAck(c)} /> : null}
      </Stack>
    </AlertDialog>
  ) : null;
  return { confirm, dialog };
}

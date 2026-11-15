import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure } from '../api/client';
import { useTeamAction } from '../api/useTeamAction';
import type { TeamAction } from '../api/useTeamAction';
import { FormError } from './forms';
import styles from '../App.module.css';

export const formatOffset = (minutes: number) => `UTC${minutes < 0 ? '−' : '+'}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0')}:${String(Math.abs(minutes) % 60).padStart(2, '0')}`;
export const formatTime = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export function QueryError({ error, retry }: { error: Error | null; retry: () => unknown }) {
  if (!error) return null;
  const denied = error instanceof ApiFailure && [403, 404].includes(error.status);
  return <div className={styles.error} role="alert"><p>{error.message}</p>
    {!denied && <button className={styles.secondary} onClick={() => void retry()}>Try again</button>}
  </div>;
}
export function SeatMarks({ count, max }: { count: number; max: number }) {
  return <span className={styles.seats} aria-hidden="true">{Array.from({ length: max }, (_, i) => <span key={i} className={i < count ? styles.filledSeat : styles.openSeat} />)}</span>;
}
export function ConfirmAction({ userId, hid, action, label, title, children, confirm, success, dangerous = true, ariaLabel }: {
  userId: string; hid: string; action: TeamAction; label: string; title: string; children: ReactNode;
  confirm: string; success: () => void; dangerous?: boolean; ariaLabel?: string;
}) {
  const id = useId(); const dialog = useRef<HTMLDialogElement>(null); const trigger = useRef<HTMLButtonElement>(null);
  const mutation = useTeamAction(userId, hid, { onSuccess: success });
  useEffect(() => {
    const element = dialog.current;
    return () => {
      if (element?.open) requestAnimationFrame(() => {
        if (document.activeElement === document.body) document.querySelector<HTMLElement>('h1')?.focus();
      });
    };
  }, []);
  return <>
    <button ref={trigger} className={dangerous ? styles.dangerButton : styles.secondary} aria-label={ariaLabel} onClick={() => { mutation.reset(); dialog.current?.showModal(); }}>{label}</button>
    <dialog ref={dialog} className={styles.dialog} aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`}
      onCancel={(event) => { if (mutation.isPending) event.preventDefault(); }}
      onClose={() => { if (trigger.current?.isConnected) trigger.current.focus(); else document.querySelector<HTMLElement>('h1')?.focus(); }}>
      <h2 id={`${id}-title`}>{title}</h2><div id={`${id}-body`}>{children}</div>
      <FormError message={mutation.error?.message} />
      {mutation.isPending && <p role="status">Saving your change…</p>}
      <div className={styles.formActions}>
        <button className={styles.secondary} autoFocus disabled={mutation.isPending} onClick={() => dialog.current?.close()}>Cancel</button>
        <button className={dangerous ? styles.dangerButton : styles.primary} disabled={mutation.isPending} onClick={() => {
          void mutation.mutateAsync(action).then(() => { dialog.current?.close(); }).catch(() => {});
        }}>{mutation.isPending ? 'Saving…' : confirm}</button>
      </div>
    </dialog>
  </>;
}

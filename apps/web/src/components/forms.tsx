import type { ReactNode } from 'react';
import { ApiFailure } from '../api/client';
import styles from '../App.module.css';

export type FieldErrors = Record<string, string>;
export const issuesToErrors = (issues: { path: PropertyKey[]; message: string }[]): FieldErrors =>
  Object.fromEntries(issues.map((issue) => [String(issue.path[0] ?? 'form'), issue.message]));
export function failureToErrors(error: unknown): FieldErrors {
  return error instanceof ApiFailure
    ? { form: error.message, ...Object.fromEntries(error.details.map((detail) => [detail.field, detail.message])) }
    : { form: 'Something went wrong. Please try again.' };
}
export function focusFirstError() {
  requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
}
export function Field({ id, label, error, hint, children }: { id: string; label: string; error?: string | undefined; hint?: string; children: ReactNode }) {
  return <div className={styles.field}>
    <label htmlFor={id}>{label}</label>{children}
    {hint && <small id={`${id}-hint`}>{hint}</small>}
    {error && <span className={styles.fieldError} id={`${id}-error`}>{error}</span>}
  </div>;
}
export function FormError({ message }: { message: string | undefined }) {
  return message ? <p className={styles.error} role="alert">{message}</p> : null;
}

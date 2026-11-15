import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { signupSchema, loginSchema } from '@teamforge/shared';
import { api } from '../../api/client';
import { refreshIdentity, useSession } from '../../api/session';
import { Field, FormError, issuesToErrors, failureToErrors, focusFirstError } from '../../components/forms';
import type { FieldErrors } from '../../components/forms';
import styles from '../../App.module.css';

export function AuthPage({ mode }: { mode: 'signup' | 'login' }) {
  const signup = mode === 'signup';
  const session = useSession();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const mutation = useMutation({
    mutationFn: (body: unknown) => api(`/auth/${mode}`, { method: 'POST', body }),
    onSuccess: async () => {
      const user = await refreshIdentity();
      if (user) navigate(user.registrations.length ? '/' : '/onboarding', { replace: true });
    },
    onError: (error) => { setErrors(failureToErrors(error)); focusFirstError(); },
  });
  if (session.data) return <Navigate to={session.data.registrations.length ? '/' : '/onboarding'} replace />;
  return <div className={styles.authLayout}>
    <section className={styles.authIntro}>
      <h1 tabIndex={-1}>{signup ? 'Start with your spark.' : 'Welcome back.'}</h1>
      <p className={styles.intro}>Different skills. Shared ambition. Find your place in the next hackathon.</p>
      <p className={styles.promise}>A little about you.<br />A world of things to build.</p>
    </section>
    <section className={styles.panel} aria-labelledby="auth-title">
      <h2 id="auth-title">{signup ? 'Create your account' : 'Sign in to TeamForge'}</h2>
      <form noValidate onSubmit={(event) => {
        event.preventDefault();
        const result = (signup ? signupSchema : loginSchema).safeParse({ email, password, ...(signup ? { displayName } : {}) });
        if (!result.success) { setErrors(issuesToErrors(result.error.issues)); focusFirstError(); return; }
        setErrors({}); mutation.mutate(result.data);
      }}>
        {signup && <Field id="displayName" label="Display name" error={errors.displayName}>
          <input id="displayName" autoComplete="nickname" maxLength={60} value={displayName} onChange={(e) => setDisplayName(e.target.value)} aria-invalid={!!errors.displayName} aria-describedby={errors.displayName ? 'displayName-error' : undefined} />
        </Field>}
        <Field id="email" label="Email address" error={errors.email}>
          <input id="email" type="email" autoComplete="email" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={!!errors.email} aria-describedby={errors.email ? 'email-error' : undefined} />
        </Field>
        <Field id="password" label="Password" error={errors.password} hint={signup ? 'Use 10–128 characters.' : ''}>
          <input id="password" type="password" autoComplete={signup ? 'new-password' : 'current-password'} maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={!!errors.password} aria-describedby={[signup ? 'password-hint' : '', errors.password ? 'password-error' : ''].filter(Boolean).join(' ') || undefined} />
        </Field>
        <FormError message={errors.form} />
        {mutation.isPending && <p role="status">{signup ? 'Creating your account…' : 'Signing you in…'}</p>}
        <button className={styles.primary} disabled={mutation.isPending}>{mutation.isPending ? 'Please wait…' : signup ? 'Create account' : 'Sign in'}</button>
      </form>
      <p className={styles.switchAuth}>{signup ? 'Already have an account? ' : 'New here? '}<Link to={signup ? '/login' : '/signup'}>{signup ? 'Sign in' : 'Create an account'}</Link></p>
    </section>
  </div>;
}

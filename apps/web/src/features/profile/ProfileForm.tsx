import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { skills, profilePatchSchema } from '@teamforge/shared';
import type { Profile, ProfilePatch, Skill } from '@teamforge/shared';
import { ApiFailure } from '../../api/client';
import { useIntentRequest } from '../../api/useIntentRequest';
import { queryClient, sessionKey, clearSession } from '../../api/session';
import { Field, FormError, issuesToErrors, failureToErrors, focusFirstError } from '../../components/forms';
import type { FieldErrors } from '../../components/forms';
import styles from '../../App.module.css';

const offsetLabel = (value: number) => `UTC${value >= 0 ? '+' : '−'}${String(Math.floor(Math.abs(value) / 60)).padStart(2, '0')}:${String(Math.abs(value) % 60).padStart(2, '0')}`;
export function ProfileForm({ user }: { user: Profile }) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [chosenSkills, setChosenSkills] = useState<Skill[]>(user.skills);
  const [utcOffsetMin, setOffset] = useState(user.utcOffsetMin);
  const [errors, setErrors] = useState<FieldErrors>({});
  const send = useIntentRequest<Profile>(user.id);
  const mutation = useMutation({
    mutationFn: (body: ProfilePatch) => send('/me', 'PATCH', body),
    onSuccess: (profile) => {
      // A late mutation from a previous account must not restore its cached profile.
      if (queryClient.getQueryData<Profile | null>(sessionKey)?.id === user.id) queryClient.setQueryData(sessionKey, profile);
    },
    onError: (error) => {
      if (error instanceof ApiFailure && error.status === 401) {
        if (queryClient.getQueryData<Profile | null>(sessionKey)?.id === user.id) clearSession();
        return;
      }
      setErrors(failureToErrors(error)); focusFirstError();
    },
  });
  const offsets = Array.from({ length: 105 }, (_, index) => -720 + index * 15);
  if (!offsets.includes(utcOffsetMin)) offsets.push(utcOffsetMin);
  return <form className={styles.profileForm} noValidate onChange={() => mutation.reset()} onSubmit={(event) => {
    event.preventDefault();
    const result = profilePatchSchema.safeParse({ displayName, skills: chosenSkills, utcOffsetMin });
    if (!result.success) { setErrors(issuesToErrors(result.error.issues)); focusFirstError(); return; }
    setErrors({}); mutation.mutate(result.data);
  }}>
    <h2>A little about you</h2>
    <Field id="profile-name" label="Display name" error={errors.displayName}>
      <input id="profile-name" disabled={mutation.isPending} autoComplete="nickname" maxLength={60} value={displayName} onChange={(e) => setDisplayName(e.target.value)} aria-invalid={!!errors.displayName} aria-describedby={errors.displayName ? 'profile-name-error' : undefined} />
    </Field>
    <fieldset className={styles.skillFieldset} aria-describedby="skills-hint">
      <legend>Your skills</legend><p id="skills-hint" className={styles.muted}>Pick the things you enjoy bringing to a team.</p>
      <div className={styles.skills}>{skills.map((skill) => <label className={styles.skill} key={skill}>
        <input type="checkbox" disabled={mutation.isPending} checked={chosenSkills.includes(skill)} onChange={(e) => setChosenSkills(e.target.checked ? [...chosenSkills, skill] : chosenSkills.filter((item) => item !== skill))} />{skill}
      </label>)}</div>
      {errors.skills && <p className={styles.fieldError}>{errors.skills}</p>}
    </fieldset>
    <Field id="offset" label="Time zone" error={errors.utcOffsetMin} hint="Choose your current UTC offset. You can change it later.">
      <select id="offset" disabled={mutation.isPending} value={utcOffsetMin} onChange={(e) => setOffset(Number(e.target.value))} aria-invalid={!!errors.utcOffsetMin} aria-describedby={`offset-hint${errors.utcOffsetMin ? ' offset-error' : ''}`}>
        {offsets.sort((a, b) => a - b).map((value) => <option key={value} value={value}>{offsetLabel(value)}</option>)}
      </select>
    </Field>
    <FormError message={errors.form} />
    <div className={styles.formActions}><button className={styles.primary} disabled={mutation.isPending}>{mutation.isPending ? 'Saving…' : 'Save profile'}</button>
      {mutation.isSuccess && <p role="status">Your profile is saved.</p>}</div>
  </form>;
}

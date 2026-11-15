import { useRef, useState } from 'react';
import { skills, teamPatchSchema } from '@teamforge/shared';
import type { Skill, TeamDetail, TeamPatch } from '@teamforge/shared';
import { useTeamAction } from '../../api/useTeamAction';
import { Field, FormError, failureToErrors, focusFirstError, issuesToErrors } from '../../components/forms';
import type { FieldErrors } from '../../components/forms';
import styles from '../../App.module.css';

export function TeamEditor({ userId, hid, team, close }: { userId: string; hid: string; team: TeamDetail; close: (saved: boolean) => void }) {
  const original = useRef(team);
  const [name, setName] = useState(team.name); const [description, setDescription] = useState(team.description);
  const [lookingFor, setLookingFor] = useState<Skill[]>(team.lookingFor); const [isOpen, setIsOpen] = useState(team.isOpen);
  const [errors, setErrors] = useState<FieldErrors>({});
  const mutation = useTeamAction(userId, hid, { onSuccess: () => close(true), onError: (error) => { setErrors(failureToErrors(error)); focusFirstError(); } });
  return <form className={styles.editor} noValidate onSubmit={(event) => {
    event.preventDefault(); const changed: TeamPatch = {};
    if (name !== original.current.name) changed.name = name;
    if (description !== original.current.description) changed.description = description;
    if (isOpen !== original.current.isOpen) changed.isOpen = isOpen;
    if (JSON.stringify(lookingFor) !== JSON.stringify(original.current.lookingFor)) changed.lookingFor = lookingFor;
    if (!Object.keys(changed).length) { close(false); return; }
    const parsed = teamPatchSchema.safeParse(changed);
    if (!parsed.success) { setErrors(issuesToErrors(parsed.error.issues)); focusFirstError(); return; }
    setErrors({}); mutation.mutate({ path: `/teams/${team.id}`, method: 'PATCH', body: parsed.data });
  }}><h3>Edit team details</h3>
    <Field id="edit-team-name" label="Team name" error={errors.name}><input id="edit-team-name" autoFocus maxLength={60} value={name} disabled={mutation.isPending} onChange={(e) => setName(e.target.value)} aria-invalid={!!errors.name} aria-describedby={errors.name ? 'edit-team-name-error' : undefined} /></Field>
    <Field id="edit-team-description" label="What will you build?" error={errors.description}><input id="edit-team-description" maxLength={500} value={description} disabled={mutation.isPending} onChange={(e) => setDescription(e.target.value)} aria-invalid={!!errors.description} aria-describedby={errors.description ? 'edit-team-description-error' : undefined} /></Field>
    <fieldset className={styles.skillFieldset} disabled={mutation.isPending} tabIndex={-1} aria-invalid={!!errors.lookingFor} aria-describedby={errors.lookingFor ? 'edit-skills-error' : undefined}><legend>Skills you’re looking for</legend>
      <div className={styles.skills}>{skills.map((skill) => <label className={styles.skill} key={skill}><input type="checkbox" checked={lookingFor.includes(skill)} onChange={(e) => setLookingFor(e.target.checked ? [...lookingFor, skill] : lookingFor.filter((s) => s !== skill))} />{skill}</label>)}</div>
      {errors.lookingFor && <p id="edit-skills-error" className={styles.fieldError}>{errors.lookingFor}</p>}
    </fieldset>
    <label className={styles.preference}><input type="checkbox" checked={isOpen} disabled={mutation.isPending} onChange={(e) => setIsOpen(e.target.checked)} />Open to new teammates</label>
    <p className={styles.muted}>Closed teams don’t appear on the board or accept new applications. Private invites still work when there is a free seat.</p>
    <FormError message={errors.form} />{mutation.isPending && <p role="status">Saving team details…</p>}
    <div className={styles.formActions}><button className={styles.primary} disabled={mutation.isPending}>{mutation.isPending ? 'Saving…' : 'Save team changes'}</button>
      <button type="button" className={styles.secondary} disabled={mutation.isPending} onClick={() => close(false)}>Cancel editing</button></div>
  </form>;
}

import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { joinCodeSchema, skills, teamCreateSchema, teamParamsSchema } from '@teamforge/shared';
import type { CreateTeamResult, Hackathon, JoinTeamResult, LeaveTeamResult, MyTeam, Profile, Skill, TeamCreate, TeamDetail } from '@teamforge/shared';
import { api, ApiFailure } from '../../api/client';
import { useIntentRequest } from '../../api/useIntentRequest';
import { clearSession, queryClient, sessionKey, useSession } from '../../api/session';
import { Field, FormError, failureToErrors, focusFirstError, issuesToErrors } from '../../components/forms';
import type { FieldErrors } from '../../components/forms';
import { ConfirmAction, QueryError, SeatMarks } from '../../components/teamUi';
import { refreshHackathon } from '../../api/useTeamAction';
import { ApplicationPanel, PendingRequests, RequestInbox } from '../requests/RequestPanels';
import { TeamEditor } from './TeamEditor';
import { AuditPanel, SuggestionPanel } from './MemberPanels';
import styles from '../../App.module.css';

export function TeamPage() {
  const { data: user } = useSession();
  const [params, setParams] = useSearchParams();
  const { id } = useParams();
  const requested = params.get('hackathon');
  const hid = requested ?? user?.registrations[0]?.hackathonId;
  if (!user) return null;
  if (!hid || !user.registrations.some((item) => item.hackathonId === hid)) return <>
    <h1 tabIndex={-1}>Find your next challenge.</h1><p className={styles.intro}>Register for a hackathon before creating or joining a team.</p><Link to="/profile">Choose a hackathon</Link>
  </>;
  if (id && !teamParamsSchema.safeParse({ hid, tid: id }).success) return <><h1 tabIndex={-1}>Team not found.</h1><Link to="/me">Back to my team</Link></>;
  return <TeamScreen key={`${user.id}:${hid}:${id ?? 'mine'}`} user={user} hid={hid} teamId={id}
    choose={(next) => setParams({ hackathon: next })} />;
}

function TeamScreen({ user, hid, teamId, choose }: { user: Profile; hid: string; teamId: string | undefined; choose: (hid: string) => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const mineKey = ['my-team', user.id, hid];
  const teamKey = ['team', user.id, hid];
  const mine = useQuery({ queryKey: mineKey, queryFn: ({ signal }) => api<MyTeam>(`/hackathons/${hid}/me/team`, { signal }) });
  const detail = useQuery({ queryKey: [...teamKey, teamId], enabled: !!teamId,
    queryFn: ({ signal }) => api<TeamDetail>(`/hackathons/${hid}/teams/${teamId}`, { signal }) });
  const events = useQuery({ queryKey: ['hackathons', user.id], queryFn: ({ signal }) => api<{ items: Hackathon[] }>('/hackathons', { signal }) });
  const team = teamId ? detail.data : mine.data?.team;
  const member = !!team?.members.some((person) => person.userId === user.id);
  const leader = team?.leader.id === user.id;
  useEffect(() => {
    if (!teamId && mine.data?.team) navigate(`/teams/${mine.data.team.id}?hackathon=${hid}`, { replace: true });
  }, [teamId, mine.data?.team, hid, navigate]);
  useEffect(() => {
    if (!team) return;
    const hidden = [...(!member ? ['audit', 'suggestions'] : []), ...(!leader ? ['requests', 'invite'] : [])];
    const filter = { predicate: (query: { queryKey: readonly unknown[] }) => hidden.includes(String(query.queryKey[0])) && query.queryKey[1] === user.id && query.queryKey[2] === hid && query.queryKey[3] === team.id };
    void queryClient.cancelQueries(filter); queryClient.removeQueries(filter);
  }, [team, member, leader, user.id, hid]);
  const isCurrentUser = () => queryClient.getQueryData<Profile | null>(sessionKey)?.id === user.id;
  const refresh = () => refreshHackathon(user.id, hid);
  const changed = async (result: CreateTeamResult | JoinTeamResult) => {
    if (!isCurrentUser()) return;
    await refresh();
    if (isCurrentUser()) navigate(`/teams/${result.team.id}?hackathon=${hid}`);
  };
  const onError = (error: unknown) => { if (error instanceof ApiFailure && error.status === 401 && isCurrentUser()) clearSession(); };
  const formError = async (error: unknown) => {
    onError(error);
    if (isCurrentUser()) await refresh();
  };
  const activeQuery = teamId ? detail : mine;
  useEffect(() => {
    if (!team && !activeQuery.isPending && ['#create-team', '#join-team'].includes(location.hash)) {
      requestAnimationFrame(() => document.querySelector<HTMLInputElement>(`${location.hash} input`)?.focus());
    }
  }, [team, activeQuery.isPending, location.hash]);
  return <>
    <div className={styles.pageTitle}><Link className={styles.backLink} to={`/?hackathon=${hid}`}>Find teams</Link><h1 tabIndex={-1}>{team?.name ?? (teamId ? 'Team workspace' : 'My team')}</h1>
      <p className={styles.intro}>{team ? 'Your people, your next build.' : 'Start a team, use an invite or keep track of your applications.'}</p>
      {user.registrations.length > 1 ? <Field id="team-hackathon" label="Hackathon"><select id="team-hackathon" value={hid} onChange={(e) => {
        if (teamId) navigate(`/me?hackathon=${e.target.value}`); else choose(e.target.value);
      }}>{user.registrations.map((registration) => <option key={registration.hackathonId} value={registration.hackathonId}>
        {events.data?.items.find((event) => event.id === registration.hackathonId)?.name ?? registration.hackathonId}
      </option>)}</select></Field> : <p className={styles.muted}>{events.data?.items.find((event) => event.id === hid)?.name}</p>}
    </div>
    {location.state?.notice === 'left' && <p role="status" className={styles.notice}>You left the team.</p>}
    {activeQuery.isPending && <p role="status">Loading your team…</p>}
    <QueryError error={activeQuery.error} retry={activeQuery.refetch} />
    {activeQuery.error && <p><Link to={`/me?hackathon=${hid}`}>Back to my team</Link></p>}
    {teamId && <QueryError error={mine.error} retry={mine.refetch} />}
    {team && <TeamCard team={team} userId={user.id} hid={hid} refresh={refresh} onError={onError} left={async () => {
      if (!isCurrentUser()) return;
      await refresh();
      if (isCurrentUser()) navigate(`/me?hackathon=${hid}`, { replace: true, state: { notice: 'left' } });
    }} />}
    {!activeQuery.isPending && !activeQuery.error && !team && <>
      <p className={styles.muted}>You haven’t joined a team for this hackathon yet.</p>
      {mine.data && <PendingRequests userId={user.id} hid={hid} requests={mine.data.pendingRequests} />}
      <div className={styles.teamForms}><CreateForm userId={user.id} hid={hid} changed={changed} onError={formError} /><JoinForm userId={user.id} hid={hid} changed={changed} onError={formError} /></div>
    </>}
    {team && !member && <><ApplicationPanel userId={user.id} hid={hid} team={team} mine={mine.data} /><p><Link className={styles.backLink} to={`/me?hackathon=${hid}#join-team`}>Have a private invite? Join with a code.</Link></p></>}
    {team && leader && <RequestInbox key={team.id} userId={user.id} hid={hid} team={team} />}
    {team && member && <><SuggestionPanel key={`suggestions:${team.id}`} userId={user.id} hid={hid} teamId={team.id} /><AuditPanel key={`audit:${team.id}`} userId={user.id} hid={hid} team={team} /></>}
  </>;
}

type FormProps = { userId: string; hid: string; changed: (result: CreateTeamResult | JoinTeamResult) => Promise<void>; onError: (error: unknown) => void };
function CreateForm({ userId, hid, changed, onError }: FormProps) {
  const [name, setName] = useState(''); const [description, setDescription] = useState('');
  const [lookingFor, setLookingFor] = useState<Skill[]>([]); const [isOpen, setIsOpen] = useState(true);
  const [errors, setErrors] = useState<FieldErrors>({});
  const send = useIntentRequest<CreateTeamResult>(userId);
  const mutation = useMutation({ mutationFn: (body: TeamCreate) => send(`/hackathons/${hid}/teams`, 'POST', body), onSuccess: changed,
    onError: (error) => { onError(error); setErrors(failureToErrors(error)); focusFirstError(); } });
  return <form id="create-team" className={styles.panel} noValidate onSubmit={(event) => {
    event.preventDefault(); const result = teamCreateSchema.safeParse({ name, description, lookingFor, isOpen });
    if (!result.success) { setErrors(issuesToErrors(result.error.issues)); focusFirstError(); return; }
    setErrors({}); mutation.mutate(result.data);
  }}>
    <h2>Create a team</h2>
    <Field id="team-name" label="Team name" error={errors.name}><input id="team-name" maxLength={60} value={name} disabled={mutation.isPending} onChange={(e) => setName(e.target.value)} aria-invalid={!!errors.name} aria-describedby={errors.name ? 'team-name-error' : undefined} /></Field>
    <Field id="team-description" label="What will you build?" hint="Optional. A short description, up to 500 characters." error={errors.description}>
      <input id="team-description" maxLength={500} value={description} disabled={mutation.isPending} onChange={(e) => setDescription(e.target.value)} aria-invalid={!!errors.description} aria-describedby={`team-description-hint${errors.description ? ' team-description-error' : ''}`} />
    </Field>
    <fieldset className={styles.skillFieldset} disabled={mutation.isPending} tabIndex={-1} aria-invalid={!!errors.lookingFor} aria-describedby={errors.lookingFor ? 'create-skills-error' : undefined}><legend>Skills you’re looking for</legend><p className={styles.muted}>Choose up to eight, or leave this open.</p>
      <div className={styles.skills}>{skills.map((skill) => <label className={styles.skill} key={skill}><input type="checkbox" checked={lookingFor.includes(skill)} onChange={(e) => setLookingFor(e.target.checked ? [...lookingFor, skill] : lookingFor.filter((item) => item !== skill))} />{skill}</label>)}</div>
      {errors.lookingFor && <p id="create-skills-error" role="alert" className={styles.fieldError}>{errors.lookingFor}</p>}
    </fieldset>
    <label className={styles.preference}><input type="checkbox" checked={isOpen} disabled={mutation.isPending} onChange={(e) => setIsOpen(e.target.checked)} />Open to new teammates</label>
    <p className={styles.muted}>A valid private invite can still be used when this is turned off.</p>
    <FormError message={errors.form} /><button className={styles.primary} disabled={mutation.isPending}>{mutation.isPending ? 'Creating team…' : 'Create team'}</button>{mutation.isPending && <p role="status">Creating your team…</p>}
  </form>;
}
function JoinForm({ userId, hid, changed, onError }: FormProps) {
  const [code, setCode] = useState(''); const [errors, setErrors] = useState<FieldErrors>({});
  const send = useIntentRequest<JoinTeamResult>(userId);
  const mutation = useMutation({ mutationFn: (body: { code: string }) => send(`/hackathons/${hid}/teams/join-by-code`, 'POST', body), onSuccess: changed,
    onError: (error) => { onError(error); setErrors(failureToErrors(error)); focusFirstError(); } });
  return <form id="join-team" className={styles.panel} noValidate onSubmit={(event) => {
    event.preventDefault(); const result = joinCodeSchema.safeParse({ code });
    if (!result.success) { setErrors(issuesToErrors(result.error.issues)); focusFirstError(); return; }
    setErrors({}); mutation.mutate(result.data);
  }}><h2>Join with a code</h2>
    <p className={styles.muted}>Ask your team leader for their 10-character invite code.</p>
    <Field id="join-code" label="Invite code" error={errors.code}><input id="join-code" autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={10} value={code} disabled={mutation.isPending} onChange={(e) => setCode(e.target.value)} aria-invalid={!!errors.code} aria-describedby={errors.code ? 'join-code-error' : undefined} /></Field>
    <FormError message={errors.form} /><button className={styles.primary} disabled={mutation.isPending}>{mutation.isPending ? 'Joining team…' : 'Join team'}</button>{mutation.isPending && <p role="status">Joining your team…</p>}
  </form>;
}

function TeamCard({ team, userId, hid, refresh, left, onError }: { team: TeamDetail; userId: string; hid: string; refresh: () => Promise<void>; left: () => Promise<void>; onError: (error: unknown) => void }) {
  const dialog = useRef<HTMLDialogElement>(null); const leaveButton = useRef<HTMLButtonElement>(null);
  const [copyStatus, setCopyStatus] = useState(''); const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState(''); const [editing, setEditing] = useState(false); const editButton = useRef<HTMLButtonElement>(null);
  const send = useIntentRequest<LeaveTeamResult>(userId);
  const member = team.members.some((item) => item.userId === userId);
  const leader = team.leader.id === userId;
  useEffect(() => { if (!member) dialog.current?.close(); }, [member]);
  const mutation = useMutation({ mutationFn: () => send(`/hackathons/${hid}/teams/${team.id}/leave`, 'POST', {}),
    onSuccess: async () => { dialog.current?.close(); await left(); }, onError });
  return <section className={styles.teamCard} aria-labelledby="team-title">
    <div className={styles.teamHeading}><h2 id="team-title">Team details</h2>
      <div className={styles.statusTags}><span className={styles.teamReadiness}>{team.ready ? 'Ready to build' : 'Incomplete team'}</span>
        {team.openSeats === 0 && <span className={styles.statusTag}>Full</span>}<span className={styles.statusTag}>{team.isOpen ? 'Open to applications' : 'Closed to applications'}</span></div></div>
    {team.description && <p className={styles.intro}>{team.description}</p>}
    <SeatMarks count={team.memberCount} max={team.maxSize} /><p className={styles.muted} aria-live="polite">{team.memberCount} of {team.maxSize} members · {team.openSeats} open {team.openSeats === 1 ? 'seat' : 'seats'} · {team.minSize} needed to be ready</p>
    {!!team.lookingFor.length && <p className={styles.muted}>Looking for: {team.lookingFor.join(', ')}</p>}
    <p role="status">{notice}</p>
    <ul className={styles.members}>{team.members.map((item) => <li key={item.userId}><span className={styles.avatar} aria-hidden="true">{item.displayName.slice(0, 1).toUpperCase()}</span><div><strong>{item.displayName}{item.userId === userId ? ' (you)' : ''}</strong><p className={styles.muted}>{item.skills.length ? item.skills.join(', ') : 'Skills not added yet'}</p></div>{item.isLeader && <span className={styles.leaderBadge}>Leader</span>}
      {leader && !item.isLeader && <ConfirmAction userId={userId} hid={hid} action={{ path: `/teams/${team.id}/members/${item.userId}`, method: 'DELETE' }} label="Remove" ariaLabel={`Remove ${item.displayName}`} title={`Remove ${item.displayName}?`} confirm="Remove member" success={() => setNotice(`${item.displayName} was removed. The invite code has changed.`)}>
        <p>Their seat will reopen and the current invite code will stop working. They can still apply again or use a newly shared code.</p></ConfirmAction>}
    </li>)}</ul>
    {leader && team.inviteCode && <div className={styles.invitePanel}><h3>Bring someone on board</h3><p className={styles.muted}>Share this code with your next teammate. Private invites also work when the team is closed.</p>
      <Field id="leader-code" label="Invite code"><input id="leader-code" readOnly value={team.inviteCode} onFocus={(event) => event.target.select()} /></Field>
      <button className={styles.secondary} onClick={() => {
        void navigator.clipboard.writeText(team.inviteCode!).then(() => setCopyStatus('Invite code copied.')).catch(() => setCopyStatus('Select the code above and copy it manually.'));
      }}>Copy invite code</button><p role="status" className={styles.muted}>{copyStatus}</p>
      <p className={styles.muted}>{Date.parse(team.inviteExpiresAt!) <= Date.now() ? 'This code has expired. Rotate it to invite someone new.' : `Expires ${new Date(team.inviteExpiresAt!).toLocaleString()}`}</p>
      <ConfirmAction userId={userId} hid={hid} action={{ path: `/teams/${team.id}/invite` }} label="Rotate invite code" title="Replace your invite code?" confirm="Generate new code" dangerous={false} success={() => { setNotice('A new invite code is ready to share. The old code no longer works.'); setCopyStatus(''); }}><p>Anyone holding the old code will need the new one.</p></ConfirmAction>
    </div>}
    {leader && <div className={styles.leaderTools}><button ref={editButton} className={styles.secondary} aria-expanded={editing} aria-controls="team-editor" disabled={editing} onClick={() => setEditing(true)}>Edit team</button>
      {editing && <div id="team-editor"><TeamEditor userId={userId} hid={hid} team={team} close={(saved) => { setEditing(false); if (saved) setNotice('Team details saved.'); requestAnimationFrame(() => editButton.current?.focus()); }} /></div>}
    </div>}
    <div className={styles.formActions}><button className={styles.secondary} disabled={refreshing} onClick={() => {
      setRefreshing(true); void refresh().finally(() => setRefreshing(false));
    }}>{refreshing ? 'Refreshing…' : 'Refresh team'}</button>
      {member && <button ref={leaveButton} className={styles.dangerButton} onClick={() => { mutation.reset(); dialog.current?.showModal(); }}>Leave team</button>}</div>
    <dialog ref={dialog} className={styles.dialog} aria-labelledby="leave-title" onCancel={(event) => { if (mutation.isPending) event.preventDefault(); }} onClose={() => (leaveButton.current ?? document.querySelector<HTMLElement>('h1'))?.focus()}>
      <h2 id="leave-title">Leave {team.name}?</h2><p>{team.memberCount === 1 ? 'You are the last member. Leaving will delete this team.' : leader ? 'The longest-tenured remaining member will become the leader.' : 'Your seat will become available for another teammate.'}</p>
      <FormError message={mutation.error ? failureToErrors(mutation.error).form : undefined} /><div className={styles.formActions}><button className={styles.secondary} autoFocus disabled={mutation.isPending} onClick={() => dialog.current?.close()}>Stay on team</button><button className={styles.dangerButton} disabled={mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? 'Leaving…' : 'Confirm leave'}</button></div>
    </dialog>
  </section>;
}

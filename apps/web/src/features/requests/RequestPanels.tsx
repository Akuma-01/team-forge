import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery } from '@tanstack/react-query';
import { requestCreateSchema } from '@teamforge/shared';
import type { InboxRequest, MyTeam, Page, RequestResult, TeamDetail } from '@teamforge/shared';
import { api } from '../../api/client';
import { useTeamAction } from '../../api/useTeamAction';
import { Field, FormError, failureToErrors, focusFirstError, issuesToErrors } from '../../components/forms';
import type { FieldErrors } from '../../components/forms';
import { ConfirmAction, QueryError, formatOffset, formatTime } from '../../components/teamUi';
import styles from '../../App.module.css';

export function PendingRequests({ userId, hid, requests }: { userId: string; hid: string; requests: MyTeam['pendingRequests'] }) {
  const [notice, setNotice] = useState('');
  return <section className={styles.workspaceSection} aria-labelledby="own-requests-title"><h2 id="own-requests-title">Your applications</h2>
    <p className={styles.muted}>Applications stay pending until a leader decides. You can have up to five at once.</p>
    <p role="status">{notice}</p>
    {requests.length === 0 ? <p className={styles.muted}>No pending applications. <Link to={`/?hackathon=${hid}`}>Find a team to apply to.</Link></p> :
      <ul className={styles.requestList}>{requests.map((request) => <li key={request.id} className={styles.requestRow}>
        <div><h3><Link to={`/teams/${request.teamId}?hackathon=${hid}`}>{request.teamName}</Link></h3><p className={styles.muted}>Pending since {formatTime(request.createdAt)}</p>{request.message && <p>{request.message}</p>}</div>
        <ConfirmAction userId={userId} hid={hid} action={{ path: `/requests/${request.id}`, method: 'DELETE' }} label="Withdraw" ariaLabel={`Withdraw application to ${request.teamName}`}
          title={`Withdraw from ${request.teamName}?`} confirm="Withdraw application" success={() => setNotice(`Application to ${request.teamName} withdrawn.`)}><p>You can apply again later if the team is open and has room.</p></ConfirmAction>
      </li>)}</ul>}
  </section>;
}

export function ApplicationPanel({ userId, hid, team, mine }: { userId: string; hid: string; team: TeamDetail; mine: MyTeam | undefined }) {
  const [message, setMessage] = useState(''); const [errors, setErrors] = useState<FieldErrors>({}); const [notice, setNotice] = useState('');
  const mutation = useTeamAction<RequestResult>(userId, hid, { onSuccess: () => { setNotice('Application sent. You can track it in My team.'); setErrors({}); },
    onError: (error) => { setErrors(failureToErrors(error)); focusFirstError(); } });
  const pending = mine?.pendingRequests.find((request) => request.teamId === team.id);
  return <section className={styles.workspaceSection} aria-labelledby="apply-title"><h2 id="apply-title">Build with this team</h2>
    <p role="status">{notice}</p><FormError message={errors.form} />
    {!mine ? <p className={styles.muted}>Checking your team and applications…</p> : mine.team ? <p>You’re already part of <Link to={`/teams/${mine.team.id}?hackathon=${hid}`}>{mine.team.name}</Link>. Leave your current team before joining another.</p> :
      pending ? <><p>Your application is pending. The leader will decide when to add teammates.</p>{pending.message && <p className={styles.applicationMessage}>{pending.message}</p>}
        <ConfirmAction userId={userId} hid={hid} action={{ path: `/requests/${pending.id}`, method: 'DELETE' }} label="Withdraw application" title="Withdraw your application?" confirm="Withdraw application"
          success={() => { setNotice('Application withdrawn.'); setErrors({}); }}><p>You can apply again later if this team has room.</p></ConfirmAction></> :
        !team.isOpen ? <p>This team is closed to applications. A valid private invite code can still be used if there is a seat available.</p> : team.openSeats === 0 ? <p>This team is full. <Link to={`/?hackathon=${hid}`}>Find a team with room.</Link></p> :
          <form noValidate onSubmit={(event) => {
            event.preventDefault(); const parsed = requestCreateSchema.safeParse({ message });
            if (!parsed.success) { setErrors(issuesToErrors(parsed.error.issues)); focusFirstError(); return; }
            setErrors({}); mutation.mutate({ path: `/teams/${team.id}/requests`, body: parsed.data });
          }}>
            <Field id="application-message" label="What would you like to bring?" hint="Optional. A short message, up to 300 characters." error={errors.message}>
              <input id="application-message" maxLength={300} value={message} disabled={mutation.isPending} onChange={(e) => setMessage(e.target.value)} aria-invalid={!!errors.message} aria-describedby={`application-message-hint${errors.message ? ' application-message-error' : ''}`} />
            </Field>
            <p className={styles.muted}>An application doesn’t reserve a seat. The leader will review your request.</p>
            <button className={styles.primary} disabled={mutation.isPending}>{mutation.isPending ? 'Sending application…' : 'Apply to join'}</button>
            {mutation.isPending && <p role="status">Sending your application…</p>}
          </form>}
  </section>;
}

function InboxRow({ request, userId, hid, full, report }: { request: InboxRequest; userId: string; hid: string; full: boolean; report: (message: string) => void }) {
  const mutation = useTeamAction<RequestResult>(userId, hid, {
    onSuccess: (result) => {
      report(result.request.status === 'accepted' ? `${request.applicant.displayName} joined the team.` : `Application from ${request.applicant.displayName} declined.`);
      document.getElementById('inbox-title')?.focus();
    },
    onError: (error) => report(error.message),
  });
  return <li className={styles.requestRow}><div><h3>{request.applicant.displayName}</h3>
    <p className={styles.muted}>{request.applicant.skills.join(', ') || 'Skills not added yet'} · {formatOffset(request.applicant.utcOffsetMin)}</p>
    {request.message && <p className={styles.applicationMessage}>{request.message}</p>}<p className={styles.muted}>Applied {formatTime(request.createdAt)}</p>
    <FormError message={mutation.error?.message} />{mutation.isPending && <p role="status">Saving the decision…</p>}
  </div><div className={styles.formActions}>
    <button className={styles.primary} disabled={mutation.isPending || full} aria-label={`Accept ${request.applicant.displayName}`} onClick={() => mutation.mutate({ path: `/requests/${request.id}/accept` })}>Accept</button>
    <button className={styles.secondary} disabled={mutation.isPending} aria-label={`Decline ${request.applicant.displayName}`} onClick={() => mutation.mutate({ path: `/requests/${request.id}/decline` })}>Decline</button>
  </div></li>;
}
export function RequestInbox({ userId, hid, team }: { userId: string; hid: string; team: TeamDetail }) {
  const [notice, setNotice] = useState('');
  const inbox = useInfiniteQuery({ queryKey: ['requests', userId, hid, team.id], initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => api<Page<InboxRequest>>(`/hackathons/${hid}/teams/${team.id}/requests?limit=10${pageParam ? `&cursor=${pageParam}` : ''}`, { signal }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const requests = [...new Map(inbox.data?.pages.flatMap((page) => page.items).map((item) => [item.id, item])).values()];
  return <section className={styles.workspaceSection} aria-labelledby="inbox-title"><h2 id="inbox-title" tabIndex={-1}>Applications to your team</h2>
    {team.openSeats === 0 && <p className={styles.notice}>Your team is full. Pending applications stay available until you decline them or a seat opens.</p>}
    <p role="status">{notice}</p>{inbox.isPending && <p role="status">Loading applications…</p>}<QueryError error={inbox.error} retry={inbox.refetch} />
    {!inbox.isPending && !inbox.error && requests.length === 0 && <p className={styles.muted}>No pending applications. {team.isOpen ? 'New applications will appear here.' : 'Open your team to appear on the board.'}</p>}
    {!inbox.isError && <ul className={styles.requestList}>{requests.map((request) => <InboxRow key={request.id} request={request} userId={userId} hid={hid} full={team.openSeats === 0} report={setNotice} />)}</ul>}
    {inbox.hasNextPage && <button className={styles.secondary} disabled={inbox.isFetchingNextPage} onClick={() => {
      void inbox.fetchNextPage().then(() => document.getElementById('inbox-title')?.focus());
    }}>{inbox.isFetchingNextPage ? 'Loading applications…' : 'Load more applications'}</button>}
  </section>;
}

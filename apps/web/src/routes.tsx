import { useEffect, useRef } from 'react';
import { Link, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { api, ApiFailure } from './api/client';
import { clearSession, queryClient, useSession } from './api/session';
import { AuthPage } from './features/auth/AuthPage';
import { ProfileForm } from './features/profile/ProfileForm';
import { Hackathons } from './features/hackathons/Hackathons';
import { TeamPage } from './features/team/TeamPage';
import styles from './App.module.css';

function Frame() {
  const session = useSession();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const previousPath = useRef(pathname);
  const signOut = useMutation({
    mutationFn: () => api('/auth/logout', { method: 'POST', body: {} }),
    onSuccess: () => { clearSession(); navigate('/login', { replace: true }); },
    onError: (error) => { if (error instanceof ApiFailure && error.status === 401) { clearSession(); navigate('/login', { replace: true }); } },
  });
  useEffect(() => {
    if (previousPath.current !== pathname) {
      const heading = document.querySelector('h1');
      if (heading) { heading.tabIndex = -1; heading.focus(); }
      previousPath.current = pathname;
    }
  }, [pathname]);
  useEffect(() => {
    if (session.data === null) {
      const options = { predicate: (query: { queryKey: readonly unknown[] }) => query.queryKey[0] !== 'session' };
      void queryClient.cancelQueries(options);
      queryClient.removeQueries(options);
    }
  }, [session.data]);
  return <div className={styles.shell}>
    <a className="skip-link" href="#main">Skip to content</a>
    <header className={styles.header}>
      <Link className={styles.brand} to="/" aria-label="TeamForge home"><span className={styles.mark} aria-hidden="true">T</span>TeamForge<span className={styles.brandDot}>.</span></Link>
      {session.data ? <nav className={styles.nav} aria-label="Account"><Link to="/me">My team</Link><Link to="/profile">Your profile</Link><button className={styles.textButton} disabled={signOut.isPending} onClick={() => signOut.mutate()}>Sign out</button></nav> : <span className={styles.headerNote}>Good things are built together.</span>}
    </header>
    <main id="main" tabIndex={-1} className={styles.main}>
      {signOut.isError && <p className={styles.error} role="alert">{signOut.error.message}</p>}<Outlet />
    </main>
    <footer className={styles.footer}><span>TeamForge</span><span>Different skills. Shared ambition.</span></footer>
  </div>;
}
function Protected() {
  const session = useSession();
  if (session.isPending) return <p role="status">Checking your session…</p>;
  if (session.isError) return <div role="alert"><h1>Let’s reconnect.</h1><p>{session.error.message}</p><button className={styles.secondary} onClick={() => void session.refetch()}>Try again</button></div>;
  return session.data ? <Outlet /> : <Navigate to="/login" replace />;
}
function ProfilePage({ onboarding = false }: { onboarding?: boolean }) {
  const { data: user } = useSession();
  if (!user) return null;
  return <>
    <div className={styles.pageTitle}><p className={styles.eyebrow}>{onboarding ? 'LET’S GET YOU READY' : 'MAKE IT YOURS'}</p><h1>{onboarding ? 'Tell us what you bring.' : 'Your profile.'}</h1><p className={styles.muted}>Signed in as {user.email}</p></div>
    <div className={styles.profileLayout}><ProfileForm key={user.id} user={user} /><Hackathons user={user} /></div>
    {onboarding && user.registrations.length > 0 && <Link className={styles.continueLink} to="/">Go to your workspace →</Link>}
  </>;
}
function Workspace() {
  const { data: user } = useSession();
  if (!user) return null;
  return <>
    <div className={styles.pageTitle}><p className={styles.eyebrow}>YOUR NEXT CHAPTER</p><h1>Hello, {user.displayName}.</h1><p className={styles.intro}>Your next great collaboration starts here.</p><Link to="/profile">Edit your profile →</Link></div>
    <Hackathons user={user} teamLinks />
  </>;
}
export function AppRoutes() {
  return <Routes><Route element={<Frame />}>
    <Route path="/login" element={<AuthPage key="login" mode="login" />} /><Route path="/signup" element={<AuthPage key="signup" mode="signup" />} />
    <Route element={<Protected />}><Route index element={<Workspace />} /><Route path="/onboarding" element={<ProfilePage onboarding />} /><Route path="/profile" element={<ProfilePage />} /><Route path="/me" element={<TeamPage />} /><Route path="/teams/:id" element={<TeamPage />} /></Route>
    <Route path="*" element={<><h1>Page not found</h1><p><Link to="/">Back to TeamForge</Link></p></>} />
  </Route></Routes>;
}

import styles from './App.module.css';

export function App() {
  return (
    <div className={styles.shell}>
      <a className="skip-link" href="#main">Skip to content</a>
      <header className={styles.header}>
        <a className={styles.brand} href="/" aria-label="TeamForge home">
          <span className={styles.mark} aria-hidden="true">T</span>
          TeamForge<span className={styles.brandDot}>.</span>
        </a>
        <span className={styles.headerNote}>Good things are built together.</span>
      </header>
      <main id="main" tabIndex={-1} className={styles.main}>
        <p className={styles.eyebrow}>YOUR NEXT HACKATHON STARTS HERE</p>
        <h1>Find your people.<br /><span>Build something great.</span></h1>
        <p className={styles.intro}>
          The right mix of skills. A shared spark of curiosity. A team ready to turn an idea into something real.
        </p>
        <div className={styles.notice}>
          <span className={styles.noticeDot} aria-hidden="true" />
          <p>Team formation is coming soon.</p>
        </div>
        <ol className={styles.steps} aria-label="How TeamForge will work">
          <li><span>01</span><h2>Find your fit</h2><p>Discover teams that need what you bring.</p></li>
          <li><span>02</span><h2>Bring it together</h2><p>Connect with people whose skills complement yours.</p></li>
          <li><span>03</span><h2>Make your mark</h2><p>Spend less time organizing and more time building.</p></li>
        </ol>
      </main>
      <footer className={styles.footer}><span>TeamForge</span><span>Different skills. Shared ambition.</span></footer>
    </div>
  );
}

import { useState } from 'react';
import { HostStatus } from './host-status.tsx';
import { SECTIONS } from './sections.ts';
import './shell.css';

/**
 * Navigation plus one mounted slot per section. Inactive slots are hidden, not
 * unmounted, so a section keeps its state (a draft, a scroll position) while
 * another one is shown.
 */
export function Shell() {
  const [active, setActive] = useState(SECTIONS[0]!.id);
  return (
    <div className="shell">
      <nav className="shell-nav">
        {SECTIONS.map(({ id, label }) => (
          <button key={id} type="button" aria-current={id === active ? 'page' : undefined} onClick={() => setActive(id)}>
            {label}
          </button>
        ))}
        <HostStatus />
      </nav>
      {SECTIONS.map(({ id, Component }) => (
        <main key={id} className="shell-section" data-section={id} hidden={id !== active}>
          <Component />
        </main>
      ))}
    </div>
  );
}

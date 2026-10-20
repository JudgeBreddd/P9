import { useEffect } from 'react';
import markup from './shell.html?raw';
import { mountShell } from './controller.mjs';

declare global {
  interface Window { p9?: { getStatus(): Promise<{ status: 'ok' | 'unavailable' }>; usage(): Promise<unknown> } }
}

export default function Shell() {
  useEffect(() => {
    const dispose = mountShell();
    let active = true;
    void (window.p9?.getStatus() ?? Promise.resolve({ status: 'unavailable' }))
      .catch(() => ({ status: 'unavailable' }))
      .then(result => {
        const label = document.getElementById('daemonStatus');
        if (active && label) {
          label.textContent = result.status === 'ok' ? 'Daemon connected' : 'Daemon unavailable';
          label.title = result.status === 'ok' ? 'Status connected; workspace controls still use sample data.' : 'Optional for this preview. Start the daemon and launch with --state to connect.';
        }
      });
    return () => { active = false; dispose(); };
  }, []);
  // Approved static markup, bundled with this module; external data never reaches this sink.
  return <div data-p9-island dangerouslySetInnerHTML={{ __html: markup }} />;
}

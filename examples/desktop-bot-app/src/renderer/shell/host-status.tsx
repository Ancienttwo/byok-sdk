import { useEffect, useState } from 'react';

/** The Host state read once over the bridge; a refused call shows its error rather than a guessed state. */
export function HostStatus() {
  const [text, setText] = useState('Host …');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    window.byok.call('status', undefined).then(
      status => setText(`Host ${status.state}`),
      (error: Error) => {
        setText(`Host unavailable: ${error.message}`);
        setFailed(true);
      },
    );
  }, []);
  return <p className="shell-host" data-error={failed || undefined}>{text}</p>;
}

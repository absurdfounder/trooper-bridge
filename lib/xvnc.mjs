import { execSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';

export function ensureXvnc(display = ':99') {
  const displayNumber = display.replace(':', '');
  const lockPath = `/tmp/.X${displayNumber}-lock`;

  let running = false;
  try {
    execSync(`pgrep -f "Xvnc ${display}"`, { stdio: 'ignore', timeout: 2000 });
    running = true;
  } catch {}

  if (!running && existsSync(lockPath)) {
    try {
      unlinkSync(lockPath);
      console.log(`[xvnc] Removed stale lock ${lockPath}`);
    } catch (error) {
      console.warn(`[xvnc] Failed to remove stale lock ${lockPath}: ${error.message}`);
    }
  }

  if (!running) {
    execSync(`Xvnc ${display} -geometry 1920x1080 -depth 24 -rfbport 5999 -localhost -SecurityTypes None -AlwaysShared -AcceptKeyEvents -AcceptPointerEvents >/tmp/xvnc.log 2>&1 &`, { shell: '/bin/bash' });
    try { execSync('sleep 1'); } catch {}
  }

  try {
    execSync(`DISPLAY=${display} xdpyinfo >/dev/null 2>&1`, { shell: '/bin/bash', timeout: 3000 });
    return { ok: true, display, lockPath, running: true };
  } catch (error) {
    return { ok: false, display, lockPath, running: false, error: error.message };
  }
}

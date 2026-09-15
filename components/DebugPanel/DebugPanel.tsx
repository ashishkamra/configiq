'use client';

import * as React from 'react';
import styles from './DebugPanel.module.css';

interface DebugPanelProps {
  request: Record<string, unknown> | Record<string, unknown>[] | null;
  response: Record<string, unknown> | Record<string, unknown>[] | null;
  status: number | null;
  duration: number | null;
  open: boolean;
  onToggle: (open: boolean) => void;
  endpoint?: string;
}

export function DebugPanel({
  request,
  response,
  status,
  duration,
  open,
  onToggle,
  endpoint,
}: DebugPanelProps) {
  if (!request && !response) return null;

  return (
    <div className={styles.debugSection}>
      <button
        type="button"
        className={styles.debugToggle}
        onClick={() => onToggle(!open)}
        aria-expanded={open}
      >
        <span className={styles.debugToggleIcon}>{open ? '▾' : '▸'}</span>
        Debug panel
        {status !== null && (
          <span className={`${styles.debugStatusBadge} ${status >= 200 && status < 300 ? styles.debugStatusOk : styles.debugStatusErr}`}>
            {status}
          </span>
        )}
        {duration !== null && (
          <span className={styles.debugDuration}>{duration}ms</span>
        )}
      </button>
      {open && (
        <div className={styles.debugBody}>
          <div className={styles.debugPane}>
            <div className={styles.debugPaneHeader}>Request → {endpoint || 'POST'}</div>
            <pre className={styles.debugPre}>
              {JSON.stringify(request, null, 2)}
            </pre>
          </div>
          <div className={styles.debugPane}>
            <div className={styles.debugPaneHeader}>
              Response
              {status !== null && ` (${status})`}
            </div>
            <pre className={styles.debugPre}>
              {response ? JSON.stringify(response, null, 2) : '(no response)'}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

// Single-writer enforcement (§2 invariant 4) and the decisions mailbox (§8).
// Everyone who is not the lock holder communicates by dropping files here.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Decision, DecisionVia } from "./types.ts";

export const LOCK_FILE = "lock";
export const DECISIONS_DIR = "decisions";
const FOREIGN_STALE_MS = 10 * 60_000;

export interface LockInfo {
  pid: number;
  host: string;
  started: string;
}

export function lockPath(runDir: string): string {
  return path.join(runDir, LOCK_FILE);
}

export function readLock(runDir: string): LockInfo | null {
  try {
    return JSON.parse(fs.readFileSync(lockPath(runDir), "utf8")) as LockInfo;
  } catch {
    return null;
  }
}

export function isLockLive(runDir: string, info: LockInfo | null): boolean {
  if (!info) return false;
  if (info.host === os.hostname()) {
    try {
      process.kill(info.pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  // Foreign host: we cannot signal it. Treat a recently-touched lock as live.
  try {
    const age = Date.now() - fs.statSync(lockPath(runDir)).mtimeMs;
    return age < FOREIGN_STALE_MS;
  } catch {
    return false;
  }
}

/** Acquire exclusively. Returns false if a live holder exists. Stale locks are cleared. */
export function acquireLock(runDir: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath(runDir), "wx");
      const info: LockInfo = {
        pid: process.pid,
        host: os.hostname(),
        started: new Date().toISOString(),
      };
      fs.writeSync(fd, JSON.stringify(info));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      return true;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const existing = readLock(runDir);
      if (isLockLive(runDir, existing)) return false;
      try {
        fs.unlinkSync(lockPath(runDir)); // stale; clear and retry once
      } catch {
        /* raced with another cleaner */
      }
    }
  }
  return false;
}

export function releaseLock(runDir: string): void {
  const info = readLock(runDir);
  if (info && info.pid === process.pid && info.host === os.hostname()) {
    try {
      fs.unlinkSync(lockPath(runDir));
    } catch {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------------------
// Decisions mailbox
// ---------------------------------------------------------------------------

export interface DecisionFile {
  name: string;
  occ: number;
  decision: Decision;
  note?: string;
  by: string;
  via: DecisionVia;
  ts: string;
}

export function decisionsDir(runDir: string): string {
  return path.join(runDir, DECISIONS_DIR);
}

/** Operator-note mailbox (ADR-033): read-many, never consumed — words the
 * operator sent mid-run with no gate to receive them. `key` makes surface
 * redelivery idempotent (same comment → same file). */
export interface NoteFile { ts: string; by: string; text: string }
export function notesDir(runDir: string): string {
  return path.join(runDir, "notes");
}
export function writeNote(runDir: string, n: NoteFile, key: string): void {
  fs.mkdirSync(notesDir(runDir), { recursive: true });
  fs.writeFileSync(path.join(notesDir(runDir), `${key}.json`), JSON.stringify(n));
}
export function listNotes(runDir: string): NoteFile[] {
  if (!fs.existsSync(notesDir(runDir))) return [];
  return fs.readdirSync(notesDir(runDir)).filter((f) => f.endsWith(".json")).sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(notesDir(runDir), f), "utf8")) as NoteFile)
    .sort((a, b) => a.ts.localeCompare(b.ts));
}

/** Fail-closed at the edge: callers must verify the gate is open before writing. */
export function writeDecision(runDir: string, d: DecisionFile): void {
  fs.mkdirSync(decisionsDir(runDir), { recursive: true });
  const p = path.join(decisionsDir(runDir), `${d.name}.${d.occ}.json`);
  const fd = fs.openSync(p, "wx"); // a pending decision for this gate already exists => throw
  fs.writeSync(fd, JSON.stringify(d, null, 2));
  fs.fsyncSync(fd);
  fs.closeSync(fd);
}

export function listDecisions(runDir: string): DecisionFile[] {
  const dir = decisionsDir(runDir);
  if (!fs.existsSync(dir)) return [];
  const out: DecisionFile[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
    } catch {
      process.stderr.write(`etium: unreadable decision file ${f}\n`);
    }
  }
  return out;
}

export function removeDecision(runDir: string, name: string, occ: number): void {
  try {
    fs.unlinkSync(path.join(decisionsDir(runDir), `${name}.${occ}.json`));
  } catch {
    /* already gone */
  }
}

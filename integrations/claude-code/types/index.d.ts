// The values the /rmb pane draws from: the brief as `remembrancer brief --json`
// prints it (the parts the pane shows), and the last search typed in the pane.

export type RmbEntry = { id: string; kind: string; file: string; title: string; meta: Record<string, string> };

export type RmbRule = {
  id: string;
  title: string;
  status: string;
  form: string | null;
  tested: boolean;
  check: { status: string; at: string; message: string } | null;
};

export type RmbBrief = {
  project: string;
  owner: string | null;
  waiting: RmbEntry[];
  phase: { plan: RmbEntry; phase: string | null; done: number; total: number; next: RmbEntry[] } | null;
  inbox: number;
  rules: RmbRule[];
  checks: { pass: number; fail: number; unrunnable: number; notRun: number };
};

export type RmbHit = { id: string; via?: string; title: string; file: string };

export type RmbSearch = { query: string; hits: RmbHit[]; error?: string };

declare module 'claude-code' {
  interface PluginState {
    remembrancer: { brief: RmbBrief | null; briefText: string; search: RmbSearch | null };
  }
}

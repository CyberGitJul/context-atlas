/** Interface texts of the commit offer for files in a project repo: RepoPanel.tsx. */
export const repo = {
  label: (repo: string) => `Git state of ${repo}`,
  uncommitted: (n: number) => `${n} ${n === 1 ? 'change' : 'changes'} not committed yet in`,
  onBranch: (branch: string) => `on ${branch}`,
  detached: 'detached HEAD',
  /** Git's two status letters as a word. */
  status: (code: string, from?: string) => {
    if (code === '??') return 'new';
    if (code.includes('U') || code === 'AA' || code === 'DD') return 'conflict';
    if (code[0] === 'R' || code[1] === 'R') return from ? `renamed from ${from}` : 'renamed';
    if (code.includes('D')) return 'deleted';
    if (code[0] === 'A') return 'added';
    return 'modified';
  },
  moreFiles: (n: number) => `${n} more ${n === 1 ? 'file' : 'files'}`,
  message: 'Commit message',
  defaultMessage: (files: string[]) => (files.length === 1 ? `Update ${files[0].split('/').at(-1)}` : files.length ? `Update ${files.length} files` : ''),
  commit: (n: number) => `Commit ${n} ${n === 1 ? 'file' : 'files'}`,
  committing: 'Committing …',
  commitNote: 'Commits only the ticked files, with your Git identity and hooks. Pushing stays with you.',
  committed: (hash: string) => `Committed ${hash}.`,
  serverDown: 'The server cannot be reached. Nothing was committed.',
  notPushed: (n: number, upstream: string) => `${n} ${n === 1 ? 'commit' : 'commits'} not pushed to ${upstream} yet. Push with`,
  noUpstream: (branch: string) => `The branch ${branch} has no upstream yet; pushing it is up to you.`,
  behind: (n: number) => `${n} ${n === 1 ? 'commit' : 'commits'} behind its upstream, as of the last fetch.`,
  copy: 'Copy',
  copied: 'Copied',
  copyLabel: 'Copy the push command',
};

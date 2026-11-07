/** A path as one shell word: plain when that is safe, else in single quotes. */
const SAFE = /^[\w@%+=:,./-]+$/;
const shellWord = (s: string) => (SAFE.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`);

/** The command the commit offer shows for pushing a repo; a leading `~/` stays unquoted, so the shell still expands it. */
export function pushCommand(repo: string): string {
  return `git -C ${repo.startsWith('~/') ? `~/${shellWord(repo.slice(2))}` : shellWord(repo)} push`;
}

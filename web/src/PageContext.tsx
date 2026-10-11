import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { NewKind } from '../../src/shared/model';
import { t } from './text';

/** What the chat knows about the page the user is on. */
export interface ChatPage {
  /** Component id (or `file:<path>` on a file page); null on the overview. */
  id: string | null;
  /** Path of a proposed file opened from the chat. */
  file?: string;
  /** A page for creating something new (no text of its own); the chat gets its own area for it. */
  create?: NewKind;
  /** Hash route of pages that are neither a component nor a file. */
  href?: string;
  name: string;
  /** Editor text including unsaved changes. */
  draft?: string;
  editable: boolean;
  hasSecrets: boolean;
  /** Puts a proposal into the before/after review of this page. */
  apply?: (text: string) => void;
}

/** Hash route of a page: #/c/<id>, #/f/<path> or #/ for the overview. */
export const hrefOf = (p: { id: string | null; file?: string; href?: string }) =>
  p.href ?? (p.file ? `#/f/${encodeURIComponent(p.file)}` : p.id ? `#/c/${encodeURIComponent(p.id)}` : '#/');

/** A chat proposal on its way to the page it belongs to; that page puts it into its before/after review. */
export interface PendingProposal {
  /** Hash route of the target page (see hrefOf). */
  target: string;
  text: string;
  /** Where the proposal was written: the way back from a file page. */
  from: { href: string; name: string } | null;
  /** New on every click, so a second click on the page already open applies again. */
  nonce: number;
}

/** The overview page; its display name comes from the dictionary where it is published. */
const OVERVIEW: ChatPage = { id: null, name: '', editable: false, hasSecrets: false };
interface PageState {
  page: ChatPage;
  setPage: (p: ChatPage) => void;
  pending: PendingProposal | null;
  setPending: (p: PendingProposal | null) => void;
}
const Ctx = createContext<PageState>({ page: OVERVIEW, setPage: () => {}, pending: null, setPending: () => {} });

export function PageProvider({ children }: { children: ReactNode }) {
  const [page, setPage] = useState<ChatPage>(OVERVIEW);
  const [pending, setPending] = useState<PendingProposal | null>(null);
  return <Ctx.Provider value={{ page, setPage, pending, setPending }}>{children}</Ctx.Provider>;
}

export const useChatPage = () => useContext(Ctx).page;

export function usePendingProposal() {
  const { pending, setPending } = useContext(Ctx);
  return { pending, setPending };
}

/** Hands a proposal to its page and goes there (or lets the open page pick it up). */
export function openProposal(setPending: (p: PendingProposal) => void, p: Omit<PendingProposal, 'nonce'>) {
  setPending({ ...p, nonce: Date.now() });
  if (location.hash !== p.target) location.hash = p.target;
}

/** A page announces itself to the chat; the overview passes nothing. */
export function usePublishPage(p?: ChatPage) {
  const { setPage } = useContext(Ctx);
  const { id, file, create, href, name, draft, editable, hasSecrets, apply } = p ?? { ...OVERVIEW, name: t.chat.page.overview };
  useEffect(
    () => setPage({ id, file, create, href, name, draft, editable, hasSecrets, apply }),
    [setPage, id, file, create, href, name, draft, editable, hasSecrets, apply],
  );
}

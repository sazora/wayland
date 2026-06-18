/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TChatConversation } from '@/common/config/storage';
import type { IProject } from '@/common/types/project';
import { Button } from '@arco-design/web-react';
import { Ban, Clock3, DownloadCloud, FileText, Mail, MessageSquare } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import styles from './projectCards.module.css';

type ReferenceFile = { name: string; path: string; size: number };

type RemoteAttachmentLink = {
  url: string;
  label?: string;
  filename?: string;
  size?: string;
  status?: 'pending' | 'saved' | 'failed' | 'ignored';
  savedReferenceFile?: string;
  downloadedAt?: number;
  bytes?: number;
  lastError?: string;
  ignoredAt?: number;
};

type EmailIngestRecord = {
  id: string;
  from: string;
  subject: string;
  receivedAt: number;
  status: 'saved' | 'rejected' | 'failed';
  reason?: string;
  referenceFiles: string[];
  generatedFiles?: string[];
  actions?: string[];
  attachmentCount: number;
  remoteAttachmentLinks?: RemoteAttachmentLink[];
};

type HistoryKind = 'project' | 'chat' | 'email' | 'reference' | 'remote-import' | 'remote-ignore' | 'inventory';

type HistoryItem = {
  id: string;
  kind: HistoryKind;
  time?: number;
  title: string;
  detail?: string;
  meta?: string;
  target?: string;
};

const normalizeTime = (value?: number): number | undefined => {
  if (!value || Number.isNaN(value)) return undefined;
  return value < 10_000_000_000 ? value * 1000 : value;
};

const fmtTime = (value?: number): string => {
  if (!value) return 'No timestamp';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
};

const fmtSize = (bytes?: number): string | undefined => {
  if (!bytes || bytes < 0) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const compact = (values: Array<string | number | undefined | null | false>): string =>
  values
    .filter((value): value is string | number => value !== undefined && value !== null && value !== false && value !== '')
    .map(String)
    .join(' · ');

async function parseReferenceResponse(response: Response): Promise<ReferenceFile[]> {
  const json = await response.json().catch((): null => null);
  if (!response.ok || json?.ok === false) throw new Error(json?.error || 'wl-reference-list-failed');
  return Array.isArray(json?.files) ? json.files : [];
}

async function parseEmailHistoryResponse(response: Response): Promise<EmailIngestRecord[]> {
  const json = await response.json().catch((): null => null);
  if (!response.ok || json?.ok === false) throw new Error(json?.error || 'project-email-history-load-failed');
  return Array.isArray(json?.history) ? json.history : [];
}

function iconFor(kind: HistoryKind): React.ReactNode {
  if (kind === 'chat') return <MessageSquare size={15} />;
  if (kind === 'email') return <Mail size={15} />;
  if (kind === 'reference' || kind === 'inventory') return <FileText size={15} />;
  if (kind === 'remote-import') return <DownloadCloud size={15} />;
  if (kind === 'remote-ignore') return <Ban size={15} />;
  return <Clock3 size={15} />;
}

function buildHistoryItems(
  project: IProject,
  conversations: TChatConversation[],
  emailHistory: EmailIngestRecord[],
  references: ReferenceFile[],
): HistoryItem[] {
  const items: HistoryItem[] = [];
  const knownReferenceNames = new Set<string>();

  items.push({
    id: 'project-created',
    kind: 'project',
    time: normalizeTime(project.createTime),
    title: 'Project created',
    detail: project.name,
  });

  const projectModified = normalizeTime(project.modifyTime);
  if (projectModified && projectModified !== normalizeTime(project.createTime)) {
    items.push({
      id: 'project-updated',
      kind: 'project',
      time: projectModified,
      title: 'Project updated',
      detail: project.name,
    });
  }

  for (const conversation of conversations) {
    const backend = (conversation.extra as { backend?: string } | undefined)?.backend || conversation.type;
    items.push({
      id: `chat-${conversation.id}`,
      kind: 'chat',
      time: normalizeTime(conversation.modifyTime ?? conversation.createTime),
      title: conversation.name || 'Untitled chat',
      detail: backend,
      meta: 'Chat',
      target: `/conversation/${conversation.id}`,
    });
  }

  for (const record of emailHistory) {
    const receivedAt = normalizeTime(record.receivedAt);
    const remoteLinks = record.remoteAttachmentLinks ?? [];
    const importedRemote = remoteLinks.filter((link) => link.status === 'saved').length;
    const ignoredRemote = remoteLinks.filter((link) => link.status === 'ignored').length;

    items.push({
      id: `email-${record.id}`,
      kind: 'email',
      time: receivedAt,
      title: record.subject || 'Project email ingested',
      detail: record.from ? `From ${record.from}` : undefined,
      meta: compact([
        record.status !== 'saved' ? record.status : undefined,
        record.attachmentCount ? `${record.attachmentCount} attachment${record.attachmentCount === 1 ? '' : 's'}` : undefined,
        record.referenceFiles?.length ? `${record.referenceFiles.length} reference${record.referenceFiles.length === 1 ? '' : 's'}` : undefined,
        remoteLinks.length ? `${remoteLinks.length} remote` : undefined,
        importedRemote ? `${importedRemote} imported` : undefined,
        ignoredRemote ? `${ignoredRemote} excluded` : undefined,
      ]),
    });

    for (const fileName of record.referenceFiles ?? []) {
      knownReferenceNames.add(fileName);
      items.push({
        id: `email-reference-${record.id}-${fileName}`,
        kind: 'reference',
        time: receivedAt,
        title: 'Reference saved from email',
        detail: fileName,
        meta: record.subject,
      });
    }

    remoteLinks.forEach((link, index) => {
      const label = link.savedReferenceFile || link.filename || link.label || 'Remote attachment';
      if (link.savedReferenceFile) knownReferenceNames.add(link.savedReferenceFile);
      if (link.status === 'saved') {
        items.push({
          id: `remote-import-${record.id}-${index}`,
          kind: 'remote-import',
          time: normalizeTime(link.downloadedAt) ?? receivedAt,
          title: 'Remote attachment imported',
          detail: label,
          meta: compact([link.size, fmtSize(link.bytes), record.subject]),
        });
      }
      if (link.status === 'ignored') {
        items.push({
          id: `remote-ignore-${record.id}-${index}`,
          kind: 'remote-ignore',
          time: normalizeTime(link.ignoredAt) ?? receivedAt,
          title: 'Remote attachment excluded',
          detail: label,
          meta: compact([link.size, record.subject]),
        });
      }
    });
  }

  for (const reference of references) {
    if (knownReferenceNames.has(reference.name)) continue;
    items.push({
      id: `inventory-${reference.name}`,
      kind: 'inventory',
      title: 'Reference available',
      detail: reference.name,
      meta: fmtSize(reference.size),
    });
  }

  return items.toSorted((a, b) => (b.time ?? 0) - (a.time ?? 0));
}

const ProjectHistoryPanel: React.FC<{
  project: IProject;
  conversations: TChatConversation[];
}> = ({ project, conversations }) => {
  const navigate = useNavigate();
  const [emailHistory, setEmailHistory] = useState<EmailIngestRecord[]>([]);
  const [references, setReferences] = useState<ReferenceFile[]>([]);
  const [loading, setLoading] = useState(true);
  const hasWorkspace = Boolean(project.workspace);

  const load = useCallback(async () => {
    if (!hasWorkspace) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [referenceResponse, historyResponse] = await Promise.all([
        fetch(`/wl-project/reference?id=${encodeURIComponent(project.id)}`, { credentials: 'include' }),
        fetch(`/api/project-email-ingest/history?id=${encodeURIComponent(project.id)}`, { credentials: 'include' }),
      ]);
      const [nextReferences, nextHistory] = await Promise.all([
        parseReferenceResponse(referenceResponse),
        parseEmailHistoryResponse(historyResponse),
      ]);
      setReferences(nextReferences);
      setEmailHistory(nextHistory);
    } catch (err) {
      console.warn('[ProjectHistoryPanel] history load failed:', err);
    } finally {
      setLoading(false);
    }
  }, [hasWorkspace, project.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const items = useMemo(
    () => buildHistoryItems(project, conversations, emailHistory, references),
    [project, conversations, emailHistory, references],
  );

  const stats = useMemo(
    () => ({
      chats: conversations.length,
      emails: emailHistory.length,
      references: references.length,
      remotes: emailHistory.reduce((count, record) => count + (record.remoteAttachmentLinks?.length ?? 0), 0),
    }),
    [conversations.length, emailHistory, references.length],
  );

  if (loading) return null;

  return (
    <div className='mx-auto flex max-w-900px flex-col gap-14px'>
      <div className='flex flex-wrap items-start justify-between gap-12px'>
        <div className='flex flex-col gap-2px'>
          <div className='text-15px font-700 text-t-primary'>Project history</div>
          <div className='text-12px text-t-tertiary leading-relaxed'>
            Chats, email ingests, reference saves, and remote attachment actions for this project.
          </div>
        </div>
        <div className='flex flex-wrap items-center gap-6px text-11px text-t-tertiary'>
          <span className='px-8px py-4px rd-full bg-fill-1'>{stats.chats} chats</span>
          <span className='px-8px py-4px rd-full bg-fill-1'>{stats.emails} emails</span>
          <span className='px-8px py-4px rd-full bg-fill-1'>{stats.references} refs</span>
          {stats.remotes > 0 && <span className='px-8px py-4px rd-full bg-fill-1'>{stats.remotes} remote</span>}
        </div>
      </div>

      <div className={`flex flex-col ${styles.surface}`}>
        {items.map((item, index) => {
          const clickable = Boolean(item.target);
          const body = (
            <>
              <div className='flex h-32px w-32px shrink-0 items-center justify-center rd-8px bg-fill-2 text-t-secondary'>
                {iconFor(item.kind)}
              </div>
              <div className='min-w-0 flex-1'>
                <div className='flex flex-wrap items-center gap-x-8px gap-y-2px'>
                  <span className='text-13px font-650 text-t-primary'>{item.title}</span>
                  <span className='text-11px text-t-tertiary'>{fmtTime(item.time)}</span>
                </div>
                {item.detail && <div className='mt-2px truncate text-12px text-t-secondary'>{item.detail}</div>}
                {item.meta && <div className='mt-2px truncate text-11px text-t-tertiary'>{item.meta}</div>}
              </div>
            </>
          );

          return clickable ? (
            <button
              key={item.id}
              type='button'
              className='flex w-full cursor-pointer items-start gap-12px border-none bg-transparent px-14px py-12px text-left transition-colors hover:bg-fill-1'
              style={{ borderTop: index === 0 ? undefined : '1px solid var(--color-border-2)' }}
              onClick={() => item.target && navigate(item.target)}
            >
              {body}
            </button>
          ) : (
            <div
              key={item.id}
              className='flex items-start gap-12px px-14px py-12px'
              style={{ borderTop: index === 0 ? undefined : '1px solid var(--color-border-2)' }}
            >
              {body}
            </div>
          );
        })}
      </div>

      {!hasWorkspace && (
        <div className='rd-8px border border-dashed border-2 px-14px py-12px text-12px text-t-tertiary'>
          Connect a workspace folder to include email ingest and reference history.
        </div>
      )}

      <div className='flex justify-end'>
        <Button size='small' type='text' onClick={() => void load()}>
          Refresh
        </Button>
      </div>
    </div>
  );
};

export default ProjectHistoryPanel;

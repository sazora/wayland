/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TChatConversation } from '@/common/config/storage';
import { ipcBridge } from '@/common';
import type { IProject } from '@/common/types/project';
import type { ProjectOutboundMessage } from '@/common/types/projectExecutiveAssistant';
import { Button } from '@arco-design/web-react';
import { ArrowRight, Ban, Clock3, DownloadCloud, FileText, Mail, MessageSquare, Send } from 'lucide-react';
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

type HistoryKind =
  | 'project'
  | 'chat'
  | 'email'
  | 'reference'
  | 'remote-import'
  | 'remote-ignore'
  | 'remote-pending'
  | 'outbound'
  | 'inventory';

type HistoryFilter = 'all' | 'chat' | 'email' | 'reference' | 'remote' | 'outbound';

type HistoryItem = {
  id: string;
  kind: HistoryKind;
  time?: number;
  title: string;
  eyebrow: string;
  summary: string;
  detail?: string;
  meta?: string;
  related: Array<{ label: string; value: string }>;
  target?: string;
  targetLabel?: string;
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

const subjectLabel = (subject: string | undefined): string => subject?.trim() || 'No subject';

const fileCountLabel = (count: number, singular: string, plural = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : plural}`;

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
  if (kind === 'outbound') return <Send size={15} />;
  if (kind === 'reference' || kind === 'inventory') return <FileText size={15} />;
  if (kind === 'remote-import' || kind === 'remote-pending') return <DownloadCloud size={15} />;
  if (kind === 'remote-ignore') return <Ban size={15} />;
  return <Clock3 size={15} />;
}

function itemMatchesFilter(item: HistoryItem, filter: HistoryFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'reference') return item.kind === 'reference' || item.kind === 'inventory';
  if (filter === 'remote') return item.kind === 'remote-import' || item.kind === 'remote-ignore' || item.kind === 'remote-pending';
  return item.kind === filter;
}

function buildHistoryItems(
  project: IProject,
  conversations: TChatConversation[],
  emailHistory: EmailIngestRecord[],
  references: ReferenceFile[],
  outbound: ProjectOutboundMessage[],
): HistoryItem[] {
  const items: HistoryItem[] = [];
  const knownReferenceNames = new Set<string>();

  items.push({
    id: 'project-created',
    kind: 'project',
    time: normalizeTime(project.createTime),
    title: 'Project created',
    eyebrow: 'Project',
    summary: `${project.name} was created as a Wayland project. This is the start of the project timeline.`,
    detail: project.name,
    related: compact([project.workspace ? `Workspace: ${project.workspace}` : undefined])
      ? [{ label: 'Project', value: project.workspace ? `${project.name} · ${project.workspace}` : project.name }]
      : [{ label: 'Project', value: project.name }],
  });

  const projectModified = normalizeTime(project.modifyTime);
  if (projectModified && projectModified !== normalizeTime(project.createTime)) {
    items.push({
      id: 'project-updated',
      kind: 'project',
      time: projectModified,
      title: 'Project updated',
      eyebrow: 'Project',
      summary: `${project.name} changed after creation. This usually means project settings, metadata, workspace, or attached project state was updated.`,
      detail: project.name,
      related: [{ label: 'Project', value: project.name }],
    });
  }

  for (const conversation of conversations) {
    const backend = (conversation.extra as { backend?: string } | undefined)?.backend || conversation.type;
    const title = conversation.name || 'Untitled chat';
    items.push({
      id: `chat-${conversation.id}`,
      kind: 'chat',
      time: normalizeTime(conversation.modifyTime ?? conversation.createTime),
      title,
      eyebrow: 'Chat',
      summary: `A project chat titled "${title}" was active. History can identify when the chat was touched and which backend it used; open the chat for the full transcript and decisions.`,
      detail: backend,
      meta: 'Chat',
      related: compact([backend, conversation.type]).split(' · ').map((value, index) => ({
        label: index === 0 ? 'Backend' : 'Type',
        value,
      })),
      target: `/conversation/${conversation.id}`,
      targetLabel: 'Open chat',
    });
  }

  for (const record of emailHistory) {
    const receivedAt = normalizeTime(record.receivedAt);
    const remoteLinks = record.remoteAttachmentLinks ?? [];
    const importedRemote = remoteLinks.filter((link) => link.status === 'saved').length;
    const ignoredRemote = remoteLinks.filter((link) => link.status === 'ignored').length;
    const savedReferenceCount = record.referenceFiles?.length ?? 0;
    const emailTitle = subjectLabel(record.subject);
    const emailMeta = compact([
      record.status !== 'saved' ? record.status : undefined,
      record.attachmentCount ? fileCountLabel(record.attachmentCount, 'attachment') : undefined,
      savedReferenceCount ? fileCountLabel(savedReferenceCount, 'reference') : undefined,
      remoteLinks.length ? `${remoteLinks.length} remote` : undefined,
      importedRemote ? `${importedRemote} imported` : undefined,
      ignoredRemote ? `${ignoredRemote} excluded` : undefined,
    ]);

    items.push({
      id: `email-${record.id}`,
      kind: 'email',
      time: receivedAt,
      title: emailTitle,
      eyebrow: 'Email ingest',
      summary: `WL received this project email${record.from ? ` from ${record.from}` : ''}. It ${record.status === 'saved' ? 'saved the ingest record' : `ended with status "${record.status}"`}${savedReferenceCount ? ` and added ${fileCountLabel(savedReferenceCount, 'reference')} to the project` : ''}${remoteLinks.length ? ` while capturing ${remoteLinks.length} remote attachment link${remoteLinks.length === 1 ? '' : 's'}` : ''}.`,
      detail: record.from ? `From ${record.from}` : undefined,
      meta: emailMeta,
      related: [
        ...(record.from ? [{ label: 'From', value: record.from }] : []),
        { label: 'Status', value: record.status },
        ...(record.attachmentCount ? [{ label: 'Attachments', value: String(record.attachmentCount) }] : []),
        ...(savedReferenceCount ? [{ label: 'References saved', value: String(savedReferenceCount) }] : []),
        ...(remoteLinks.length ? [{ label: 'Remote links', value: String(remoteLinks.length) }] : []),
        ...(record.reason ? [{ label: 'Reason', value: record.reason }] : []),
      ],
    });

    for (const fileName of record.referenceFiles ?? []) {
      knownReferenceNames.add(fileName);
      items.push({
        id: `email-reference-${record.id}-${fileName}`,
        kind: 'reference',
        time: receivedAt,
        title: 'Reference saved from email',
        eyebrow: 'Reference',
        summary: `WL saved "${fileName}" from the email "${emailTitle}". This file is now part of the project reference set and can be used as context in project chats.`,
        detail: fileName,
        meta: record.subject,
        related: [
          { label: 'File', value: fileName },
          { label: 'Source email', value: emailTitle },
          ...(record.from ? [{ label: 'From', value: record.from }] : []),
        ],
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
          eyebrow: 'Remote attachment',
          summary: `A Mail Drop or remote attachment link from "${emailTitle}" was imported into project references${link.savedReferenceFile ? ` as "${link.savedReferenceFile}"` : ''}.`,
          detail: label,
          meta: compact([link.size, fmtSize(link.bytes), record.subject]),
          related: [
            { label: 'Attachment', value: label },
            { label: 'Source email', value: emailTitle },
            ...(link.size ? [{ label: 'Reported size', value: link.size }] : []),
            ...(fmtSize(link.bytes) ? [{ label: 'Downloaded size', value: fmtSize(link.bytes)! }] : []),
          ],
        });
      }
      if (link.status === 'ignored') {
        items.push({
          id: `remote-ignore-${record.id}-${index}`,
          kind: 'remote-ignore',
          time: normalizeTime(link.ignoredAt) ?? receivedAt,
          title: 'Remote attachment excluded',
          eyebrow: 'Remote attachment',
          summary: `A captured remote attachment from "${emailTitle}" was intentionally excluded. It remains recorded in history, but it will not sit in the pending remote attachment queue.`,
          detail: label,
          meta: compact([link.size, record.subject]),
          related: [
            { label: 'Attachment', value: label },
            { label: 'Source email', value: emailTitle },
            ...(link.size ? [{ label: 'Reported size', value: link.size }] : []),
          ],
        });
      }
      if (!link.status || link.status === 'pending' || link.status === 'failed') {
        const failed = link.status === 'failed';
        items.push({
          id: `remote-pending-${record.id}-${index}`,
          kind: 'remote-pending',
          time: receivedAt,
          title: failed ? 'Remote attachment import failed' : 'Remote attachment captured',
          eyebrow: 'Remote attachment',
          summary: failed
            ? `WL tried to import a captured remote attachment from "${emailTitle}", but the download failed. It can be retried from the References remote attachment queue.`
            : `WL captured a Mail Drop or remote attachment link from "${emailTitle}". It is waiting to be imported into references or excluded.`,
          detail: label,
          meta: compact([link.size, failed ? link.lastError : undefined, record.subject]),
          related: [
            { label: 'Attachment', value: label },
            { label: 'Source email', value: emailTitle },
            { label: 'Status', value: link.status || 'pending' },
            ...(link.size ? [{ label: 'Reported size', value: link.size }] : []),
            ...(link.lastError ? [{ label: 'Last error', value: link.lastError }] : []),
          ],
        });
      }
    });
  }

  for (const message of outbound) {
    items.push({
      id: `outbound-${message.id}`,
      kind: 'outbound',
      time: normalizeTime(message.sentAt ?? message.failedAt ?? message.modifyTime ?? message.createTime),
      title: message.subject || `Outbound ${message.channel}`,
      eyebrow: 'Outbound',
      summary:
        message.status === 'sent'
          ? `WL sent this ${message.channel} message to ${message.contactName || message.to}.`
          : message.status === 'failed'
            ? `WL tried to send this ${message.channel} message to ${message.contactName || message.to}, but the send failed.`
            : `WL created this ${message.channel} draft for ${message.contactName || message.to}.`,
      detail: `To ${message.contactName ? `${message.contactName} · ` : ''}${message.to}`,
      meta: compact([message.status, message.provider, message.error]),
      related: [
        { label: 'Channel', value: message.channel },
        { label: 'To', value: message.to },
        { label: 'Status', value: message.status },
        ...(message.contactName ? [{ label: 'Contact', value: message.contactName }] : []),
        ...(message.provider ? [{ label: 'Provider', value: message.provider }] : []),
        ...(message.error ? [{ label: 'Error', value: message.error }] : []),
      ],
    });
  }

  for (const reference of references) {
    if (knownReferenceNames.has(reference.name)) continue;
    items.push({
      id: `inventory-${reference.name}`,
      kind: 'inventory',
      title: 'Reference available',
      eyebrow: 'Reference',
      summary: `"${reference.name}" is currently available in the project reference folder. WL does not have a reliable event timestamp for when this file was originally added, so it is shown after timed events.`,
      detail: reference.name,
      meta: fmtSize(reference.size),
      related: [
        { label: 'File', value: reference.name },
        ...(fmtSize(reference.size) ? [{ label: 'Size', value: fmtSize(reference.size)! }] : []),
      ],
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
  const [outbound, setOutbound] = useState<ProjectOutboundMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const hasWorkspace = Boolean(project.workspace);

  const load = useCallback(async () => {
    if (!hasWorkspace) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [referenceResponse, historyResponse, assistantState] = await Promise.all([
        fetch(`/wl-project/reference?id=${encodeURIComponent(project.id)}`, { credentials: 'include' }),
        fetch(`/api/project-email-ingest/history?id=${encodeURIComponent(project.id)}`, { credentials: 'include' }),
        ipcBridge.project.readExecutiveAssistant.invoke({ id: project.id }),
      ]);
      const [nextReferences, nextHistory] = await Promise.all([
        parseReferenceResponse(referenceResponse),
        parseEmailHistoryResponse(historyResponse),
      ]);
      setReferences(nextReferences);
      setEmailHistory(nextHistory);
      setOutbound(assistantState.outbound);
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
    () => buildHistoryItems(project, conversations, emailHistory, references, outbound),
    [project, conversations, emailHistory, references, outbound],
  );

  const visibleItems = useMemo(() => items.filter((item) => itemMatchesFilter(item, filter)), [items, filter]);

  useEffect(() => {
    if (visibleItems.length === 0) {
      if (selectedId) setSelectedId(null);
      return;
    }
    if (!selectedId || !visibleItems.some((item) => item.id === selectedId)) {
      setSelectedId(visibleItems[0].id);
    }
  }, [visibleItems, selectedId]);

  const selected = visibleItems.find((item) => item.id === selectedId) ?? visibleItems[0];

  const stats = useMemo(
    () => ({
      all: items.length,
      chats: conversations.length,
      emails: emailHistory.length,
      references: references.length,
      remotes: emailHistory.reduce((count, record) => count + (record.remoteAttachmentLinks?.length ?? 0), 0),
      outbound: outbound.length,
    }),
    [conversations.length, emailHistory, items.length, references.length, outbound.length],
  );

  const filterOptions: Array<{ key: HistoryFilter; label: string; count: number }> = [
    { key: 'all', label: 'All', count: stats.all },
    { key: 'chat', label: 'chats', count: stats.chats },
    { key: 'email', label: 'emails', count: stats.emails },
    { key: 'reference', label: 'refs', count: stats.references },
    { key: 'remote', label: 'remote', count: stats.remotes },
    { key: 'outbound', label: 'sent/drafts', count: stats.outbound },
  ];

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
          {filterOptions.map((option) => {
            const active = filter === option.key;
            return (
              <button
                key={option.key}
                type='button'
                className='cursor-pointer px-8px py-4px rd-full border border-solid text-11px transition-colors'
                style={{
                  borderColor: active ? 'rgb(var(--primary-6))' : 'var(--color-border-2)',
                  background: active ? 'var(--color-primary-light-1)' : 'var(--color-fill-1)',
                  color: active ? 'rgb(var(--primary-6))' : 'var(--color-text-3)',
                }}
                onClick={() => setFilter(option.key)}
              >
                {option.key === 'all' ? `${option.label} ${option.count}` : `${option.count} ${option.label}`}
              </button>
            );
          })}
        </div>
      </div>

      <div className='grid gap-14px lg:grid-cols-[minmax(0,0.95fr)_minmax(320px,1.05fr)]'>
        <div className={`flex flex-col ${styles.surface}`}>
          {visibleItems.map((item, index) => {
            const active = selected?.id === item.id;
            return (
              <button
                key={item.id}
                type='button'
                className='flex w-full cursor-pointer items-start gap-12px border-none bg-transparent px-14px py-12px text-left transition-colors hover:bg-fill-1'
                style={{
                  borderTop: index === 0 ? undefined : '1px solid var(--color-border-2)',
                  background: active ? 'var(--color-primary-light-1)' : undefined,
                }}
                onClick={() => setSelectedId(item.id)}
              >
                <div
                  className='flex h-32px w-32px shrink-0 items-center justify-center rd-8px'
                  style={{
                    background: active ? 'rgb(var(--primary-6) / 0.14)' : 'var(--color-fill-2)',
                    color: active ? 'rgb(var(--primary-6))' : 'var(--color-text-2)',
                  }}
                >
                  {iconFor(item.kind)}
                </div>
                <div className='min-w-0 flex-1'>
                  <div className='text-10px font-700 uppercase text-t-tertiary'>{item.eyebrow}</div>
                  <div className='mt-1px flex flex-wrap items-center gap-x-8px gap-y-2px'>
                    <span className='text-13px font-600 text-t-primary'>{item.title}</span>
                    <span className='text-11px text-t-tertiary'>{fmtTime(item.time)}</span>
                  </div>
                  {item.detail && <div className='mt-2px truncate text-12px text-t-secondary'>{item.detail}</div>}
                  {item.meta && <div className='mt-2px truncate text-11px text-t-tertiary'>{item.meta}</div>}
                </div>
              </button>
            );
          })}
        </div>

        {selected && (
          <aside className={`flex min-h-320px flex-col gap-14px p-16px ${styles.surface}`} data-wl-history-detail='true'>
            <div className='flex items-start gap-12px'>
              <div className='flex h-36px w-36px shrink-0 items-center justify-center rd-9px bg-fill-2 text-t-secondary'>
                {iconFor(selected.kind)}
              </div>
              <div className='min-w-0 flex-1'>
                <div className='text-10px font-700 uppercase text-t-tertiary'>{selected.eyebrow}</div>
                <h2 className='m-0 mt-2px text-16px font-700 leading-22px text-t-primary'>{selected.title}</h2>
                <div className='mt-3px text-12px text-t-tertiary'>{fmtTime(selected.time)}</div>
              </div>
            </div>

            <div>
              <div className='mb-5px text-12px font-700 text-t-primary'>Summary</div>
              <p className='m-0 text-13px leading-20px text-t-secondary'>{selected.summary}</p>
            </div>

            {selected.related.length > 0 && (
              <div className='flex flex-col gap-7px'>
                <div className='text-12px font-700 text-t-primary'>Related</div>
                {selected.related.map((row) => (
                  <div key={`${row.label}:${row.value}`} className='flex items-start gap-10px text-12px'>
                    <span className='w-96px shrink-0 text-t-tertiary'>{row.label}</span>
                    <span className='min-w-0 flex-1 break-words text-t-secondary'>{row.value}</span>
                  </div>
                ))}
              </div>
            )}

            {selected.target && (
              <div className='mt-auto flex justify-end'>
                <Button type='primary' size='small' icon={<ArrowRight size={13} />} onClick={() => navigate(selected.target!)}>
                  {selected.targetLabel || 'Open'}
                </Button>
              </div>
            )}
          </aside>
        )}
      </div>

      {visibleItems.length === 0 && (
        <div className='rd-8px border border-dashed border-2 px-14px py-16px text-center text-12px text-t-tertiary'>
          No history events match this filter yet.
        </div>
      )}

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

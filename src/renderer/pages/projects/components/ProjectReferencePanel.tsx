/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { Button, Message } from '@arco-design/web-react';
import { Ban, DownloadCloud, ExternalLink, FileText, FolderOpen, Paperclip, X } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWorkspaceDragImport } from '@/renderer/pages/conversation/Workspace/hooks/useWorkspaceDragImport';
import styles from './projectCards.module.css';

type ReferenceFile = { name: string; path: string; size: number };
type RemoteAttachmentLink = {
  url: string;
  label?: string;
  filename?: string;
  size?: string;
  status?: 'pending' | 'saved' | 'failed' | 'ignored';
  savedReferenceFile?: string;
  lastError?: string;
};
type EmailIngestRecord = {
  id: string;
  subject: string;
  from: string;
  receivedAt: number;
  remoteAttachmentLinks?: RemoteAttachmentLink[];
};

const fmtSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

async function parseReferenceResponse(response: Response, fallbackMessage: string): Promise<ReferenceFile[]> {
  const json = await response.json().catch((): null => null);
  if (!response.ok || json?.ok === false) throw new Error(json?.error || fallbackMessage);
  return Array.isArray(json?.files) ? json.files : [];
}

async function parseEmailHistoryResponse(response: Response): Promise<EmailIngestRecord[]> {
  const json = await response.json().catch((): null => null);
  if (!response.ok || json?.ok === false) throw new Error(json?.error || 'project-email-history-load-failed');
  return Array.isArray(json?.history) ? json.history : [];
}

/**
 * Reference files as their own tab: material the AI can draw on (specs, brand
 * docs, data). Dropped into `.wayland/reference/`, available to chats in the
 * project. A grid of cards plus a drop zone - no other concerns mixed in.
 */
const ProjectReferencePanel: React.FC<{
  projectId: string;
  hasWorkspace: boolean;
  onSetWorkspace: () => void;
}> = ({ projectId, hasWorkspace, onSetWorkspace }) => {
  const { t } = useTranslation();
  const [refs, setRefs] = useState<ReferenceFile[]>([]);
  const [emailHistory, setEmailHistory] = useState<EmailIngestRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [importingKey, setImportingKey] = useState<string | null>(null);
  const [ignoringKey, setIgnoringKey] = useState<string | null>(null);

  const visibleRefs = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return refs;
    return refs.filter((file) => file.name.toLowerCase().includes(needle));
  }, [refs, query]);

  const remoteAttachments = useMemo(
    () =>
      emailHistory.flatMap((record) =>
        (record.remoteAttachmentLinks ?? [])
          .filter((link) => link.status !== 'ignored')
          .map((link) => ({
          url: link.url,
          label: link.label,
          filename: link.filename,
          size: link.size,
          status: link.status,
          savedReferenceFile: link.savedReferenceFile,
          lastError: link.lastError,
          ingestId: record.id,
          subject: record.subject,
          from: record.from,
          receivedAt: record.receivedAt,
        }))
      ),
    [emailHistory]
  );

  const load = useCallback(async () => {
    if (!hasWorkspace) {
      setLoading(false);
      return;
    }
    try {
      const response = await fetch(`/wl-project/reference?id=${encodeURIComponent(projectId)}`, {
        credentials: 'include',
      });
      setRefs(await parseReferenceResponse(response, 'wl-reference-list-failed'));
      const historyResponse = await fetch(`/api/project-email-ingest/history?id=${encodeURIComponent(projectId)}`, {
        credentials: 'include',
      });
      setEmailHistory(await parseEmailHistoryResponse(historyResponse));
    } catch (err) {
      console.error('[ProjectReferencePanel] load failed:', err);
    } finally {
      setLoading(false);
    }
  }, [projectId, hasWorkspace]);

  useEffect(() => {
    void load();
  }, [load]);

  const onFilesDropped = useCallback(
    async (files: Array<{ path: string; name: string }>) => {
      try {
        const response = await fetch('/wl-project/reference/add', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            id: projectId,
            filePaths: files.map((f) => f.path).filter(Boolean),
          }),
        });
        setRefs(await parseReferenceResponse(response, 'wl-reference-add-failed'));
        Message.success(t('projects.knowledge.fileAdded', { count: files.length }));
      } catch (err) {
        console.error('[ProjectReferencePanel] add failed:', err);
        Message.error(t('projects.knowledge.fileAddFailed'));
      }
    },
    [projectId, t]
  );

  const { isDragging, dragHandlers } = useWorkspaceDragImport({
    onFilesDropped,
    messageApi: Message,
    t,
    conversationId: `project-reference-${projectId}`,
  });

  const browse = useCallback(async () => {
    const paths = await ipcBridge.dialog.showOpen.invoke({ properties: ['openFile', 'multiSelections'] });
    if (paths && paths.length > 0) await onFilesDropped(paths.map((p) => ({ path: p, name: p })));
  }, [onFilesDropped]);

  const removeRef = useCallback(
    async (name: string) => {
      try {
        const response = await fetch('/wl-project/reference/remove', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ id: projectId, name }),
        });
        setRefs(await parseReferenceResponse(response, 'wl-reference-remove-failed'));
      } catch (err) {
        console.error('[ProjectReferencePanel] remove failed:', err);
        Message.error(t('projects.knowledge.fileRemoveFailed'));
      }
    },
    [projectId, t]
  );

  const importRemoteAttachment = useCallback(
    async (ingestId: string, url: string) => {
      const key = `${ingestId}:${url}`;
      setImportingKey(key);
      try {
        const response = await fetch('/api/project-email-ingest/remote-import', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ id: projectId, ingestId, url }),
        });
        const result = await response.json().catch((): null => null);
        if (!response.ok || result?.ok === false) throw new Error(result?.error || 'remote-attachment-import-failed');
        Message.success(`Imported ${result.file}`);
        await load();
      } catch (err) {
        console.error('[ProjectReferencePanel] remote import failed:', err);
        Message.error('Remote attachment import failed');
      } finally {
        setImportingKey(null);
      }
    },
    [load, projectId]
  );

  const ignoreRemoteAttachment = useCallback(
    async (ingestId: string, url: string) => {
      const key = `${ingestId}:${url}`;
      setIgnoringKey(key);
      try {
        const response = await fetch('/api/project-email-ingest/remote-ignore', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ id: projectId, ingestId, url }),
        });
        const result = await response.json().catch((): null => null);
        if (!response.ok || result?.ok === false) throw new Error(result?.error || 'remote-attachment-ignore-failed');
        Message.success('Remote attachment excluded');
        await load();
      } catch (err) {
        console.error('[ProjectReferencePanel] remote ignore failed:', err);
        Message.error('Remote attachment exclude failed');
      } finally {
        setIgnoringKey(null);
      }
    },
    [load, projectId]
  );

  if (!hasWorkspace) {
    return (
      <div className='flex flex-col items-center justify-center gap-12px text-center px-20px py-48px'>
        <div className='flex items-center justify-center w-48px h-48px rd-12px bg-fill-1 text-t-tertiary'>
          <FolderOpen size={22} />
        </div>
        <div className='text-14px font-600 text-t-primary'>{t('projects.knowledge.noWorkspaceTitle')}</div>
        <div className='text-12px text-t-secondary max-w-320px leading-relaxed'>
          {t('projects.knowledge.noWorkspaceBody')}
        </div>
        <Button type='outline' onClick={onSetWorkspace}>
          {t('projects.knowledge.setWorkspace')}
        </Button>
      </div>
    );
  }

  if (loading) return null;

  return (
    <div className='flex flex-col gap-16px max-w-820px mx-auto'>
      <div className='flex items-center justify-between'>
        <div className='flex flex-col gap-2px'>
          <div className='text-15px font-700 text-t-primary'>{t('projects.reference.title')}</div>
          <div className='text-12px text-t-tertiary leading-relaxed'>{t('projects.reference.subtitle')}</div>
        </div>
        <Button size='small' type='outline' icon={<Paperclip size={13} />} onClick={() => void browse()}>
          {t('projects.knowledge.reference.add')}
        </Button>
      </div>

      {refs.length > 0 && (
        <input
          data-wl-reference-search='true'
          type='search'
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder='Search reference files'
          className='w-full px-12px py-9px rd-8px text-13px bg-fill-1 text-t-primary'
          style={{ border: '1px solid var(--color-border-2)', outline: 'none' }}
        />
      )}

      {remoteAttachments.length > 0 && (
        <div className='flex flex-col gap-10px rd-8px px-14px py-13px bg-fill-1'>
          <div className='flex items-center justify-between gap-12px'>
            <div className='flex flex-col gap-2px'>
              <div className='text-13px font-700 text-t-primary'>Remote attachments</div>
              <div className='text-11px text-t-tertiary'>Mail Drop and other links captured from project email.</div>
            </div>
          </div>
          <div className='flex flex-col gap-8px'>
            {remoteAttachments.map((item) => {
              const key = `${item.ingestId}:${item.url}`;
              const title = item.filename || item.label || 'Remote attachment';
              const imported = item.status === 'saved' && item.savedReferenceFile;
              return (
                <div
                  key={key}
                  className='flex items-center justify-between gap-12px px-10px py-9px rd-8px bg-bg-1'
                  style={{ border: '1px solid var(--color-border-2)' }}
                >
                  <div className='min-w-0 flex flex-col gap-2px'>
                    <div className='text-12.5px font-600 text-t-primary truncate' title={title}>
                      {title}
                    </div>
                    <div className='text-11px text-t-tertiary truncate' title={item.subject}>
                      {item.size ? `${item.size} · ` : ''}
                      {imported ? `Imported as ${item.savedReferenceFile}` : item.subject}
                    </div>
                    {item.status === 'failed' && item.lastError && (
                      <div className='text-11px text-danger-6 truncate' title={item.lastError}>
                        {item.lastError}
                      </div>
                    )}
                  </div>
                  <div className='flex items-center gap-6px shrink-0'>
                    <Button
                      size='mini'
                      type='text'
                      icon={<ExternalLink size={12} />}
                      style={{
                        border: '1px solid var(--color-border-3)',
                        background: 'var(--color-fill-2)',
                        color: 'var(--color-text-1)',
                      }}
                      onClick={() => window.open(item.url, '_blank', 'noopener,noreferrer')}
                    />
                    {!imported && (
                      <Button
                        size='mini'
                        type='outline'
                        icon={<Ban size={12} />}
                        loading={ignoringKey === key}
                        style={{
                          borderColor: 'var(--color-warning-6)',
                          color: 'var(--color-warning-7)',
                          background: 'var(--color-bg-1)',
                        }}
                        onClick={() => void ignoreRemoteAttachment(item.ingestId, item.url)}
                      >
                        Exclude
                      </Button>
                    )}
                    <Button
                      size='mini'
                      type={imported ? 'secondary' : 'outline'}
                      icon={<DownloadCloud size={12} />}
                      loading={importingKey === key}
                      disabled={Boolean(imported)}
                      style={
                        imported
                          ? undefined
                          : {
                              borderColor: 'var(--color-primary-6)',
                              color: 'var(--color-primary-7)',
                              background: 'var(--color-primary-light-1)',
                            }
                      }
                      onClick={() => void importRemoteAttachment(item.ingestId, item.url)}
                    >
                      {imported ? 'Imported' : item.status === 'failed' ? 'Retry' : 'Import'}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {refs.length > 0 && visibleRefs.length === 0 && (
        <div
          data-wl-reference-search-empty='true'
          className='rd-8px border border-dashed border-2 px-14px py-18px text-12px text-t-tertiary text-center'
        >
          No matching reference files
        </div>
      )}

      {visibleRefs.length > 0 && (
        <div className='grid gap-12px' style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}>
          {visibleRefs.map((f) => (
            <div
              key={f.name}
              data-wl-reference-card='true'
              data-wl-reference-name={f.name}
              tabIndex={0}
              className={`group flex flex-col gap-8px px-14px py-13px ${styles.card}`}
            >
              <div className='flex items-start justify-between'>
                <div className='flex items-center justify-center w-32px h-32px rd-8px bg-fill-2 text-t-secondary'>
                  <FileText size={16} />
                </div>
                <button
                  type='button'
                  aria-label={t('projects.knowledge.reference.remove')}
                  className='flex items-center justify-center w-18px h-18px rd-4px bg-transparent border-none cursor-pointer text-t-tertiary opacity-0 group-hover:opacity-100 transition-opacity hover:text-t-primary'
                  onClick={() => void removeRef(f.name)}
                >
                  <X size={13} />
                </button>
              </div>
              <div className='text-12.5px font-500 text-t-primary break-words leading-snug' title={f.name}>
                {f.name}
              </div>
              <div className='text-11px text-t-tertiary'>{fmtSize(f.size)}</div>
            </div>
          ))}
        </div>
      )}

      <div
        {...dragHandlers}
        data-wl-reference-dropzone='true'
        className='flex flex-col items-center justify-center gap-8px rd-12px px-16px py-28px text-center transition-colors cursor-pointer'
        style={{
          border: `1.5px dashed ${isDragging ? 'var(--color-primary-6)' : 'var(--color-border-2)'}`,
          background: isDragging ? 'var(--color-primary-light-1)' : 'transparent',
        }}
        onClick={() => void browse()}
      >
        <Paperclip size={20} className='text-t-tertiary' />
        <div className='text-12px text-t-secondary font-500'>{t('projects.reference.dropTitle')}</div>
        <div className='text-11px text-t-tertiary'>{t('projects.reference.dropHint')}</div>
      </div>
    </div>
  );
};

export default ProjectReferencePanel;

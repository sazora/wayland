/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { IProject } from '@/common/types/project';
import TipTapMarkdownEditor from '@/renderer/pages/conversation/Preview/components/editors/TipTapMarkdownEditor';
import { Button, Drawer, Input, Message, Select, Switch, Tag } from '@arco-design/web-react';
import { FolderOpen, Inbox, Settings as SettingsIcon, Sparkles, X } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import KnowledgeWizard, { type WizardKind } from './KnowledgeWizard';

const PROJECT_COLORS = ['#FF6A00', '#3B82F6', '#10B981', '#8B5CF6', '#EC4899', '#F59E0B'];

export type SettingsSection = 'general' | 'context' | 'rules' | 'email';

type ProjectEmailIngestHistoryItem = {
  id: string;
  from: string;
  subject: string;
  receivedAt: number;
  status: 'saved' | 'rejected' | 'failed';
  reason?: string;
  referenceFiles: string[];
  attachmentCount: number;
};

const EMAIL_DOMAIN = 'wl.cksz.us';

function normalizeAlias(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(new RegExp(`@${EMAIL_DOMAIN.replace('.', '\\.')}$`, 'i'), '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function parseSenderList(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[,\n;\s]+/)
        .map((sender) => sender.trim().toLowerCase())
        .filter(Boolean)
    )
  );
}

/**
 * Project settings as a full-height right drawer. Instructions and Rules are
 * first-class sections here (not a buried modal) because they are injected into
 * every chat - the whole point is to make writing them feel inevitable, with an
 * AI wizard one click away. Opening section is chosen by the caller (the header
 * "Setup" affordance opens on Instructions).
 */
const ProjectSettingsDrawer: React.FC<{
  visible: boolean;
  project: IProject;
  initialSection?: SettingsSection;
  canGenerate: boolean;
  onClose: () => void;
  onSaved: () => void;
}> = ({ visible, project, initialSection = 'context', canGenerate, onClose, onSaved }) => {
  const { t } = useTranslation();
  const [section, setSection] = useState<SettingsSection>(initialSection);

  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description || '');
  const [workspace, setWorkspace] = useState(project.workspace || '');
  const [iconColor, setIconColor] = useState(project.iconColor || PROJECT_COLORS[0]);
  const [emailIntakeEnabled, setEmailIntakeEnabled] = useState(Boolean(project.emailIntakeEnabled));
  const [emailAlias, setEmailAlias] = useState(project.emailAlias || '');
  const [emailAllowedSenders, setEmailAllowedSenders] = useState((project.emailAllowedSenders || []).join('\n'));
  const [emailIngestBehavior, setEmailIngestBehavior] = useState(project.emailIngestBehavior || 'save');
  const [emailHistory, setEmailHistory] = useState<ProjectEmailIngestHistoryItem[]>([]);

  const [contextBody, setContextBody] = useState('');
  const [rulesBody, setRulesBody] = useState('');
  const [decisionsBody, setDecisionsBody] = useState('');
  const [editorKey, setEditorKey] = useState(0); // bump to remount TipTap with new value
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [wizard, setWizard] = useState<WizardKind | null>(null);

  useEffect(() => {
    if (!visible) return;
    setSection(initialSection);
    setName(project.name);
    setDescription(project.description || '');
    setWorkspace(project.workspace || '');
    setIconColor(project.iconColor || PROJECT_COLORS[0]);
    setEmailIntakeEnabled(Boolean(project.emailIntakeEnabled));
    setEmailAlias(project.emailAlias || '');
    setEmailAllowedSenders((project.emailAllowedSenders || []).join('\n'));
    setEmailIngestBehavior(project.emailIngestBehavior || 'save');
    setEmailHistory([]);
    setLoading(true);
    void (async () => {
      try {
        const [k, history] = await Promise.all([
          ipcBridge.project.readKnowledge.invoke({ id: project.id }),
          ipcBridge.project.readEmailIngestHistory.invoke({ id: project.id }),
        ]);
        setContextBody(k.context || '');
        setRulesBody(k.rules || '');
        setDecisionsBody(k.decisions || '');
        setEmailHistory(history);
        setEditorKey((n) => n + 1);
      } catch (err) {
        console.error('[ProjectSettingsDrawer] load failed:', err);
      } finally {
        setLoading(false);
      }
    })();
  }, [visible, project, initialSection]);

  const chooseFolder = useCallback(() => {
    ipcBridge.dialog.showOpen
      .invoke({ properties: ['openDirectory', 'createDirectory'] })
      .then((dirs) => {
        if (dirs && dirs[0]) setWorkspace(dirs[0]);
      })
      .catch((err) => console.error('Folder dialog failed:', err));
  }, []);

  const save = useCallback(async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const updates = {
        name: name.trim(),
        description: description.trim() || undefined,
        workspace: workspace.trim() || undefined,
        iconColor,
        emailIntakeEnabled,
        emailAlias: normalizeAlias(emailAlias),
        emailAllowedSenders: parseSenderList(emailAllowedSenders),
        emailIngestBehavior,
      };
      const saveNative = async () => {
        await ipcBridge.project.update.invoke({ id: project.id, updates });
        // Knowledge docs only persist when there is a workspace to write into.
        if (workspace.trim()) {
          await ipcBridge.project.writeKnowledge.invoke({ id: project.id, kind: 'context', content: contextBody });
          await ipcBridge.project.writeKnowledge.invoke({ id: project.id, kind: 'rules', content: rulesBody });
        }
      };

      const response = await fetch('/wl-project/settings/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          id: project.id,
          updates,
          knowledge: {
            context: contextBody,
            rules: rulesBody,
          },
        }),
      });
      if (!response.ok) {
        const contentType = response.headers.get('content-type') || '';
        if (response.status === 404 && contentType.includes('text/html')) {
          await saveNative();
          Message.success(t('projects.settings.saved'));
          onSaved();
          onClose();
          return;
        }
        const error = contentType.includes('application/json') ? await response.json().catch((): null => null) : null;
        throw new Error(error?.error || 'wl-project-settings-save-failed');
      }
      const saved = await response.json().catch((): null => null);
      if (!saved?.ok) {
        await saveNative();
      }
      Message.success(t('projects.settings.saved'));
      onSaved();
      onClose();
    } catch {
      Message.error(t('projects.settings.saveFailed'));
    } finally {
      setSaving(false);
    }
  }, [
    name,
    description,
    workspace,
    iconColor,
    emailIntakeEnabled,
    emailAlias,
    emailAllowedSenders,
    emailIngestBehavior,
    contextBody,
    rulesBody,
    project.id,
    onSaved,
    onClose,
    t,
  ]);

  const addAllowedSenderBreak = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!(event.key === 'Enter' || event.key === ',' || event.key === ';')) return;
    event.preventDefault();
    event.stopPropagation();
    setEmailAllowedSenders((current) => {
      const trimmed = current.replace(/[,\s;]+$/g, '');
      return trimmed ? `${trimmed}\n` : '';
    });
  }, []);

  const acceptDraft = (kind: WizardKind, draft: string) => {
    if (kind === 'context') setContextBody(draft);
    else setRulesBody(draft);
    setEditorKey((n) => n + 1); // remount the editor so the draft shows
  };

  const hasInstructions = contextBody.replace(/^#.*$/gm, '').replace(/^>.*$/gm, '').trim().length > 0;

  const SECTIONS: Array<{ key: SettingsSection; label: string }> = [
    { key: 'general', label: t('projects.settings.general') },
    { key: 'context', label: t('projects.knowledge.context.label') },
    { key: 'rules', label: t('projects.knowledge.rules.label') },
    { key: 'email', label: t('projects.settings.email.title') },
  ];

  return (
    <Drawer
      width={Math.min(620, typeof window !== 'undefined' ? window.innerWidth - 80 : 620)}
      visible={visible}
      onCancel={onClose}
      maskClosable
      title={
        <span className='flex items-center gap-8px'>
          <SettingsIcon size={16} />
          {t('projects.settings.title')}
        </span>
      }
      footer={
        <div className='flex items-center justify-between gap-8px'>
          <span className='text-11px text-t-tertiary'>
            {hasInstructions ? t('projects.settings.readyDone') : t('projects.settings.readyTodo')}
          </span>
          <div className='flex items-center gap-8px'>
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button type='primary' loading={saving} disabled={!name.trim()} onClick={() => void save()}>
              {t('common.save')}
            </Button>
          </div>
        </div>
      }
    >
      {/* Section nav */}
      <div className='flex items-center gap-2px mb-16px' style={{ borderBottom: '1px solid var(--color-border-2)' }}>
        {SECTIONS.map((s) => {
          const active = section === s.key;
          return (
            <button
              key={s.key}
              type='button'
              onClick={() => setSection(s.key)}
              className='px-12px py-9px bg-transparent border-none cursor-pointer text-13px transition-colors'
              style={{
                color: active ? 'var(--color-text-1)' : 'var(--color-text-3)',
                fontWeight: active ? 600 : 400,
                borderBottom: `2px solid ${active ? 'var(--color-primary-6)' : 'transparent'}`,
                marginBottom: -1,
              }}
            >
              {s.label}
            </button>
          );
        })}
      </div>

      {loading ? null : (
        <>
          {section === 'general' && (
            <div className='flex flex-col gap-16px'>
              <div className='flex flex-col gap-6px'>
                <span className='text-13px font-500 text-t-secondary'>{t('projects.modal.nameLabel')}</span>
                <Input value={name} onChange={setName} maxLength={80} showWordLimit />
              </div>
              <div className='flex flex-col gap-6px'>
                <span className='text-13px font-500 text-t-secondary'>{t('projects.modal.descriptionLabel')}</span>
                <Input.TextArea
                  value={description}
                  onChange={setDescription}
                  autoSize={{ minRows: 2, maxRows: 4 }}
                  maxLength={400}
                />
              </div>
              <div className='flex flex-col gap-6px'>
                <span className='text-13px font-500 text-t-secondary'>{t('projects.modal.workspaceLabel')}</span>
                {workspace ? (
                  <div className='flex items-center gap-8px bg-fill-1 rd-8px px-12px py-8px border border-solid border-2'>
                    <FolderOpen size={14} className='flex-shrink-0 text-t-secondary' />
                    <span className='text-13px truncate flex-1' title={workspace}>
                      {workspace}
                    </span>
                    <Button type='text' size='mini' icon={<X size={14} />} onClick={() => setWorkspace('')} />
                  </div>
                ) : (
                  <Button size='small' shape='round' onClick={chooseFolder}>
                    <span className='flex items-center gap-6px'>
                      <FolderOpen size={14} />
                      {t('projects.modal.chooseFolder')}
                    </span>
                  </Button>
                )}
                <span className='text-11px text-t-tertiary leading-4'>{t('projects.modal.workspaceHint')}</span>
              </div>
              <div className='flex flex-col gap-6px'>
                <span className='text-13px font-500 text-t-secondary'>{t('projects.modal.colorLabel')}</span>
                <div className='flex items-center gap-8px'>
                  {PROJECT_COLORS.map((c) => (
                    <button
                      key={c}
                      type='button'
                      onClick={() => setIconColor(c)}
                      aria-label={c}
                      className='flex items-center justify-center w-28px h-28px rd-full border-2 border-solid cursor-pointer bg-transparent p-0 transition-colors'
                      style={{ borderColor: iconColor === c ? 'var(--color-text-1)' : 'transparent' }}
                    >
                      <span className='block w-18px h-18px rd-full' style={{ background: c }} />
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {section === 'email' && (
            <div className='flex flex-col gap-18px'>
              <div className='flex items-start justify-between gap-12px rd-8px border border-solid border-2 p-14px'>
                <div className='flex flex-col gap-4px'>
                  <span className='text-13px font-600 text-t-primary flex items-center gap-6px'>
                    <Inbox size={14} />
                    {t('projects.settings.email.enableLabel')}
                  </span>
                  <span className='text-12px text-t-tertiary leading-5'>{t('projects.settings.email.enableHint')}</span>
                </div>
                <Switch checked={emailIntakeEnabled} onChange={setEmailIntakeEnabled} />
              </div>

              <div className='flex flex-col gap-6px'>
                <span className='text-13px font-500 text-t-secondary'>{t('projects.settings.email.aliasLabel')}</span>
                <Input
                  value={emailAlias}
                  onChange={(value) => setEmailAlias(normalizeAlias(value))}
                  maxLength={64}
                  addAfter={`@${EMAIL_DOMAIN}`}
                  disabled={!emailIntakeEnabled}
                />
                <span className='text-11px text-t-tertiary leading-4'>{t('projects.settings.email.aliasHint')}</span>
              </div>

              <div className='flex flex-col gap-6px'>
                <span className='text-13px font-500 text-t-secondary'>{t('projects.settings.email.allowedLabel')}</span>
                <Input.TextArea
                  value={emailAllowedSenders}
                  onChange={setEmailAllowedSenders}
                  onKeyDown={addAllowedSenderBreak}
                  disabled={!emailIntakeEnabled}
                  autoSize={{ minRows: 3, maxRows: 6 }}
                  placeholder={t('projects.settings.email.allowedPlaceholder')}
                />
                <span className='text-11px text-t-tertiary leading-4'>{t('projects.settings.email.allowedHint')}</span>
              </div>

              <div className='flex flex-col gap-6px'>
                <span className='text-13px font-500 text-t-secondary'>{t('projects.settings.email.behaviorLabel')}</span>
                <Select value={emailIngestBehavior} onChange={setEmailIngestBehavior} disabled={!emailIntakeEnabled}>
                  <Select.Option value='save'>{t('projects.settings.email.behaviorSave')}</Select.Option>
                  <Select.Option value='save-and-notify'>{t('projects.settings.email.behaviorNotify')}</Select.Option>
                  <Select.Option value='save-and-summarize'>{t('projects.settings.email.behaviorSummarize')}</Select.Option>
                  <Select.Option value='save-add-to-knowledge'>{t('projects.settings.email.behaviorKnowledge')}</Select.Option>
                  <Select.Option value='act-on-instructions'>{t('projects.settings.email.behaviorAct')}</Select.Option>
                  <Select.Option value='act-add-knowledge-and-references'>
                    {t('projects.settings.email.behaviorActKnowledgeReferences')}
                  </Select.Option>
                </Select>
              </div>

              <div className='flex flex-col gap-8px'>
                <div className='flex items-center justify-between gap-8px'>
                  <span className='text-13px font-500 text-t-secondary'>{t('projects.settings.email.historyLabel')}</span>
                  <span className='text-11px text-t-tertiary'>{t('projects.settings.email.historyCount', { count: emailHistory.length })}</span>
                </div>
                {emailHistory.length === 0 ? (
                  <div className='rd-8px border border-dashed border-2 px-14px py-18px text-12px text-t-tertiary text-center'>
                    {t('projects.settings.email.historyEmpty')}
                  </div>
                ) : (
                  <div className='flex flex-col gap-8px'>
                    {emailHistory.slice(0, 8).map((item) => (
                      <div key={item.id} className='rd-8px border border-solid border-2 p-10px flex flex-col gap-6px'>
                        <div className='flex items-center justify-between gap-8px'>
                          <span className='text-13px font-500 truncate' title={item.subject}>
                            {item.subject}
                          </span>
                          <Tag color={item.status === 'saved' ? 'green' : item.status === 'failed' ? 'red' : 'orange'}>
                            {t(`projects.settings.email.status.${item.status}`)}
                          </Tag>
                        </div>
                        <div className='text-11px text-t-tertiary truncate'>
                          {item.from || t('projects.settings.email.unknownSender')} ·{' '}
                          {new Date(item.receivedAt).toLocaleString()} ·{' '}
                          {t('projects.settings.email.filesSaved', { count: item.referenceFiles.length })}
                        </div>
                        {item.reason && <div className='text-11px text-status-danger'>{item.reason}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {(section === 'context' || section === 'rules') &&
            (() => {
              const isContext = section === 'context';
              const body = isContext ? contextBody : rulesBody;
              const setBody = isContext ? setContextBody : setRulesBody;
              const noWorkspace = !workspace.trim();
              return (
                <div className='flex flex-col gap-10px'>
                  <div className='flex items-center justify-between gap-8px'>
                    <span className='text-12px text-t-tertiary'>
                      {isContext ? t('projects.settings.instructionsHint') : t('projects.settings.rulesHint')}
                    </span>
                    <Button
                      size='small'
                      type='outline'
                      icon={<Sparkles size={13} />}
                      disabled={!canGenerate}
                      onClick={() => setWizard(section)}
                    >
                      {t('projects.settings.helpWrite')}
                    </Button>
                  </div>
                  {!canGenerate && (
                    <span className='text-11px text-t-tertiary'>{t('projects.knowledge.noModelHint')}</span>
                  )}
                  {noWorkspace ? (
                    <div className='rd-10px border border-dashed border-2 px-16px py-20px text-center text-12px text-t-tertiary leading-relaxed'>
                      {t('projects.settings.needWorkspace')}
                    </div>
                  ) : (
                    <div className='rd-8px border border-solid border-2 min-h-300px overflow-auto'>
                      <TipTapMarkdownEditor key={`${section}-${editorKey}`} value={body} onChange={setBody} />
                    </div>
                  )}
                </div>
              );
            })()}
        </>
      )}

      {wizard && (
        <KnowledgeWizard
          visible={!!wizard}
          kind={wizard}
          projectName={name}
          projectDescription={description}
          // Rules are drafted from the project's intent: feed the current
          // instructions and decisions so the rules stay consistent with them.
          relatedKnowledge={
            wizard === 'rules'
              ? [contextBody.trim(), decisionsBody.trim()].filter(Boolean).join('\n\n')
              : undefined
          }
          onClose={() => setWizard(null)}
          onAccept={(draft) => acceptDraft(wizard, draft)}
        />
      )}
    </Drawer>
  );
};

export default ProjectSettingsDrawer;

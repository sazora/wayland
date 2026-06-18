/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { TChatConversation } from '@/common/config/storage';
import type { IProject } from '@/common/types/project';
import { Button, Message } from '@arco-design/web-react';
import {
  CalendarClock,
  CheckCircle2,
  FolderOpen,
  History,
  MessageSquare,
  MessageSquarePlus,
  NotebookPen,
  Paperclip,
  Settings,
  TriangleAlert,
} from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { isConversationPinned } from '@/renderer/pages/conversation/GroupedHistory/utils/groupingHelpers';
import { useAllCronJobs } from '@/renderer/pages/cron/useCronJobs';
import type { SettingsSection } from './ProjectSettingsDrawer';
import styles from './projectCards.module.css';

type ProjectTab = 'overview' | 'chats' | 'reports' | 'files' | 'reference' | 'memory' | 'history';

type Props = {
  project: IProject;
  projectId: string;
  conversations: TChatConversation[];
  setupReady: boolean;
  canGenerate: boolean;
  onNewChat: () => void;
  onOpenSettings: (section: SettingsSection) => void;
  onSelectTab: (tab: ProjectTab) => void;
};

type ProjectKnowledge = {
  context?: string;
  rules?: string;
  decisions?: string;
};

function countReferenceFiles(refs: unknown): number {
  if (Array.isArray(refs)) return refs.length;
  if (refs && typeof refs === 'object' && Array.isArray((refs as { files?: unknown }).files)) {
    return ((refs as { files: unknown[] }).files).length;
  }
  return 0;
}

function relTime(ms?: number): string {
  if (!ms) return 'Never';
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'Just now';
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function countDecisionLines(decisions?: string): number {
  if (!decisions) return 0;
  return decisions
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+\S/.test(line) || /^\d+\.\s+\S/.test(line))
    .length;
}

function jobMatchesProject(job: ReturnType<typeof useAllCronJobs>['jobs'][number], project: IProject): boolean {
  const haystack = [
    job.name,
    job.description,
    job.target.payload.text,
    job.metadata.conversationTitle,
    job.metadata.agentConfig?.workspace,
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  return [project.id, project.name, project.workspace].filter(Boolean).some((token) => haystack.includes(String(token).toLowerCase()));
}

const Metric: React.FC<{ label: string; value: string | number; hint?: string; icon: React.ReactNode }> = ({
  label,
  value,
  hint,
  icon,
}) => (
  <div className={`flex items-start gap-12px px-14px py-13px ${styles.surface} ${styles.cockpitMetric}`}>
    <div className='flex items-center justify-center w-32px h-32px rd-8px bg-fill-2 text-t-secondary'>{icon}</div>
    <div className='min-w-0 flex-1'>
      <div className='text-20px leading-24px font-700 text-t-primary'>{value}</div>
      <div className='text-12px font-600 text-t-secondary'>{label}</div>
      {hint && <div className='mt-2px text-11px text-t-tertiary truncate'>{hint}</div>}
    </div>
  </div>
);

const ChecklistItem: React.FC<{ ok: boolean; label: string; action?: React.ReactNode }> = ({ ok, label, action }) => (
  <div className='flex items-center gap-10px py-8px'>
    {ok ? <CheckCircle2 size={16} className='text-success-6 shrink-0' /> : <TriangleAlert size={16} className='text-warning-6 shrink-0' />}
    <span className='flex-1 min-w-0 text-13px text-t-primary'>{label}</span>
    {action}
  </div>
);

const ProjectCockpitPanel: React.FC<Props> = ({
  project,
  projectId,
  conversations,
  setupReady,
  canGenerate,
  onNewChat,
  onOpenSettings,
  onSelectTab,
}) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { jobs } = useAllCronJobs();
  const [referenceCount, setReferenceCount] = useState(0);
  const [knowledge, setKnowledge] = useState<ProjectKnowledge | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      fetch(`/wl-project/reference?id=${encodeURIComponent(projectId)}`)
        .then(async (r): Promise<unknown> => (r.ok ? r.json() : []))
        .then((refs) => {
          if (!cancelled) setReferenceCount(countReferenceFiles(refs));
        })
        .catch((err) => {
          if (!cancelled) console.warn('[ProjectCockpitPanel] reference count load failed:', err);
        });

      ipcBridge.project.readKnowledge
        .invoke({ id: projectId })
        .then((nextKnowledge) => {
          if (!cancelled) setKnowledge(nextKnowledge);
        })
        .catch((err) => {
          if (!cancelled) console.warn('[ProjectCockpitPanel] knowledge metrics load failed:', err);
        });
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const projectJobs = useMemo(() => jobs.filter((job) => jobMatchesProject(job, project)), [jobs, project]);
  const recent = useMemo(
    () =>
      conversations
        .toSorted((a, b) => {
          const pa = (a.extra as { pinnedAt?: number } | undefined)?.pinnedAt ?? 0;
          const pb = (b.extra as { pinnedAt?: number } | undefined)?.pinnedAt ?? 0;
          const ma = a.modifyTime ?? a.createTime ?? 0;
          const mb = b.modifyTime ?? b.createTime ?? 0;
          return pb - pa || mb - ma;
        })
        .slice(0, 4),
    [conversations],
  );
  const pinned = conversations.filter(isConversationPinned).length;
  const decisionCount = countDecisionLines(knowledge?.decisions);
  const activeJobs = projectJobs.filter((job) => job.enabled).length;

  const reportPrompt = encodeURIComponent(
    [
      `Create a recurring project report for ${project.name}.`,
      project.workspace ? `Workspace: ${project.workspace}` : '',
      'Summarize new chats, decisions, reference changes, open questions, risks, and recommended next actions.',
      'Mention this project id for filtering:',
      project.id,
    ]
      .filter(Boolean)
      .join('\n'),
  );

  return (
    <div className={`mx-auto flex max-w-1180px flex-col gap-16px ${styles.cockpit}`}>
      <div className={`grid gap-12px md:grid-cols-4 ${styles.cockpitMetrics}`}>
        <Metric label={t('projects.cockpit.metricChats', 'Chats')} value={conversations.length} hint={`${pinned} pinned`} icon={<MessageSquare size={17} />} />
        <Metric label={t('projects.cockpit.metricReference', 'References')} value={referenceCount} icon={<Paperclip size={17} />} />
        <Metric label={t('projects.cockpit.metricDecisions', 'Decisions')} value={decisionCount} icon={<NotebookPen size={17} />} />
        <Metric label={t('projects.cockpit.metricReports', 'Reports')} value={projectJobs.length} hint={`${activeJobs} active`} icon={<CalendarClock size={17} />} />
      </div>

      <div className='grid gap-14px lg:grid-cols-[1.2fr_0.8fr]'>
        <section className={`p-16px ${styles.surface}`}>
          <div className={`mb-12px flex items-center justify-between gap-12px ${styles.cockpitSectionHeader}`}>
            <div className={styles.cockpitSectionTitle}>
              <h2 className='m-0 text-15px font-700 text-t-primary'>{t('projects.cockpit.recentTitle', 'Recent project work')}</h2>
              <p className='m-0 mt-2px text-12px text-t-secondary'>
                {t('projects.cockpit.recentBody', 'Pinned and recently touched chats stay visible here.')}
              </p>
            </div>
            <Button
              type='primary'
              size='small'
              className={styles.cockpitHeaderAction}
              icon={<MessageSquarePlus size={14} />}
              onClick={onNewChat}
            >
              {t('projects.workspace.newChat')}
            </Button>
          </div>
          {recent.length === 0 ? (
            <button
              type='button'
              className={`w-full cursor-pointer border-none text-left ${styles.card} px-14px py-13px`}
              onClick={onNewChat}
            >
              <div className='text-13px font-600 text-t-primary'>{t('projects.cockpit.emptyRecentTitle', 'Start the first project chat')}</div>
              <div className='mt-2px text-12px text-t-secondary'>
                {t('projects.cockpit.emptyRecentBody', 'Project chats inherit this workspace, memory, and references.')}
              </div>
            </button>
          ) : (
            <div className='flex flex-col gap-8px'>
              {recent.map((c) => (
                <button
                  key={c.id}
                  type='button'
                  className={`flex cursor-pointer items-center gap-12px border-none text-left ${styles.card} px-14px py-12px`}
                  onClick={() => navigate(`/conversation/${c.id}`)}
                >
                  <MessageSquare size={16} className='shrink-0 text-t-secondary' />
                  <span className='min-w-0 flex-1'>
                    <span className='block truncate text-13px font-600 text-t-primary'>{c.name || t('projects.workspace.untitledChat')}</span>
                    <span className='block text-11px text-t-tertiary'>{relTime(c.modifyTime ?? c.createTime)}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className={`p-16px ${styles.surface}`}>
          <h2 className='m-0 text-15px font-700 text-t-primary'>{t('projects.cockpit.readinessTitle', 'Project readiness')}</h2>
          <p className='m-0 mt-2px text-12px text-t-secondary'>
            {t('projects.cockpit.readinessBody', 'The cockpit calls out the setup gaps that make project agents less useful.')}
          </p>
          <div className='mt-10px divide-y divide-[var(--color-border-2)]'>
            <ChecklistItem
              ok={!!project.workspace}
              label={t('projects.cockpit.checkWorkspace', 'Workspace folder is connected')}
              action={!project.workspace ? <Button size='mini' onClick={() => onOpenSettings('general')}>{t('projects.knowledge.setWorkspace')}</Button> : null}
            />
            <ChecklistItem
              ok={setupReady}
              label={t('projects.cockpit.checkInstructions', 'Project instructions are written')}
              action={!setupReady ? <Button size='mini' onClick={() => onOpenSettings('context')}>{t('projects.workspace.setupTodo')}</Button> : null}
            />
            <ChecklistItem
              ok={referenceCount > 0}
              label={t('projects.cockpit.checkReference', 'Reference files are attached')}
              action={referenceCount === 0 ? <Button size='mini' onClick={() => onSelectTab('reference')}>{t('projects.workspace.tabReference')}</Button> : null}
            />
            <ChecklistItem
              ok={canGenerate}
              label={t('projects.cockpit.checkModel', 'A project summary model is available')}
              action={!canGenerate ? <Button size='mini' onClick={() => Message.info(t('projects.cockpit.modelHint', 'Configure an AI provider before generating memory.'))}>{t('projects.workspace.settings')}</Button> : null}
            />
          </div>
        </section>
      </div>

      <section className={`p-16px ${styles.surface}`}>
        <div className='mb-12px flex flex-wrap items-center justify-between gap-10px'>
          <div>
            <h2 className='m-0 text-15px font-700 text-t-primary'>{t('projects.cockpit.nextTitle', 'Next actions')}</h2>
            <p className='m-0 mt-2px text-12px text-t-secondary'>
              {t('projects.cockpit.nextBody', 'The fastest paths back into this project.')}
            </p>
          </div>
        </div>
        <div className={`grid gap-10px md:grid-cols-6 ${styles.cockpitActions}`}>
          <Button icon={<MessageSquarePlus size={14} />} onClick={onNewChat}>{t('projects.workspace.newChat')}</Button>
          <Button icon={<Paperclip size={14} />} onClick={() => onSelectTab('reference')}>{t('projects.workspace.tabReference')}</Button>
          <Button icon={<NotebookPen size={14} />} onClick={() => onSelectTab('memory')}>{t('projects.workspace.tabMemory')}</Button>
          <Button icon={<History size={14} />} onClick={() => onSelectTab('history')}>{t('projects.workspace.tabHistory', 'History')}</Button>
          <Button icon={<CalendarClock size={14} />} onClick={() => navigate(`/scheduled?projectId=${encodeURIComponent(project.id)}&projectName=${encodeURIComponent(project.name)}&prompt=${reportPrompt}`)}>
            {t('projects.cockpit.scheduleReport', 'Schedule report')}
          </Button>
          <Button icon={<Settings size={14} />} onClick={() => onOpenSettings('general')}>{t('projects.workspace.settings')}</Button>
        </div>
        {project.workspace && (
          <div className='mt-12px flex items-center gap-8px text-12px text-t-tertiary'>
            <FolderOpen size={14} />
            <span className='truncate'>{project.workspace}</span>
          </div>
        )}
      </section>
    </div>
  );
};

export default ProjectCockpitPanel;

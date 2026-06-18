/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IProject } from '@/common/types/project';
import { Button, Message, Switch } from '@arco-design/web-react';
import { CalendarClock, Clock, FileText, Plus, TriangleAlert } from 'lucide-react';
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { formatNextRun, formatSchedule } from '@/renderer/pages/cron/cronUtils';
import { useAllCronJobs } from '@/renderer/pages/cron/useCronJobs';
import styles from './projectCards.module.css';

type Props = {
  project: IProject;
};

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

function buildReportPrompt(project: IProject): string {
  return [
    `Create a project report for ${project.name}.`,
    project.description ? `Project description: ${project.description}` : '',
    project.workspace ? `Workspace: ${project.workspace}` : '',
    `Project id: ${project.id}`,
    '',
    'Include:',
    '- New or changed project chats',
    '- Important decisions and memory updates',
    '- Reference files or workspace changes that matter',
    '- Open questions, risks, blockers, and next actions',
    '- A short executive summary suitable for forwarding',
  ]
    .filter(Boolean)
    .join('\n');
}

const ProjectReportsPanel: React.FC<Props> = ({ project }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { jobs, loading, pauseJob, resumeJob } = useAllCronJobs();

  const projectJobs = useMemo(() => jobs.filter((job) => jobMatchesProject(job, project)), [jobs, project]);
  const activeCount = projectJobs.filter((job) => job.enabled).length;
  const failedCount = projectJobs.filter((job) => job.state.lastStatus === 'error').length;

  const openCreateReport = () => {
    const params = new URLSearchParams({
      projectId: project.id,
      projectName: project.name,
      name: `${project.name} weekly report`,
      description: `Recurring status report for ${project.name}.`,
      prompt: buildReportPrompt(project),
    });
    navigate(`/scheduled?${params.toString()}`);
  };

  const toggleJob = async (jobId: string, enabled: boolean) => {
    try {
      if (enabled) {
        await pauseJob(jobId);
        Message.success(t('cron.pauseSuccess'));
      } else {
        await resumeJob(jobId);
        Message.success(t('cron.resumeSuccess'));
      }
    } catch (err) {
      Message.error(String(err));
    }
  };

  return (
    <div className='mx-auto flex max-w-980px flex-col gap-14px'>
      <section className={`p-16px ${styles.surface}`}>
        <div className='flex flex-wrap items-center justify-between gap-12px'>
          <div>
            <h2 className='m-0 text-15px font-700 text-t-primary'>
              {t('projects.reports.title', 'Project reports')}
            </h2>
            <p className='m-0 mt-2px text-12px text-t-secondary'>
              {t(
                'projects.reports.body',
                'Recurring project reports are normal scheduled tasks with project context baked into the prompt.',
              )}
            </p>
          </div>
          <Button type='primary' icon={<Plus size={14} />} onClick={openCreateReport}>
            {t('projects.reports.new', 'New report')}
          </Button>
        </div>
        <div className='mt-14px grid gap-10px md:grid-cols-3'>
          <div className={`px-14px py-12px ${styles.surface}`}>
            <div className='text-20px font-700 text-t-primary'>{projectJobs.length}</div>
            <div className='text-12px text-t-secondary'>{t('projects.reports.metricTotal', 'Report schedules')}</div>
          </div>
          <div className={`px-14px py-12px ${styles.surface}`}>
            <div className='text-20px font-700 text-success-6'>{activeCount}</div>
            <div className='text-12px text-t-secondary'>{t('projects.reports.metricActive', 'Active')}</div>
          </div>
          <div className={`px-14px py-12px ${styles.surface}`}>
            <div className='text-20px font-700 text-warning-6'>{failedCount}</div>
            <div className='text-12px text-t-secondary'>{t('projects.reports.metricFailed', 'Last run failed')}</div>
          </div>
        </div>
      </section>

      {loading ? (
        <div className={`p-18px text-13px text-t-secondary ${styles.surface}`}>{t('common.loading', 'Loading...')}</div>
      ) : projectJobs.length === 0 ? (
        <button type='button' className={`cursor-pointer border-none p-18px text-left ${styles.card}`} onClick={openCreateReport}>
          <div className='flex items-center gap-10px text-14px font-700 text-t-primary'>
            <CalendarClock size={17} />
            {t('projects.reports.emptyTitle', 'No project reports yet')}
          </div>
          <div className='mt-6px text-12px leading-18px text-t-secondary'>
            {t('projects.reports.emptyBody', 'Create a weekly or daily report that checks the project and writes a fresh summary.')}
          </div>
        </button>
      ) : (
        <div className='flex flex-col gap-8px'>
          {projectJobs.map((job) => {
            const schedule = formatSchedule(job, t);
            return (
              <div key={job.id} className={`flex items-center gap-12px px-14px py-13px ${styles.card}`}>
                {job.state.lastStatus === 'error' ? (
                  <TriangleAlert size={17} className='shrink-0 text-warning-6' />
                ) : (
                  <FileText size={17} className='shrink-0 text-t-secondary' />
                )}
                <button
                  type='button'
                  className='min-w-0 flex-1 cursor-pointer border-none bg-transparent p-0 text-left'
                  onClick={() => navigate(`/scheduled/${job.id}`)}
                >
                  <span className='block truncate text-14px font-600 text-t-primary'>{job.name}</span>
                  <span className='mt-2px flex flex-wrap items-center gap-x-10px gap-y-2px text-11px text-t-tertiary'>
                    <span>{schedule}</span>
                    {job.state.nextRunAtMs && (
                      <span className='inline-flex items-center gap-4px'>
                        <Clock size={11} /> {formatNextRun(job.state.nextRunAtMs)}
                      </span>
                    )}
                  </span>
                </button>
                <Switch size='small' checked={job.enabled} onChange={() => void toggleJob(job.id, job.enabled)} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default ProjectReportsPanel;

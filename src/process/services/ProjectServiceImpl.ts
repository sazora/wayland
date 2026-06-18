/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IProjectService } from './IProjectService';
import type { IProjectRepository } from '@process/services/database/IProjectRepository';
import type { IConversationService } from './IConversationService';
import type { IProject, ICreateProjectParams, IUpdateProjectParams } from '@/common/types/project';
import type { TChatConversation } from '@/common/config/storage';
import { uuid } from '@/common/utils';
import { bootstrapProjectKnowledge } from '@process/services/projectKnowledge/bootstrap';

const EMAIL_ALIAS_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?$/;

export function normalizeProjectEmailAlias(value: string | undefined): string | undefined {
  const normalized = (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/@.*$/, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/[-_.]{2,}/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
    .slice(0, 63);
  return normalized || undefined;
}

function normalizeSenderList(value: string[] | undefined): string[] {
  return Array.from(
    new Set(
      (value ?? [])
        .map((sender) => sender.trim().toLowerCase())
        .filter((sender) => sender.includes('@'))
    )
  );
}

async function uniqueProjectEmailAlias(repo: IProjectRepository, requested: string, projectId?: string): Promise<string> {
  const base = normalizeProjectEmailAlias(requested) || 'project';
  let candidate = base;
  let suffix = 2;
  const projects = await repo.listProjects();
  const taken = new Set(
    projects
      .filter((project) => project.id !== projectId)
      .map((project) => project.emailAlias)
      .filter((alias): alias is string => !!alias)
  );
  while (taken.has(candidate)) {
    const suffixText = `-${suffix}`;
    candidate = `${base.slice(0, 63 - suffixText.length)}${suffixText}`;
    suffix += 1;
  }
  return candidate;
}

async function prepareEmailIntakeUpdates(
  repo: IProjectRepository,
  updates: IUpdateProjectParams,
  projectId?: string
): Promise<IUpdateProjectParams> {
  const next = { ...updates };
  if ('emailAlias' in next) {
    const alias = normalizeProjectEmailAlias(next.emailAlias);
    if (alias && !EMAIL_ALIAS_PATTERN.test(alias)) {
      throw new Error('Email alias must start and end with a letter or number and use letters, numbers, dots, dashes, or underscores.');
    }
    next.emailAlias = alias;
    if (alias) {
      const projects = await repo.listProjects();
      const collision = projects.find((project) => project.id !== projectId && project.emailAlias === alias);
      if (collision) throw new Error(`Email alias "${alias}" is already used by another project`);
    }
  }
  if ('emailAllowedSenders' in next) {
    next.emailAllowedSenders = normalizeSenderList(next.emailAllowedSenders);
  }
  if (!next.emailIngestBehavior) {
    delete next.emailIngestBehavior;
  }
  return next;
}

/**
 * Concrete IProjectService. Owns id/timestamp generation and the `.wayland/`
 * knowledge bootstrap; delegates persistence to an injected repository and
 * conversation re-parenting to the conversation service (so assign/remove ride
 * the same `extra` merge path everything else uses).
 */
export class ProjectServiceImpl implements IProjectService {
  constructor(
    private readonly repo: IProjectRepository,
    private readonly conversations: IConversationService
  ) {}

  async createProject(params: ICreateProjectParams): Promise<IProject> {
    const now = Date.now();
    const emailAlias = await uniqueProjectEmailAlias(this.repo, params.emailAlias || params.name);
    const project: IProject = {
      id: uuid(),
      name: params.name.trim() || 'Untitled project',
      description: params.description,
      workspace: params.workspace,
      emailAlias,
      emailIntakeEnabled: params.emailIntakeEnabled ?? false,
      emailAllowedSenders: normalizeSenderList(params.emailAllowedSenders),
      emailIngestBehavior: params.emailIngestBehavior ?? 'save',
      icon: params.icon,
      iconColor: params.iconColor,
      pinned: false,
      createTime: now,
      modifyTime: now,
    };
    const created = await this.repo.createProject(project);
    // Bootstrap the per-project knowledge folder when a workspace is set. Best-
    // effort: a filesystem hiccup must not fail project creation.
    if (created.workspace) {
      try {
        await bootstrapProjectKnowledge(created.workspace, created.name, created.description);
      } catch (err) {
        console.error('[ProjectService] Failed to bootstrap .wayland/ knowledge:', err);
      }
    }
    return created;
  }

  getProject(id: string): Promise<IProject | null> {
    return this.repo.getProject(id);
  }

  listProjects(): Promise<IProject[]> {
    return this.repo.listProjects();
  }

  async updateProject(id: string, updates: IUpdateProjectParams): Promise<void> {
    await this.repo.updateProject(id, await prepareEmailIntakeUpdates(this.repo, updates, id));
    // If a workspace was just set on a project that didn't have one, bootstrap
    // its knowledge folder now.
    if (updates.workspace) {
      try {
        const project = await this.repo.getProject(id);
        if (project) await bootstrapProjectKnowledge(updates.workspace, project.name, project.description);
      } catch (err) {
        console.error('[ProjectService] Failed to bootstrap .wayland/ on workspace update:', err);
      }
    }
  }

  removeProject(id: string): Promise<void> {
    return this.repo.removeProject(id);
  }

  getProjectConversations(projectId: string): Promise<TChatConversation[]> {
    return this.repo.getProjectConversations(projectId);
  }

  async assignConversation(conversationId: string, projectId: string): Promise<void> {
    await this.conversations.updateConversation(
      conversationId,
      { extra: { projectId } } as Partial<TChatConversation>,
      true
    );
  }

  async removeConversationFromProject(conversationId: string): Promise<void> {
    // Setting projectId to undefined drops the key on JSON serialization, so the
    // conversation is detached without losing any other extra fields.
    await this.conversations.updateConversation(
      conversationId,
      { extra: { projectId: undefined } } as Partial<TChatConversation>,
      true
    );
  }
}

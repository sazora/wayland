/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs/promises';
import path from 'path';
import type { IProject } from '@/common/types/project';
import type { IProjectService } from '@process/services/IProjectService';
import type { ReferenceFile } from '@process/services/projectKnowledge/knowledge';
import {
  readProjectKnowledge,
  writeProjectKnowledge,
  writeProjectReferenceFile,
} from '@process/services/projectKnowledge/knowledge';
import { WAYLAND_KNOWLEDGE_DIR } from '@process/services/projectKnowledge/bootstrap';

export type ProjectEmailAttachment = {
  filename: string;
  contentType?: string;
  contentBase64: string;
};

export type ProjectEmailIntakeRequest = {
  to?: string | string[];
  recipients?: string[];
  from?: string;
  subject?: string;
  text?: string;
  html?: string;
  rawEmailBase64?: string;
  attachments?: ProjectEmailAttachment[];
  receivedAt?: number;
};

export type ProjectEmailIngestRecord = {
  id: string;
  projectId: string;
  alias: string;
  from: string;
  subject: string;
  receivedAt: number;
  behavior?: ProjectEmailIngestBehavior;
  status: 'saved' | 'rejected' | 'failed';
  reason?: string;
  referenceFiles: string[];
  generatedFiles?: string[];
  actions?: string[];
  knowledgeUpdated?: boolean;
  attachmentCount: number;
  remoteAttachmentLinks?: ProjectEmailRemoteAttachmentLink[];
};

export type ProjectEmailIngestResult =
  | { ok: true; projectId: string; alias: string; record: ProjectEmailIngestRecord }
  | { ok: false; status: number; error: string };

export type ProjectEmailRemoteAttachmentLink = {
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

const DEFAULT_DOMAIN = 'wl.cksz.us';
const MAX_ATTACHMENTS = 20;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_REMOTE_ATTACHMENT_BYTES = 75 * 1024 * 1024;
const HISTORY_FILE = 'email-ingest/history.json';
export type ProjectEmailIngestBehavior = NonNullable<IProject['emailIngestBehavior']>;

const KNOWLEDGE_BEHAVIORS = new Set<ProjectEmailIngestBehavior>([
  'save-add-to-knowledge',
  'act-add-knowledge-and-references',
]);
const ACTION_BEHAVIORS = new Set<ProjectEmailIngestBehavior>([
  'act-on-instructions',
  'act-add-knowledge-and-references',
]);

function normalizeAddress(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function extractEmailAddress(value: string | undefined): string {
  const raw = normalizeAddress(value);
  const match = raw.match(/<([^>]+)>/);
  return match?.[1]?.trim().toLowerCase() || raw;
}

function sanitizeFileSegment(value: string): string {
  const cleaned = value
    .trim()
    .replace(/<[^>]+>/g, '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .split('')
    .filter((char) => char.charCodeAt(0) >= 32)
    .join('')
    .replace(/\s+/g, '-')
    .replace(/_+/g, '_')
    .slice(0, 80);
  return cleaned || 'email';
}

function sanitizeAttachmentFileName(value: string | undefined, fallback = 'remote-attachment'): string {
  const cleaned = (value ?? '')
    .trim()
    .replace(/<[^>]+>/g, '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .split('')
    .filter((char) => char.charCodeAt(0) >= 32)
    .join('')
    .replace(/\s+/g, ' ')
    .slice(0, 120);
  return cleaned || fallback;
}

function allRecipients(message: ProjectEmailIntakeRequest): string[] {
  const values = [
    ...(Array.isArray(message.to) ? message.to : message.to ? [message.to] : []),
    ...(message.recipients ?? []),
  ];
  return values.map(extractEmailAddress).filter(Boolean);
}

function resolveAlias(message: ProjectEmailIntakeRequest, domain = DEFAULT_DOMAIN): string | null {
  const suffix = `@${domain.toLowerCase()}`;
  for (const recipient of allRecipients(message)) {
    if (!recipient.endsWith(suffix)) continue;
    const alias = recipient.slice(0, -suffix.length).trim().toLowerCase();
    if (alias) return alias;
  }
  return null;
}

function comparableAlias(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/[-_]+/g, '-');
}

function decodeHtmlAttribute(value: string | undefined): string {
  return (value ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function stripHtml(value: string | undefined): string {
  return decodeHtmlAttribute(
    (value ?? '')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
  );
}

function htmlAttribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return decodeHtmlAttribute(match?.[2] ?? match?.[3] ?? match?.[4]);
}

function isMailDropUrl(value: string | undefined): boolean {
  const url = value?.toLowerCase() ?? '';
  return url.includes('icloud.com/attachment') || url.includes('icloud-content.com');
}

function remoteAttachmentAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      (parsed.hostname === 'www.icloud.com' ||
        parsed.hostname.endsWith('.icloud.com') ||
        parsed.hostname === 'cvws.icloud-content.com' ||
        parsed.hostname.endsWith('.icloud-content.com'))
    );
  } catch {
    return false;
  }
}

function dedupeRemoteAttachmentLinks(
  links: ProjectEmailRemoteAttachmentLink[]
): ProjectEmailRemoteAttachmentLink[] {
  const byUrl = new Map<string, ProjectEmailRemoteAttachmentLink>();
  for (const link of links) {
    if (!link.url) continue;
    const existing = byUrl.get(link.url);
    byUrl.set(link.url, {
      url: link.url,
      label: existing?.label || link.label,
      filename: existing?.filename || link.filename,
      size: existing?.size || link.size,
    });
  }
  return [...byUrl.values()];
}

function extractRemoteAttachmentLinks(message: ProjectEmailIntakeRequest): ProjectEmailRemoteAttachmentLink[] {
  const html = message.html ?? '';
  if (!html) return [];

  const links: ProjectEmailRemoteAttachmentLink[] = [];
  const mailDropBlockPattern = /<[^>]*\b(?:class|data-url)\s*=\s*["'][^"']*(?:maildrop|icloud-content)[^"']*["'][^>]*>/gi;
  for (const match of html.matchAll(mailDropBlockPattern)) {
    const tag = match[0];
    const url = htmlAttribute(tag, 'data-url');
    if (!isMailDropUrl(url)) continue;
    links.push({
      url: url!,
      label: 'Mail Drop attachment',
      filename: htmlAttribute(tag, 'data-filename'),
      size: htmlAttribute(tag, 'data-size'),
    });
  }

  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorPattern)) {
    const tag = match[1] ?? '';
    const href = htmlAttribute(tag, 'href');
    if (!isMailDropUrl(href)) continue;
    links.push({
      url: href!,
      label: stripHtml(match[2]) || 'Mail Drop attachment',
    });
  }

  return dedupeRemoteAttachmentLinks(links);
}

function remoteAttachmentLinksMarkdown(links: ProjectEmailRemoteAttachmentLink[]): string {
  if (links.length === 0) return '';
  return [
    '## Remote attachment links',
    ...links.map((link) => {
      const detail = [link.filename, link.size].filter(Boolean).join(' - ');
      const label = detail || link.label || 'Remote attachment';
      return `- ${label}: <${link.url}>`;
    }),
  ].join('\n');
}

function markdownForEmail(message: ProjectEmailIntakeRequest, project: IProject, referenceFiles: string[]): string {
  const receivedAt = new Date(message.receivedAt || Date.now()).toISOString();
  const subject = message.subject?.trim() || '(no subject)';
  const from = extractEmailAddress(message.from) || '(unknown sender)';
  const body = message.text?.trim() || message.html?.trim() || '(no body text)';
  const files = referenceFiles.length > 0 ? referenceFiles.map((file) => `- ${file}`).join('\n') : '- none';
  const remoteLinks = remoteAttachmentLinksMarkdown(extractRemoteAttachmentLinks(message));
  return [
    `# Email intake: ${subject}`,
    '',
    `- Project: ${project.name}`,
    `- From: ${from}`,
    `- To alias: ${project.emailAlias}@${DEFAULT_DOMAIN}`,
    `- Received: ${receivedAt}`,
    `- Attachments saved: ${message.attachments?.length ?? 0}`,
    '',
    '## Saved reference files',
    files,
    '',
    '## Body',
    body,
    remoteLinks ? ['', remoteLinks].join('\n') : '',
  ].join('\n');
}

function bodyFromEmail(message: ProjectEmailIntakeRequest): string {
  const body = message.text?.trim() || message.html?.trim() || '(no body text)';
  const remoteLinks = remoteAttachmentLinksMarkdown(extractRemoteAttachmentLinks(message));
  return remoteLinks ? `${body}\n\n${remoteLinks}` : body;
}

function metadataLines(
  message: ProjectEmailIntakeRequest,
  project: IProject,
  referenceFiles: string[],
  behavior: ProjectEmailIngestBehavior
): string[] {
  const receivedAt = new Date(message.receivedAt || Date.now()).toISOString();
  const subject = message.subject?.trim() || '(no subject)';
  const from = extractEmailAddress(message.from) || '(unknown sender)';
  const files = referenceFiles.length > 0 ? referenceFiles.map((file) => `- ${file}`) : ['- none'];
  return [
    `- Project: ${project.name}`,
    `- From: ${from}`,
    `- To alias: ${project.emailAlias}@${DEFAULT_DOMAIN}`,
    `- Received: ${receivedAt}`,
    `- Behavior: ${behavior}`,
    `- Subject: ${subject}`,
    '',
    '## Saved reference files',
    ...files,
  ];
}

function markdownForSummary(
  message: ProjectEmailIntakeRequest,
  project: IProject,
  referenceFiles: string[],
  behavior: ProjectEmailIngestBehavior
): string {
  const subject = message.subject?.trim() || '(no subject)';
  const body = bodyFromEmail(message);
  const excerpt = body.length > 2_000 ? `${body.slice(0, 2_000)}\n\n[truncated]` : body;
  return [
    `# Email summary: ${subject}`,
    '',
    ...metadataLines(message, project, referenceFiles, behavior),
    '',
    '## Summary',
    excerpt,
    '',
    '## Intake result',
    'Saved as project reference material for future project agents.',
  ].join('\n');
}

function markdownForActionRequest(
  message: ProjectEmailIntakeRequest,
  project: IProject,
  referenceFiles: string[],
  behavior: ProjectEmailIngestBehavior
): string {
  const subject = message.subject?.trim() || '(no subject)';
  return [
    `# Email action request: ${subject}`,
    '',
    ...metadataLines(message, project, referenceFiles, behavior),
    '',
    '## Instructions from forwarded email',
    bodyFromEmail(message),
    '',
    '## Guardrails',
    '- Treat this as a queued project instruction for the project agent.',
    '- Do not perform external, destructive, or irreversible actions without explicit approval.',
    '- Keep saved references attached to the project context when acting on this request.',
  ].join('\n');
}

function knowledgeEntryForEmail(
  message: ProjectEmailIntakeRequest,
  project: IProject,
  referenceFiles: string[],
  behavior: ProjectEmailIngestBehavior
): string {
  const subject = message.subject?.trim() || '(no subject)';
  return [
    `## Email intake: ${subject}`,
    '',
    ...metadataLines(message, project, referenceFiles, behavior),
    '',
    '## Project knowledge from email',
    bodyFromEmail(message),
  ].join('\n');
}

async function appendEmailKnowledge(
  workspace: string,
  message: ProjectEmailIntakeRequest,
  project: IProject,
  referenceFiles: string[],
  behavior: ProjectEmailIngestBehavior
): Promise<void> {
  const knowledge = await readProjectKnowledge(workspace);
  const entry = knowledgeEntryForEmail(message, project, referenceFiles, behavior);
  const next = knowledge.decisions.trim() ? `${knowledge.decisions.trim()}\n\n${entry}\n` : `${entry}\n`;
  await writeProjectKnowledge(workspace, 'decisions', next);
}

async function appendHistory(workspace: string, record: ProjectEmailIngestRecord): Promise<void> {
  const file = path.join(workspace, WAYLAND_KNOWLEDGE_DIR, HISTORY_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  let records: ProjectEmailIngestRecord[] = [];
  try {
    records = JSON.parse(await fs.readFile(file, 'utf-8')) as ProjectEmailIngestRecord[];
  } catch {
    records = [];
  }
  records = [record, ...records].slice(0, 100);
  await fs.writeFile(file, JSON.stringify(records, null, 2), 'utf-8');
}

async function writeEmailIngestHistory(workspace: string, records: ProjectEmailIngestRecord[]): Promise<void> {
  const file = path.join(workspace, WAYLAND_KNOWLEDGE_DIR, HISTORY_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(records.slice(0, 100), null, 2), 'utf-8');
}

export async function readProjectEmailIngestHistory(workspace: string): Promise<ProjectEmailIngestRecord[]> {
  const file = path.join(workspace, WAYLAND_KNOWLEDGE_DIR, HISTORY_FILE);
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf-8')) as ProjectEmailIngestRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export type ProjectEmailRemoteAttachmentImportResult =
  | { ok: true; file: string; record: ProjectEmailIngestRecord }
  | { ok: false; status: number; error: string };

export type ProjectEmailRemoteAttachmentStatusResult =
  | { ok: true; record: ProjectEmailIngestRecord }
  | { ok: false; status: number; error: string };

export async function ignoreProjectEmailRemoteAttachment(
  workspace: string,
  ingestId: string,
  url: string
): Promise<ProjectEmailRemoteAttachmentStatusResult> {
  const records = await readProjectEmailIngestHistory(workspace);
  const recordIndex = records.findIndex((record) => record.id === ingestId);
  if (recordIndex < 0) return { ok: false, status: 404, error: 'email-ingest-record-not-found' };

  const record = records[recordIndex];
  const links = record.remoteAttachmentLinks ?? [];
  const linkIndex = links.findIndex((candidate) => candidate.url === url);
  if (linkIndex < 0) return { ok: false, status: 404, error: 'remote-attachment-link-not-found' };

  const nextLinks = links.map((candidate, index) => {
    if (index !== linkIndex) return candidate;
    return {
      url: candidate.url,
      label: candidate.label,
      filename: candidate.filename,
      size: candidate.size,
      status: 'ignored' as const,
      savedReferenceFile: candidate.savedReferenceFile,
      downloadedAt: candidate.downloadedAt,
      bytes: candidate.bytes,
      lastError: undefined,
      ignoredAt: Date.now(),
    };
  });
  const nextRecord: ProjectEmailIngestRecord = { ...record, remoteAttachmentLinks: nextLinks };
  records[recordIndex] = nextRecord;
  await writeEmailIngestHistory(workspace, records);
  return { ok: true, record: nextRecord };
}

export async function importProjectEmailRemoteAttachment(
  workspace: string,
  ingestId: string,
  url: string
): Promise<ProjectEmailRemoteAttachmentImportResult> {
  const records = await readProjectEmailIngestHistory(workspace);
  const recordIndex = records.findIndex((record) => record.id === ingestId);
  if (recordIndex < 0) return { ok: false, status: 404, error: 'email-ingest-record-not-found' };

  const record = records[recordIndex];
  const links = record.remoteAttachmentLinks ?? [];
  const linkIndex = links.findIndex((candidate) => candidate.url === url);
  if (linkIndex < 0) return { ok: false, status: 404, error: 'remote-attachment-link-not-found' };
  if (!remoteAttachmentAllowed(url)) return { ok: false, status: 400, error: 'remote-attachment-host-not-allowed' };

  const link = links[linkIndex];
  const markFailed = async (error: string, status = 500): Promise<ProjectEmailRemoteAttachmentImportResult> => {
    links[linkIndex] = { ...link, status: 'failed', lastError: error };
    records[recordIndex] = { ...record, remoteAttachmentLinks: links };
    await writeEmailIngestHistory(workspace, records);
    return { ok: false, status, error };
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    let response: Response;
    try {
      response = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) return markFailed(`download-failed-${response.status}`, response.status);

    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > MAX_REMOTE_ATTACHMENT_BYTES) return markFailed('remote-attachment-too-large', 413);

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_REMOTE_ATTACHMENT_BYTES) return markFailed('remote-attachment-too-large', 413);

    const contentDisposition = response.headers.get('content-disposition') || '';
    const dispositionName =
      contentDisposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1] || contentDisposition.match(/filename="?([^";]+)"?/i)?.[1];
    const filename = sanitizeAttachmentFileName(
      dispositionName ? decodeURIComponent(dispositionName) : link.filename || link.label
    );
    const saved = await writeProjectReferenceFile(workspace, filename, bytes);
    const nextRemoteAttachmentLinks = links.map((candidate, index) => {
      if (index !== linkIndex) return candidate;
      return {
        url: candidate.url,
        label: candidate.label,
        filename: candidate.filename,
        size: candidate.size,
        status: 'saved' as const,
        savedReferenceFile: saved.name,
        downloadedAt: Date.now(),
        bytes: bytes.byteLength,
        lastError: undefined,
      };
    });

    const nextRecord: ProjectEmailIngestRecord = {
      ...record,
      referenceFiles: record.referenceFiles.includes(saved.name) ? record.referenceFiles : [...record.referenceFiles, saved.name],
      remoteAttachmentLinks: nextRemoteAttachmentLinks,
    };
    records[recordIndex] = nextRecord;
    await writeEmailIngestHistory(workspace, records);
    return { ok: true, file: saved.name, record: nextRecord };
  } catch (error) {
    return markFailed(error instanceof Error ? error.message : String(error));
  }
}

export class ProjectEmailIntakeService {
  constructor(private readonly projectService: IProjectService) {}

  async ingest(message: ProjectEmailIntakeRequest, domain = DEFAULT_DOMAIN): Promise<ProjectEmailIngestResult> {
    const alias = resolveAlias(message, domain);
    if (!alias) return { ok: false, status: 400, error: 'no-project-alias-recipient' };

    const projects = await this.projectService.listProjects();
    const project = projects.find((candidate) => comparableAlias(candidate.emailAlias) === comparableAlias(alias));
    if (!project) return { ok: false, status: 404, error: 'unknown-project-alias' };
    if (!project.emailIntakeEnabled) return { ok: false, status: 403, error: 'project-email-intake-disabled' };
    if (!project.workspace) return { ok: false, status: 409, error: 'project-has-no-workspace' };

    const from = extractEmailAddress(message.from);
    const allowedSenders = project.emailAllowedSenders ?? [];
    if (allowedSenders.length > 0 && !allowedSenders.includes(from)) {
      return { ok: false, status: 403, error: 'sender-not-allowed' };
    }

    const receivedAt = message.receivedAt || Date.now();
    const subject = message.subject?.trim() || '(no subject)';
    const id = `${receivedAt}-${Math.random().toString(36).slice(2, 8)}`;
    const prefix = `email-${receivedAt}-${sanitizeFileSegment(subject)}`;
    const referenceFiles: string[] = [];
    const generatedFiles: string[] = [];
    const actions: string[] = [];
    const workspace = project.workspace;
    const behavior = project.emailIngestBehavior ?? 'save';
    const remoteAttachmentLinks = extractRemoteAttachmentLinks(message);

    try {
      const attachments = (message.attachments ?? []).slice(0, MAX_ATTACHMENTS);
      const savedAttachments = await Promise.all(
        attachments.map(async (attachment) => {
          const buffer = Buffer.from(attachment.contentBase64, 'base64');
          if (buffer.byteLength > MAX_ATTACHMENT_BYTES) return null;
          return writeProjectReferenceFile(workspace, `${prefix}-${attachment.filename}`, buffer);
        })
      );
      referenceFiles.push(
        ...savedAttachments.filter((file): file is ReferenceFile => file !== null).map((file) => file.name)
      );

      const note = await writeProjectReferenceFile(
        workspace,
        `${prefix}.md`,
        markdownForEmail(message, project, referenceFiles)
      );
      referenceFiles.unshift(note.name);

      if (behavior === 'save-and-summarize') {
        const summary = await writeProjectReferenceFile(
          workspace,
          `${prefix}-summary.md`,
          markdownForSummary(message, project, referenceFiles, behavior)
        );
        referenceFiles.push(summary.name);
        generatedFiles.push(summary.name);
        actions.push('summary-reference-created');
      }

      if (ACTION_BEHAVIORS.has(behavior)) {
        const actionRequest = await writeProjectReferenceFile(
          workspace,
          `${prefix}-action-request.md`,
          markdownForActionRequest(message, project, referenceFiles, behavior)
        );
        referenceFiles.push(actionRequest.name);
        generatedFiles.push(actionRequest.name);
        actions.push('project-action-request-created');
      }

      if (KNOWLEDGE_BEHAVIORS.has(behavior)) {
        await appendEmailKnowledge(workspace, message, project, referenceFiles, behavior);
        actions.push('project-knowledge-updated');
      }

      if (behavior === 'save-and-notify') {
        actions.push('notification-requested');
      }

      if (message.rawEmailBase64) {
        const raw = Buffer.from(message.rawEmailBase64, 'base64');
        const rawDir = path.join(workspace, WAYLAND_KNOWLEDGE_DIR, 'email-ingest/raw');
        await fs.mkdir(rawDir, { recursive: true });
        await fs.writeFile(path.join(rawDir, `${prefix}.eml`), raw);
      }

      const record: ProjectEmailIngestRecord = {
        id,
        projectId: project.id,
        alias,
        from,
        subject,
        receivedAt,
        behavior,
        status: 'saved',
        referenceFiles,
        generatedFiles,
        actions,
        knowledgeUpdated: KNOWLEDGE_BEHAVIORS.has(behavior),
        attachmentCount: attachments.length,
        remoteAttachmentLinks,
      };
      await appendHistory(workspace, record);
      return { ok: true, projectId: project.id, alias, record };
    } catch (error) {
      const record: ProjectEmailIngestRecord = {
        id,
        projectId: project.id,
        alias,
        from,
        subject,
        receivedAt,
        behavior,
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
        referenceFiles,
        generatedFiles,
        actions,
        knowledgeUpdated: false,
        attachmentCount: message.attachments?.length ?? 0,
        remoteAttachmentLinks,
      };
      await appendHistory(workspace, record).catch(() => {});
      return { ok: false, status: 500, error: 'email-ingest-failed' };
    }
  }
}

/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { IProject } from '@/common/types/project';
import type { IProjectService } from '@process/services/IProjectService';
import {
  ignoreProjectEmailRemoteAttachment,
  importProjectEmailRemoteAttachment,
  ProjectEmailIntakeService,
  readProjectEmailIngestHistory,
} from '@process/services/projectEmailIntake/ProjectEmailIntakeService';

let ws: string;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), 'wl-email-intake-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(ws, { recursive: true, force: true });
});

function project(overrides: Partial<IProject> = {}): IProject {
  return {
    id: 'project-1',
    name: 'PennDOT Policy',
    description: '',
    iconColor: '#FF6A00',
    workspace: ws,
    pinned: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    emailAlias: 'penndot-policy',
    emailIntakeEnabled: true,
    emailAllowedSenders: [],
    emailIngestBehavior: 'save',
    ...overrides,
  };
}

function service(projects: IProject[]): ProjectEmailIntakeService {
  const projectService: IProjectService = {
    createProject: async () => projects[0],
    getProject: async (id) => projects.find((item) => item.id === id) ?? null,
    listProjects: async () => projects,
    updateProject: async () => {},
    removeProject: async () => {},
    getProjectConversations: async () => [],
    assignConversation: async () => {},
    removeConversationFromProject: async () => {},
  };
  return new ProjectEmailIntakeService(projectService);
}

describe('ProjectEmailIntakeService', () => {
  it('routes a forwarded email by alias and saves body, attachment, raw email, and history', async () => {
    const intake = service([project()]);

    const result = await intake.ingest({
      to: 'PennDOT Policy <penndot-policy@wl.cksz.us>',
      from: 'Seth <seth@example.com>',
      subject: 'Drone policy references',
      text: 'Drone alone is not enough when steel condition is poor.',
      rawEmailBase64: Buffer.from('raw email contents').toString('base64'),
      attachments: [
        {
          filename: 'AASHTO_Guidelines for UAS_2025.pdf',
          contentType: 'application/pdf',
          contentBase64: Buffer.from('pdf bytes').toString('base64'),
        },
      ],
      receivedAt: 1_780_000_000_000,
    });

    expect(result.ok).toBe(true);
    const referenceDir = path.join(ws, '.wayland', 'reference');
    const files = await fs.readdir(referenceDir);
    expect(files.some((file) => file.endsWith('.md'))).toBe(true);
    expect(files.some((file) => file.includes('AASHTO_Guidelines'))).toBe(true);

    const noteName = files.find((file) => file.endsWith('.md'));
    expect(noteName).toBeTruthy();
    const note = await fs.readFile(path.join(referenceDir, noteName!), 'utf-8');
    expect(note).toContain('Email intake: Drone policy references');
    expect(note).toContain('Drone alone is not enough');

    await expect(fs.access(path.join(ws, '.wayland', 'email-ingest/raw'))).resolves.toBeUndefined();
    const history = await readProjectEmailIngestHistory(ws);
    expect(history).toHaveLength(1);
    expect(history[0]).toEqual(
      expect.objectContaining({
        alias: 'penndot-policy',
        from: 'seth@example.com',
        status: 'saved',
        attachmentCount: 1,
      })
    );
  });

  it('rejects unknown aliases without writing project files', async () => {
    const intake = service([project()]);

    const result = await intake.ingest({ to: 'unknown@wl.cksz.us', subject: 'No route' });

    expect(result).toEqual({ ok: false, status: 404, error: 'unknown-project-alias' });
    await expect(fs.access(path.join(ws, '.wayland'))).rejects.toThrow();
  });

  it('matches hyphen and underscore alias variants', async () => {
    const intake = service([project({ emailAlias: 'penndot_drone_policy' })]);

    const result = await intake.ingest({
      to: 'penndot-drone-policy@wl.cksz.us',
      from: 'seth@example.com',
      subject: 'Mail Drop test',
      text: 'Apple Mail Drop recipient alias used hyphens.',
      receivedAt: 1_780_000_000_005,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.alias).toBe('penndot-drone-policy');

    const history = await readProjectEmailIngestHistory(ws);
    expect(history[0]).toEqual(
      expect.objectContaining({
        alias: 'penndot-drone-policy',
        subject: 'Mail Drop test',
        status: 'saved',
      })
    );
  });

  it('preserves Apple Mail Drop links from email HTML', async () => {
    const intake = service([project({ emailIngestBehavior: 'act-add-knowledge-and-references' })]);
    const mailDropUrl =
      'https://www.icloud.com/attachment/?u=https%3A%2F%2Fcvws.icloud-content.com%2FB%2Fabc&f=Bridge%20Deck.pptx&sz=22100000';

    const result = await intake.ingest({
      to: 'penndot-policy@wl.cksz.us',
      from: 'seth@example.com',
      subject: 'Mail Drop file',
      text: 'Download from iCloud Bridge Deck.pptx 22.1 MB',
      html: `
        <div class="x-apple-maildrop" data-url="https://cvws.icloud-content.com/B/abc" data-filename="Bridge Deck.pptx" data-size="22.1 MB">
          <a href="${mailDropUrl}">Download from iCloud</a>
        </div>
      `,
      receivedAt: 1_780_000_000_006,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.remoteAttachmentLinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: 'https://cvws.icloud-content.com/B/abc',
          filename: 'Bridge Deck.pptx',
          size: '22.1 MB',
        }),
        expect.objectContaining({
          url: mailDropUrl,
          label: 'Download from iCloud',
        }),
      ])
    );

    const note = result.record.referenceFiles.find((file) => file.endsWith('.md'));
    expect(note).toBeTruthy();
    const content = await fs.readFile(path.join(ws, '.wayland', 'reference', note!), 'utf-8');
    expect(content).toContain('## Remote attachment links');
    expect(content).toContain('Bridge Deck.pptx - 22.1 MB');
    expect(content).toContain(mailDropUrl);

    const decisions = await fs.readFile(path.join(ws, '.wayland', 'decisions.md'), 'utf-8');
    expect(decisions).toContain('## Remote attachment links');
    expect(decisions).toContain(mailDropUrl);
  });

  it('imports a trusted Mail Drop link into project references', async () => {
    const intake = service([project({ emailIngestBehavior: 'act-add-knowledge-and-references' })]);
    const mailDropUrl = 'https://cvws.icloud-content.com/B/abc/Bridge%20Deck.pptx';

    const result = await intake.ingest({
      to: 'penndot-policy@wl.cksz.us',
      from: 'seth@example.com',
      subject: 'Mail Drop file',
      text: 'Download from iCloud Bridge Deck.pptx 22.1 MB',
      html: `<div class="x-apple-maildrop" data-url="${mailDropUrl}" data-filename="Bridge Deck.pptx" data-size="22.1 MB"></div>`,
      receivedAt: 1_780_000_000_007,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(Buffer.from('presentation bytes'), {
        status: 200,
        headers: {
          'content-length': String(Buffer.byteLength('presentation bytes')),
          'content-disposition': 'attachment; filename="Bridge Deck.pptx"',
        },
      })
    );

    const imported = await importProjectEmailRemoteAttachment(ws, result.record.id, mailDropUrl);

    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.file).toContain('Bridge Deck.pptx');
    await expect(fs.readFile(path.join(ws, '.wayland', 'reference', imported.file), 'utf-8')).resolves.toBe(
      'presentation bytes'
    );

    const history = await readProjectEmailIngestHistory(ws);
    expect(history[0].remoteAttachmentLinks?.[0]).toEqual(
      expect.objectContaining({
        status: 'saved',
        savedReferenceFile: imported.file,
        bytes: Buffer.byteLength('presentation bytes'),
      })
    );
    expect(history[0].referenceFiles).toContain(imported.file);
  });

  it('refuses to import remote attachments not captured by intake', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await fs.mkdir(path.join(ws, '.wayland', 'email-ingest'), { recursive: true });
    await fs.writeFile(
      path.join(ws, '.wayland', 'email-ingest/history.json'),
      JSON.stringify([
        {
          id: 'ingest-1',
          projectId: 'project-1',
          alias: 'penndot-policy',
          from: 'seth@example.com',
          subject: 'No remote links',
          receivedAt: 1,
          status: 'saved',
          referenceFiles: [],
          attachmentCount: 0,
        },
      ]),
      'utf-8'
    );

    const imported = await importProjectEmailRemoteAttachment(ws, 'ingest-1', 'https://example.com/file.pdf');

    expect(imported).toEqual({ ok: false, status: 404, error: 'remote-attachment-link-not-found' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('marks a captured remote attachment as ignored', async () => {
    const intake = service([project({ emailIngestBehavior: 'act-add-knowledge-and-references' })]);
    const mailDropUrl = 'https://cvws.icloud-content.com/B/abc/Ignored%20Deck.pptx';

    const result = await intake.ingest({
      to: 'penndot-policy@wl.cksz.us',
      from: 'seth@example.com',
      subject: 'Ignored Mail Drop file',
      text: 'Ignore this Mail Drop file.',
      html: `<div class="x-apple-maildrop" data-url="${mailDropUrl}" data-filename="Ignored Deck.pptx"></div>`,
      receivedAt: 1_780_000_000_008,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ignored = await ignoreProjectEmailRemoteAttachment(ws, result.record.id, mailDropUrl);

    expect(ignored.ok).toBe(true);
    if (!ignored.ok) return;
    expect(ignored.record.remoteAttachmentLinks?.[0]).toEqual(
      expect.objectContaining({
        status: 'ignored',
        ignoredAt: expect.any(Number),
      })
    );

    const history = await readProjectEmailIngestHistory(ws);
    expect(history[0].remoteAttachmentLinks?.[0].status).toBe('ignored');
  });

  it('honors allowed sender restrictions', async () => {
    const intake = service([project({ emailAllowedSenders: ['allowed@example.com'] })]);

    const result = await intake.ingest({
      to: 'penndot-policy@wl.cksz.us',
      from: 'blocked@example.com',
      subject: 'Nope',
    });

    expect(result).toEqual({ ok: false, status: 403, error: 'sender-not-allowed' });
  });

  it('creates a summary reference for save-and-summarize behavior', async () => {
    const intake = service([project({ emailIngestBehavior: 'save-and-summarize' })]);

    const result = await intake.ingest({
      to: 'penndot-policy@wl.cksz.us',
      from: 'seth@example.com',
      subject: 'Summarize these notes',
      text: 'Make this project easier to understand later.',
      receivedAt: 1_780_000_000_001,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.behavior).toBe('save-and-summarize');
    expect(result.record.generatedFiles).toEqual(expect.arrayContaining([expect.stringContaining('-summary.md')]));
    expect(result.record.actions).toContain('summary-reference-created');

    const summary = result.record.generatedFiles?.find((file) => file.endsWith('-summary.md'));
    expect(summary).toBeTruthy();
    const content = await fs.readFile(path.join(ws, '.wayland', 'reference', summary!), 'utf-8');
    expect(content).toContain('Email summary: Summarize these notes');
    expect(content).toContain('Make this project easier to understand later.');
  });

  it('adds forwarded email content to project knowledge', async () => {
    const intake = service([project({ emailIngestBehavior: 'save-add-to-knowledge' })]);

    const result = await intake.ingest({
      to: 'penndot-policy@wl.cksz.us',
      from: 'seth@example.com',
      subject: 'Knowledge update',
      text: 'Use PennDOT district naming exactly as sent in the client email.',
      receivedAt: 1_780_000_000_002,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.knowledgeUpdated).toBe(true);
    expect(result.record.actions).toContain('project-knowledge-updated');

    const decisions = await fs.readFile(path.join(ws, '.wayland', 'decisions.md'), 'utf-8');
    expect(decisions).toContain('Email intake: Knowledge update');
    expect(decisions).toContain('Use PennDOT district naming exactly as sent in the client email.');
  });

  it('creates an action request reference for act-on-instructions behavior', async () => {
    const intake = service([project({ emailIngestBehavior: 'act-on-instructions' })]);

    const result = await intake.ingest({
      to: 'penndot-policy@wl.cksz.us',
      from: 'seth@example.com',
      subject: 'Please act on this',
      text: 'Draft a response plan and flag missing attachments.',
      receivedAt: 1_780_000_000_003,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.generatedFiles).toEqual(expect.arrayContaining([expect.stringContaining('-action-request.md')]));
    expect(result.record.actions).toContain('project-action-request-created');

    const action = result.record.generatedFiles?.find((file) => file.endsWith('-action-request.md'));
    expect(action).toBeTruthy();
    const content = await fs.readFile(path.join(ws, '.wayland', 'reference', action!), 'utf-8');
    expect(content).toContain('Email action request: Please act on this');
    expect(content).toContain('Draft a response plan and flag missing attachments.');
    expect(content).toContain('Do not perform external, destructive, or irreversible actions without explicit approval.');
  });

  it('creates an action request and updates knowledge for act-add-knowledge-and-references behavior', async () => {
    const intake = service([project({ emailIngestBehavior: 'act-add-knowledge-and-references' })]);

    const result = await intake.ingest({
      to: 'penndot-policy@wl.cksz.us',
      from: 'seth@example.com',
      subject: 'Act and remember',
      text: 'Remember this client prefers short summaries, then prepare the project notes.',
      receivedAt: 1_780_000_000_004,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.referenceFiles.some((file) => file.endsWith('.md'))).toBe(true);
    expect(result.record.generatedFiles).toEqual(expect.arrayContaining([expect.stringContaining('-action-request.md')]));
    expect(result.record.actions).toEqual(
      expect.arrayContaining(['project-action-request-created', 'project-knowledge-updated'])
    );
    expect(result.record.knowledgeUpdated).toBe(true);

    const decisions = await fs.readFile(path.join(ws, '.wayland', 'decisions.md'), 'utf-8');
    expect(decisions).toContain('Email intake: Act and remember');
    expect(decisions).toContain('Remember this client prefers short summaries');
  });
});

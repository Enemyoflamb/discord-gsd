import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createProject,
  findProject,
  formatProjectList,
  getProjectListPath,
  listProjects,
  markProjectUsed,
  removeProject,
  renameProject,
  slugifyProjectName,
} from "../project-registry.js";

describe("slugifyProjectName", () => {
  it("normalizes names into stable ids", () => {
    assert.equal(slugifyProjectName("My Cool App"), "my-cool-app");
    assert.equal(slugifyProjectName("  API_v2  "), "api-v2");
  });
});

describe("project registry", () => {
  it("creates a project directory and records it in projectlist.json", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "discord-gsd-projects-"));
    try {
      const project = createProject(workspaceDir, "My Cool App");
      assert.equal(project.id, "my-cool-app");
      assert.ok(existsSync(project.path));

      const registry = JSON.parse(readFileSync(getProjectListPath(workspaceDir), "utf-8"));
      assert.equal(registry.projects.length, 1);
      assert.equal(registry.projects[0].id, "my-cool-app");
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("lists and finds registered projects", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "discord-gsd-projects-"));
    try {
      const alpha = createProject(workspaceDir, "Alpha");
      const beta = createProject(workspaceDir, "Beta Site");

      const projects = listProjects(workspaceDir);
      assert.deepEqual(projects.map((project) => project.id), [beta.id, alpha.id]);
      assert.equal(findProject(workspaceDir, "beta-site")?.name, "Beta Site");
      assert.equal(findProject(workspaceDir, "beta site")?.id, "beta-site");
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("moves recently used projects to the top", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "discord-gsd-projects-"));
    try {
      const alpha = createProject(workspaceDir, "Alpha");
      const beta = createProject(workspaceDir, "Beta Site");
      await new Promise((resolve) => setTimeout(resolve, 5));
      const touched = markProjectUsed(workspaceDir, alpha.path);

      assert.equal(touched?.id, "alpha");
      const projects = listProjects(workspaceDir);
      assert.deepEqual(projects.map((project) => project.id), [alpha.id, beta.id]);
      assert.ok(projects[0]?.lastUsedAt);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("renames a project without moving its directory", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "discord-gsd-projects-"));
    try {
      const alpha = createProject(workspaceDir, "Alpha");
      const renamed = renameProject(workspaceDir, alpha.id, "Alpha Prime");

      assert.equal(renamed.id, alpha.id);
      assert.equal(renamed.path, alpha.path);
      assert.equal(renamed.name, "Alpha Prime");
      assert.equal(findProject(workspaceDir, "alpha prime")?.id, alpha.id);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("removes a project from the registry without deleting its directory", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "discord-gsd-projects-"));
    try {
      const alpha = createProject(workspaceDir, "Alpha");
      const removed = removeProject(workspaceDir, alpha.id);

      assert.equal(removed.id, alpha.id);
      assert.equal(findProject(workspaceDir, alpha.id), null);
      assert.ok(existsSync(alpha.path));
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("rejects duplicate project names", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "discord-gsd-projects-"));
    try {
      createProject(workspaceDir, "Alpha");
      assert.throws(() => createProject(workspaceDir, "alpha"), /already exists/i);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("formats a human-readable list", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "discord-gsd-projects-"));
    try {
      const alpha = createProject(workspaceDir, "Alpha");
      const text = formatProjectList([alpha]);
      assert.match(text, /Projects — 1/);
      assert.match(text, /`alpha` — Alpha/);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});

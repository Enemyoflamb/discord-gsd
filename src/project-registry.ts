import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export interface ProjectRecord {
  id: string;
  name: string;
  directory: string;
  path: string;
  createdAt: string;
  lastUsedAt?: string;
}

interface StoredProjectRecord {
  id: string;
  name: string;
  directory: string;
  createdAt: string;
  lastUsedAt?: string;
}

interface ProjectListFile {
  version: 1;
  projects: StoredProjectRecord[];
}

const EMPTY_PROJECT_LIST: ProjectListFile = {
  version: 1,
  projects: [],
};

function emptyProjectList(): ProjectListFile {
  return {
    version: 1,
    projects: [],
  };
}

export function getProjectListPath(workspaceDir: string): string {
  return join(resolve(workspaceDir), "projectlist.json");
}

export function slugifyProjectName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function compareProjects(left: ProjectRecord, right: ProjectRecord): number {
  const leftRecency = left.lastUsedAt ?? left.createdAt;
  const rightRecency = right.lastUsedAt ?? right.createdAt;
  const byRecency = rightRecency.localeCompare(leftRecency);
  if (byRecency !== 0) {
    return byRecency;
  }
  return left.id.localeCompare(right.id);
}

function hydrate(workspaceDir: string, project: StoredProjectRecord): ProjectRecord {
  return {
    ...project,
    path: join(resolve(workspaceDir), project.directory),
  };
}

function readProjectList(workspaceDir: string): ProjectListFile {
  const filePath = getProjectListPath(workspaceDir);
  if (!existsSync(filePath)) {
    return emptyProjectList();
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as Partial<ProjectListFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.projects)) {
      return emptyProjectList();
    }

    const projects = parsed.projects.filter((project): project is StoredProjectRecord => (
      typeof project === "object"
      && project !== null
      && typeof project.id === "string"
      && typeof project.name === "string"
      && typeof project.directory === "string"
      && typeof project.createdAt === "string"
      && (project.lastUsedAt === undefined || typeof project.lastUsedAt === "string")
    ));

    return {
      version: 1,
      projects,
    };
  } catch {
    return emptyProjectList();
  }
}

function writeProjectList(workspaceDir: string, data: ProjectListFile): void {
  const filePath = getProjectListPath(workspaceDir);
  mkdirSync(resolve(workspaceDir), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

export function listProjects(workspaceDir: string): ProjectRecord[] {
  const data = readProjectList(workspaceDir);
  return data.projects
    .map((project) => hydrate(workspaceDir, project))
    .sort(compareProjects);
}

function findStoredProjectIndex(data: ProjectListFile, workspaceDir: string, query: string): number {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return -1;
  }

  return data.projects.findIndex((project) => {
    const hydrated = hydrate(workspaceDir, project);
    return (
      project.id.toLowerCase() === normalized
      || project.name.toLowerCase() === normalized
      || basename(hydrated.path).toLowerCase() === normalized
    );
  });
}

export function findProject(workspaceDir: string, query: string): ProjectRecord | null {
  const data = readProjectList(workspaceDir);
  const index = findStoredProjectIndex(data, workspaceDir, query);
  return index >= 0 ? hydrate(workspaceDir, data.projects[index]!) : null;
}

export function renameProject(workspaceDir: string, query: string, newName: string): ProjectRecord {
  const trimmedName = newName.trim();
  if (!trimmedName) {
    throw new Error("Project name cannot be empty.");
  }

  const data = readProjectList(workspaceDir);
  const index = findStoredProjectIndex(data, workspaceDir, query);
  if (index < 0) {
    throw new Error(`Unknown project: ${query}`);
  }

  const current = data.projects[index]!;
  if (current.name.toLowerCase() === trimmedName.toLowerCase()) {
    return hydrate(workspaceDir, current);
  }

  if (data.projects.some((project, projectIndex) => projectIndex !== index && project.name.toLowerCase() === trimmedName.toLowerCase())) {
    throw new Error(`Project already exists: ${trimmedName}`);
  }

  current.name = trimmedName;
  writeProjectList(workspaceDir, data);
  return hydrate(workspaceDir, current);
}

export function removeProject(workspaceDir: string, query: string): ProjectRecord {
  const data = readProjectList(workspaceDir);
  const index = findStoredProjectIndex(data, workspaceDir, query);
  if (index < 0) {
    throw new Error(`Unknown project: ${query}`);
  }

  const [removed] = data.projects.splice(index, 1);
  writeProjectList(workspaceDir, data);
  return hydrate(workspaceDir, removed!);
}

export function createProject(workspaceDir: string, name: string): ProjectRecord {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error("Project name cannot be empty.");
  }

  const id = slugifyProjectName(trimmedName);
  if (!id) {
    throw new Error("Project name must contain at least one letter or number.");
  }

  const data = readProjectList(workspaceDir);
  if (data.projects.some((project) => project.id === id || project.name.toLowerCase() === trimmedName.toLowerCase())) {
    throw new Error(`Project already exists: ${trimmedName}`);
  }

  const projectPath = join(resolve(workspaceDir), id);
  if (existsSync(projectPath)) {
    throw new Error(`Directory already exists for project: ${projectPath}`);
  }

  mkdirSync(projectPath, { recursive: false });

  const createdAt = new Date().toISOString();
  const stored: StoredProjectRecord = {
    id,
    name: trimmedName,
    directory: id,
    createdAt,
  };
  data.projects.push(stored);
  writeProjectList(workspaceDir, data);

  return hydrate(workspaceDir, stored);
}

export function markProjectUsed(workspaceDir: string, projectPath: string): ProjectRecord | null {
  const resolvedPath = resolve(projectPath);
  const data = readProjectList(workspaceDir);
  const project = data.projects.find((entry) => hydrate(workspaceDir, entry).path === resolvedPath);
  if (!project) {
    return null;
  }

  project.lastUsedAt = new Date().toISOString();
  writeProjectList(workspaceDir, data);
  return hydrate(workspaceDir, project);
}

export function formatProjectList(projects: readonly ProjectRecord[]): string {
  if (projects.length === 0) {
    return "No projects registered yet. Use /dg create to add one.";
  }

  return [
    `Projects — ${projects.length}`,
    "",
    ...projects.map((project) => `- \`${project.id}\` — ${project.name} — \`${project.path}\``),
  ].join("\n");
}
